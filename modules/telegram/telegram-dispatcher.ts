/**
 * TelegramDispatcher — the runtime's UpdateHandler (design doc §12.2).
 *
 * Routes incoming updates to commands. Phase-1 scope: /start, /help, /pair,
 * /status, /lang. Other P0/P1 command names (/new, /session, /abort, /retry,
 * /tasks, /run, …) are recognized so the menu is complete, but respond with a
 * clear "feature arriving later" message until the agent-execution + task
 * integration lands (phases 3–4).
 *
 * Heavy work (prompts, streaming, sessions) is intentionally NOT here — that
 * goes through the shared AgentExecutionCoordinator in later phases.
 */

import type { TelegramStore } from "./telegram-store";
import type { RuntimeDeps, UpdateHandler } from "./telegram-runtime";
import type { TelegramSettings, TelegramUser } from "./types";
import { TelegramErrorCode } from "./errors";
import {
  authorize,
  PRE_AUTH_COMMANDS,
  RateLimiter,
} from "./telegram-auth";
import {
  commandList,
  resolveLocale,
  strings,
  type Locale,
} from "./telegram-i18n";
import {
  generatePairingCode,
  hashPairingCode,
  verifyPairingCode,
} from "./telegram-pairing";
import { routeCallbackQuery } from "./telegram-callback-router";
import { ActionService } from "./telegram-actions";
import type { InlineKeyboardRows } from "./telegram-outbox";
import type { TelegramPromptRunner } from "./telegram-prompt-runner";
import type { TaskService, TaskDefinition } from "@/modules/scheduler";
import type { SessionInfo } from "@/lib/types";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

/** Snapshot of an active session's state (subset of get_state output). */
interface SessionStateSnapshot {
  model: { id: string; provider: string } | null;
  thinkingLevel: string;
  messageCount: number;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  contextUsage: { percent: number; tokens: number; contextWindow: number } | null;
}

/** A selectable model option for /model. */
interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface DispatcherDeps {
  store: TelegramStore;
  settings: () => TelegramSettings;
  /** Sends a text reply in the update's chat (optionally HTML + buttons). */
  reply: (
    chatId: number,
    threadId: number | undefined,
    text: string,
    opts?: { parseMode?: "HTML"; inlineKeyboard?: InlineKeyboardRows },
  ) => Promise<void>;
  /** Acknowledges a callback query (clears the spinner). */
  answerCallback: (callbackQueryId: string, text?: string, showAlert?: boolean) => Promise<void>;
  /** Resolves the scheduler TaskService (null when scheduler is down). */
  resolveScheduler: () => TaskService | null;
  /** Lazily resolves the prompt runner (null until the bot/transport is up). */
  getRunner: () => TelegramPromptRunner | null;
  /** Lists known workspaces (recent project roots derived from sessions). */
  listWorkspaces: () => Promise<{ path: string; name: string }[]>;
  /** Lists all sessions across workspaces (cached 30s in lib/session-reader). */
  listAllSessions: () => Promise<SessionInfo[]>;
  /** Reads the live state of an active session, or null if not in memory. */
  getSessionState: (sessionId: string) => Promise<SessionStateSnapshot | null>;
  /** Lists the visible models for a workspace (enabledModels scope applied). */
  listModels: (workspace: string) => Promise<ModelOption[]>;
  /** Applies a model change to an active session; false if not in memory. */
  applyModelToActiveSession: (
    sessionId: string,
    provider: string,
    modelId: string,
  ) => Promise<boolean>;
  /** Resolves the bot username (for /start). */
  botUsername: () => string | null;
}

export function createDispatcher(deps: DispatcherDeps): UpdateHandler {
  const limiter = new RateLimiter();
  return {
    async handleUpdate(ctx: Ctx): Promise<void> {
      const msg = ctx.message ?? ctx.editedMessage;
      const cb = ctx.callbackQuery;
      if (msg && typeof msg.text === "string") {
        await handleMessage(ctx, msg, deps, limiter);
      } else if (cb) {
        await handleCallback(ctx, cb, deps);
      }
      // Non-text messages (photo/voice/document) are deferred to later phases.
    },
    async onReady(runtimeDeps: RuntimeDeps): Promise<void> {
      // Register the command menu for both locales (§14.4). Failures are
      // non-fatal — menus are a nicety, not a precondition for polling.
      const { bot, settings } = runtimeDeps;
      try {
        for (const locale of ["zh-CN", "en"] as Locale[]) {
          await bot.api.setMyCommands(commandList(locale), {
            language_code: locale === "zh-CN" ? "zh" : "en",
          });
        }
        // Default (no language code) = zh-CN.
        await bot.api.setMyCommands(commandList(resolveLocale(settings.defaultLocale)));
      } catch (error) {
        console.warn(
          "[pi-hub:telegram] setMyCommands failed",
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

async function handleMessage(
  ctx: Ctx,
  msg: { text: string; from?: { id: number; language_code?: string }; chat: { id: number; type: string; title?: string } },
  deps: DispatcherDeps,
  limiter: RateLimiter,
): Promise<void> {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const chatType = msg.chat.type as "private" | "group" | "supergroup" | "channel";
  const threadId = (msg as { message_thread_id?: number }).message_thread_id;
  const settings = deps.settings();
  const locale = resolveLocale(
    msg.from?.language_code ??
      (settings.defaultLocale as string),
  );
  const s = strings(locale);

  if (!userId) {
    await deps.reply(chatId, threadId, s.notPaired);
    return;
  }

  const text = msg.text.trim();
  const command = parseCommand(text);

  // Pre-auth commands are always available.
  if (command && PRE_AUTH_COMMANDS.has(command.name)) {
    if (!limiter.checkUser(userId)) {
      await deps.reply(chatId, threadId, s.rateLimited);
      return;
    }
    await handlePreAuthCommand(ctx, command, { userId, chatId, chatType, threadId, locale }, deps);
    return;
  }

  // Everything else requires authorization.
  const auth = authorize({
    store: deps.store,
    userId,
    chatId,
    chatType,
    privateOnly: settings.privateOnly,
  });
  if (!auth.allowed) {
    await deps.reply(chatId, threadId, denyMessage(auth.denyCode, locale, s));
    return;
  }

  if (!limiter.checkUser(userId)) {
    await deps.reply(chatId, threadId, s.rateLimited);
    return;
  }

  if (command) {
    await handleAuthedCommand(ctx, command, { user: auth.user!, chatId, threadId, locale }, deps);
    return;
  }

  // Free text → Prompt path (phase 3).
  if (text) {
    const runner = deps.getRunner();
    if (!runner) {
      await deps.reply(chatId, threadId, s.featureNotReady);
      return;
    }
    // Fire-and-forget: the runner streams the reply and handles busy/error.
    void runner
      .runPrompt({
        chatId,
        threadId: threadId ?? 0,
        userId,
        chatType,
        text,
        locale,
      })
      .then((res) => {
        if (!res.ok && res.error && !res.owner) {
          void deps.reply(chatId, threadId, res.error);
        } else if (!res.ok && res.owner) {
          void deps.reply(chatId, threadId, res.error ?? "当前会话忙。");
        }
      })
      .catch((error) => {
        void deps.reply(chatId, threadId, `执行失败：${error instanceof Error ? error.message : error}`);
      });
    return;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  const spaceIdx = rest.search(/\s/);
  const rawName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
  // Strip bot mention suffix (/cmd@bot).
  const mention = rawName.indexOf("@");
  const name = (mention === -1 ? rawName : rawName.slice(0, mention)).toLowerCase();
  if (!name) return null;
  return { name, args };
}

async function handlePreAuthCommand(
  _ctx: Ctx,
  command: { name: string; args: string },
  meta: { userId: number; chatId: number; chatType: string; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  const settings = deps.settings();
  if (command.name === "start") {
    const uname = deps.botUsername() ?? settings.botUsername ?? "pi_hub_bot";
    await deps.reply(meta.chatId, meta.threadId, s.start(uname));
    return;
  }
  if (command.name === "help") {
    await deps.reply(meta.chatId, meta.threadId, s.help);
    return;
  }
  if (command.name === "pair") {
    await handlePair(command.args, meta, deps);
    return;
  }
}

async function handlePair(
  codeArg: string,
  meta: { userId: number; chatId: number; chatType: string; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  const code = codeArg.replace(/\D/g, "");
  if (!code) {
    await deps.reply(meta.chatId, meta.threadId, s.pairPrompt);
    return;
  }

  // First paired user becomes Owner (§9.2). Look up the candidate code by
  // iterating unused+unexpired codes and verifying (scrypt salt is random,
  // so there is no deterministic index).
  const isOwnerBootstrap = deps.store.userCount() === 0;
  const role = isOwnerBootstrap ? "owner" : "operator";

  const consumed = consumeMatchingCode(deps.store, code, meta.userId);
  if (consumed === "invalid") {
    await deps.reply(meta.chatId, meta.threadId, s.pairInvalid);
    return;
  }
  if (consumed === "expired") {
    await deps.reply(meta.chatId, meta.threadId, s.pairExpired);
    return;
  }
  if (consumed === "used") {
    await deps.reply(meta.chatId, meta.threadId, s.pairAlreadyUsed);
    return;
  }
  // Persist the user.
  deps.store.upsertUser({
    telegramUserId: meta.userId,
    role,
    enabled: true,
  });
  // If this is a private chat, remember it so future private-only checks pass.
  if (meta.chatType === "private") {
    deps.store.upsertChat({ chatId: meta.chatId, chatType: "private", approvedBy: meta.userId });
  }
  await deps.reply(meta.chatId, meta.threadId, s.pairSuccess(role));
}

/**
 * Tries to consume a pairing code matching the plaintext. Because scrypt
 * hashes use a random salt, we scan all unused, unexpired codes and
 * constant-time verify each one, then atomically consume the match.
 */
function consumeMatchingCode(
  store: TelegramStore,
  plaintext: string,
  userId: number,
): "ok" | "invalid" | "expired" | "used" {
  const now = Date.now();
  const candidates = store.listUnusedPairingCodes(now);
  let expiredHit = false;
  for (const c of candidates) {
    if (c.expiresAt < now) {
      expiredHit = true;
      continue;
    }
    if (verifyPairingCode(plaintext, c.codeHash)) {
      const consumed = store.consumePairingCode(c.codeHash, userId, now);
      return consumed ? "ok" : "used";
    }
  }
  return expiredHit ? "expired" : "invalid";
}

async function handleAuthedCommand(
  ctx: Ctx,
  command: { name: string; args: string },
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  switch (command.name) {
    case "status": {
      const status = deps.store.getSettings().enabled ? "running" : "disabled";
      await deps.reply(meta.chatId, meta.threadId, s.statusBot(status));
      return;
    }
    case "lang": {
      const next: Locale = meta.locale === "zh-CN" ? "en" : "zh-CN";
      await deps.reply(
        meta.chatId,
        meta.threadId,
        strings(next).statusBot(next === "zh-CN" ? "中文" : "English"),
      );
      return;
    }
    case "session": {
      await handleSession(meta, deps);
      return;
    }
    case "new": {
      await handleNew(meta, deps);
      return;
    }
    case "workspace": {
      await handleWorkspace(meta, deps);
      return;
    }
    case "sessions": {
      await handleSessions(command.args, meta, deps);
      return;
    }
    case "abort": {
      const runner = deps.getRunner();
      if (!runner) {
        await deps.reply(meta.chatId, meta.threadId, s.featureNotReady);
        return;
      }
      const res = await runner.abort(meta.chatId, meta.threadId ?? 0, meta.user.telegramUserId, meta.user.role === "owner");
      await deps.reply(meta.chatId, meta.threadId, res.ok ? "⏹ 已请求停止。" : res.error ?? "无法停止。");
      return;
    }
    case "retry": {
      const runner = deps.getRunner();
      if (!runner) {
        await deps.reply(meta.chatId, meta.threadId, s.featureNotReady);
        return;
      }
      void runner.retry({
        chatId: meta.chatId,
        threadId: meta.threadId ?? 0,
        userId: meta.user.telegramUserId,
        userDisplayName: meta.user.displayName,
        chatType: "private",
        text: "",
        locale: meta.locale,
      });
      return;
    }
    case "model": {
      await handleModel(command.args, meta, deps);
      return;
    }
    case "context": {
      await handleContext(meta, deps);
      return;
    }
    case "commands": {
      await handleCommands(meta, deps);
      return;
    }
    case "tasks": {
      await handleTasks(meta, deps);
      return;
    }
    case "task": {
      await handleTaskDetail(command.args, meta, deps);
      return;
    }
    case "run": {
      await handleRun(command.args, meta, deps);
      return;
    }
    default: {
      await deps.reply(meta.chatId, meta.threadId, s.help);
    }
  }
}

// ---------------------------------------------------------------------------
// Callbacks — delegated to the callback router (§8.7, §18.6)
// ---------------------------------------------------------------------------

async function handleCallback(
  ctx: Ctx,
  cb: { id: string; data?: string; from?: { id: number; language_code?: string }; message?: { chat: { id: number; type: string }; message_thread_id?: number } },
  deps: DispatcherDeps,
): Promise<void> {
  const userId = cb.from?.id;
  const chatId = cb.message?.chat?.id;
  if (!userId || !chatId) {
    try {
      await deps.answerCallback(cb.id);
    } catch {
      // ignore
    }
    return;
  }
  const settings = deps.settings();
  const locale = resolveLocale(cb.from?.language_code ?? settings.defaultLocale);
  await routeCallbackQuery(
    {
      store: deps.store,
      resolveScheduler: deps.resolveScheduler,
      answerCallback: deps.answerCallback,
      reply: deps.reply,
      getRunner: deps.getRunner,
      isPrivateOnly: () => settings.privateOnly,
      renderSessionsPage: (input) => renderSessionsPage(deps, input),
      renderModelsPage: (input) => renderModelsPage(deps, input),
      applyModelToActiveSession: deps.applyModelToActiveSession,
    },
    {
      callbackQueryId: cb.id,
      userId,
      chatId,
      chatType: (cb.message?.chat?.type ?? "private") as "private" | "group" | "supergroup" | "channel",
      threadId: cb.message?.message_thread_id,
      data: cb.data,
      locale,
    },
  );
}

// ---------------------------------------------------------------------------
// Session commands (§13, §14.1): /session, /new
// ---------------------------------------------------------------------------

async function handleSession(
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  if (!conv || !conv.activeSessionId) {
    await deps.reply(meta.chatId, meta.threadId, "当前没有绑定的 Session。直接发送文本即可创建。", { parseMode: "HTML" });
    return;
  }
  await deps.reply(
    meta.chatId,
    meta.threadId,
    [
      "<b>当前 Session</b>",
      `Session：<code>${esc(conv.activeSessionId.slice(0, 8))}</code>`,
      `工作区：<code>${esc(conv.workspace ?? "—")}</code>`,
      `状态：${conv.state}`,
    ].join("\n"),
    { parseMode: "HTML" },
  );
}

async function handleNew(
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const runner = deps.getRunner();
  if (!runner) {
    await deps.reply(meta.chatId, meta.threadId, "运行时尚未就绪，请稍后再试。");
    return;
  }
  // V1: rebind to a fresh session by clearing the active mapping, then prompt
  // with an empty-ish seed so the runner creates a new session. The runner's
  // workspace resolver uses the conversation's selected workspace (set via
  // /workspace); if none is selected, the prompt will guide the user.
  if (meta.user.role === "viewer") {
    await deps.reply(meta.chatId, meta.threadId, "权限不足：需要 operator 或 owner。");
    return;
  }
  // Drop the existing binding so the next prompt opens a new session.
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  if (conv) {
    deps.store.updateConversation(meta.chatId, meta.threadId ?? 0, {
      activeSessionId: null,
      activeSessionPath: null,
      state: "idle",
    });
  }
  await deps.reply(meta.chatId, meta.threadId, "✅ 已准备新 Session。请发送你的 Prompt。", { parseMode: "HTML" });
}

async function handleWorkspace(
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  if (meta.user.role === "viewer") {
    await deps.reply(meta.chatId, meta.threadId, "权限不足：需要 operator 或 owner。");
    return;
  }
  let workspaces: { path: string; name: string }[];
  try {
    workspaces = await deps.listWorkspaces();
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `读取工作区失败：${errMsg(error)}`);
    return;
  }
  if (workspaces.length === 0) {
    await deps.reply(meta.chatId, meta.threadId, s.workspaceEmpty);
    return;
  }
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  const current = conv?.workspace ?? null;
  const actions = new ActionService(deps.store);
  const rows: InlineKeyboardRows = workspaces.map((ws) => {
    const { callbackData } = actions.create({
      actionType: "workspace_switch",
      payload: { workspace: ws.path, name: ws.name },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId: meta.threadId ?? 0,
    });
    const prefix = current && current === ws.path ? "✅ " : "";
    return [{ text: `${prefix}${ws.name}`, callbackData }];
  });
  const header = [
    `<b>${esc(s.workspaceHeader)}</b>`,
    `当前：<code>${esc(current ?? "—")}</code>`,
  ].join("\n");
  await deps.reply(meta.chatId, meta.threadId, header, {
    parseMode: "HTML",
    inlineKeyboard: rows,
  });
}

// ---------------------------------------------------------------------------
// Session browsing & context (§13.2): /sessions, /context, /model, /commands
// ---------------------------------------------------------------------------

/** Sessions per page in /sessions. Telegram inline keyboards handle ~30 buttons
 *  comfortably; 10 keeps each page readable and avoids huge messages. */
const SESSIONS_PAGE_SIZE = 10;
/** Models per page in /model. Model names can be long, so fewer per page. */
const MODELS_PAGE_SIZE = 8;

interface CommandMeta {
  user: TelegramUser;
  chatId: number;
  threadId: number | undefined;
  locale: Locale;
}

/**
 * Builds the /sessions inline keyboard for a page and returns the header text +
 * rows. Returns null when the workspace has no sessions or no workspace is set.
 *
 * Shared between /sessions and the session_switch "page" callback so both render
 * the same way.
 */
export async function buildSessionsKeyboard(
  deps: DispatcherDeps,
  meta: CommandMeta,
  page: number,
): Promise<{ header: string; rows: InlineKeyboardRows } | null> {
  const s = strings(meta.locale);
  const threadId = meta.threadId ?? 0;
  const conv = deps.store.getConversation(meta.chatId, threadId);
  const workspace = conv?.workspace ?? null;
  if (!workspace) return null;

  let sessions: SessionInfo[];
  try {
    sessions = await deps.listAllSessions();
  } catch {
    return null;
  }
  // Filter to this workspace's project root (same rule as listWorkspaces).
  const wsSessions = sessions
    .filter((x) => (x.projectRoot ?? x.cwd) === workspace)
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));

  if (wsSessions.length === 0) {
    return { header: s.sessionsEmpty, rows: [] };
  }

  const totalPages = Math.max(1, Math.ceil(wsSessions.length / SESSIONS_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * SESSIONS_PAGE_SIZE;
  const slice = wsSessions.slice(start, start + SESSIONS_PAGE_SIZE);

  const actions = new ActionService(deps.store);
  const activeId = conv?.activeSessionId ?? null;
  const rows: { text: string; callbackData: string }[][] = slice.map((sess) => {
    const label = sess.name?.trim() || sess.firstMessage?.slice(0, 24) || s.sessionsUnnamed;
    const { callbackData } = actions.create({
      actionType: "session_switch",
      payload: {
        mode: "switch",
        sessionId: sess.id,
        sessionPath: sess.path,
        name: label,
      },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    const prefix = activeId && activeId === sess.id ? "✅ " : "";
    return [{ text: `${prefix}${label}`, callbackData }];
  });

  // Prev / next row.
  const navRow: { text: string; callbackData: string }[] = [];
  if (safePage > 0) {
    const { callbackData } = actions.create({
      actionType: "session_switch",
      payload: { mode: "page", page: safePage - 1 },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    navRow.push({ text: s.sessionsPrev, callbackData });
  }
  if (safePage < totalPages - 1) {
    const { callbackData } = actions.create({
      actionType: "session_switch",
      payload: { mode: "page", page: safePage + 1 },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    navRow.push({ text: s.sessionsNext, callbackData });
  }
  if (navRow.length > 0) rows.push(navRow);

  const wsName = workspace.split("/").filter(Boolean).pop() ?? workspace;
  const header = [
    `<b>${esc(s.sessionsTitle)}</b>`,
    `${esc(wsName)} · ${s.sessionsPage(safePage + 1, totalPages)}`,
  ].join("\n");
  return { header, rows };
}

async function handleSessions(
  arg: string,
  meta: CommandMeta,
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  if (!conv?.workspace) {
    await deps.reply(meta.chatId, meta.threadId, s.sessionsNoWorkspace);
    return;
  }
  const page = parsePageIndex(arg);
  let keyboard: { header: string; rows: InlineKeyboardRows } | null;
  try {
    keyboard = await buildSessionsKeyboard(deps, meta, page);
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `读取 Session 失败：${errMsg(error)}`);
    return;
  }
  if (!keyboard) {
    await deps.reply(meta.chatId, meta.threadId, s.sessionsNoWorkspace);
    return;
  }
  await deps.reply(meta.chatId, meta.threadId, keyboard.header, {
    parseMode: "HTML",
    inlineKeyboard: keyboard.rows,
  });
}

async function handleContext(
  meta: CommandMeta,
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  const sessionId = conv?.activeSessionId ?? null;
  const sessionPath = conv?.activeSessionPath ?? null;
  if (!sessionId) {
    await deps.reply(meta.chatId, meta.threadId, s.contextNoSession);
    return;
  }

  // Prefer live state for an in-memory session; fall back to the persisted file.
  let live: SessionStateSnapshot | null = null;
  try {
    live = await deps.getSessionState(sessionId);
  } catch {
    live = null;
  }

  // Read the persisted session file for model/thinking/message count. Done in
  // both branches because the live get_state returns a hard-coded messageCount
  // of 0 (the SDK doesn't populate it), so the file is the reliable source for
  // that field.
  let fileCtx: {
    messages: unknown[];
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
  } | null = null;
  if (sessionPath) {
    try {
      const { getSessionEntries, buildSessionContext } = await import("@/lib/session-reader");
      const entries = getSessionEntries(sessionPath);
      fileCtx = buildSessionContext(entries);
    } catch {
      fileCtx = null;
    }
  }

  let modelLabel: string;
  let thinkingLabel: string;
  let messageCount: number | null;
  let usageLine: string | null = null;
  let compactLine: string | null = null;

  if (live) {
    // Live model/thinking is authoritative; fall back to the file for those if
    // the SDK returned nothing. Message count always comes from the file.
    const model = live.model
      ?? (fileCtx?.model
        ? { id: fileCtx.model.modelId, provider: fileCtx.model.provider }
        : null);
    modelLabel = model ? `${esc(model.provider)}/${esc(model.id)}` : s.contextUnknown;
    thinkingLabel = esc(live.thinkingLevel || fileCtx?.thinkingLevel || s.contextUnknown);
    messageCount = fileCtx?.messages.length ?? null;
    if (live.contextUsage) {
      usageLine = s.contextUsage(
        live.contextUsage.percent,
        live.contextUsage.tokens,
        live.contextUsage.contextWindow,
      );
    }
    const compactState = live.isCompacting ? s.contextCompacting : s.contextIdle;
    compactLine = `${compactState} · ${s.contextAutoCompact(live.autoCompactionEnabled)}`;
  } else if (fileCtx) {
    modelLabel = fileCtx.model
      ? `${esc(fileCtx.model.provider)}/${esc(fileCtx.model.modelId)}`
      : s.contextDefault;
    thinkingLabel = esc(fileCtx.thinkingLevel || s.contextDefault);
    messageCount = fileCtx.messages.length;
  } else {
    modelLabel = s.contextUnknown;
    thinkingLabel = s.contextUnknown;
    messageCount = null;
  }

  const lines: string[] = [
    `<b>${esc(s.contextTitle)}</b>`,
    `Session：<code>${esc(sessionId.slice(0, 8))}</code>`,
    `${esc(s.contextModel)}：<code>${modelLabel}</code>`,
    `${esc(s.contextThinking)}：<code>${thinkingLabel}</code>`,
  ];
  if (messageCount !== null) {
    lines.push(`${esc(s.contextMessages)}：${messageCount}`);
  }
  if (usageLine) lines.push(esc(usageLine));
  if (compactLine) lines.push(esc(compactLine));
  await deps.reply(meta.chatId, meta.threadId, lines.join("\n"), { parseMode: "HTML" });
}

/**
 * Builds the /model inline keyboard for a page. Returns null when models can't
 * be resolved for the workspace.
 */
export async function buildModelsKeyboard(
  deps: DispatcherDeps,
  meta: CommandMeta,
  page: number,
): Promise<{ header: string; rows: InlineKeyboardRows } | null> {
  const s = strings(meta.locale);
  const threadId = meta.threadId ?? 0;
  const conv = deps.store.getConversation(meta.chatId, threadId);
  const workspace = conv?.workspace ?? null;
  if (!workspace) return null;

  let models: ModelOption[];
  try {
    models = await deps.listModels(workspace);
  } catch {
    return null;
  }
  if (models.length === 0) {
    return { header: s.modelInvalid, rows: [] };
  }

  const totalPages = Math.max(1, Math.ceil(models.length / MODELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * MODELS_PAGE_SIZE;
  const slice = models.slice(start, start + MODELS_PAGE_SIZE);

  const actions = new ActionService(deps.store);
  const curProvider = conv?.modelProvider ?? null;
  const curModelId = conv?.modelId ?? null;
  const rows: { text: string; callbackData: string }[][] = slice.map((m) => {
    const { callbackData } = actions.create({
      actionType: "model_switch",
      payload: { mode: "switch", provider: m.provider, modelId: m.id, name: m.name || m.id },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    const prefix = curProvider && curModelId && curProvider === m.provider && curModelId === m.id ? "✅ " : "";
    return [{ text: `${prefix}${m.name || m.id}`, callbackData }];
  });

  // Prev / next row.
  const navRow: { text: string; callbackData: string }[] = [];
  if (safePage > 0) {
    const { callbackData } = actions.create({
      actionType: "model_switch",
      payload: { mode: "page", page: safePage - 1 },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    navRow.push({ text: s.pagePrev, callbackData });
  }
  if (safePage < totalPages - 1) {
    const { callbackData } = actions.create({
      actionType: "model_switch",
      payload: { mode: "page", page: safePage + 1 },
      userId: meta.user.telegramUserId,
      chatId: meta.chatId,
      threadId,
    });
    navRow.push({ text: s.pageNext, callbackData });
  }
  if (navRow.length > 0) rows.push(navRow);

  const currentLabel = curProvider && curModelId
    ? `${esc(curProvider)}/${esc(curModelId)}`
    : s.modelDefault;
  const header = [
    `<b>${esc(s.modelTitle)}</b>`,
    `${esc(s.modelCurrent)}：<code>${currentLabel}</code>`,
    s.modelAvailable,
  ].join("\n");
  return { header, rows };
}

async function handleModel(
  arg: string,
  meta: CommandMeta,
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  if (meta.user.role === "viewer") {
    await deps.reply(meta.chatId, meta.threadId, "权限不足：需要 operator 或 owner。");
    return;
  }
  const conv = deps.store.getConversation(meta.chatId, meta.threadId ?? 0);
  if (!conv?.workspace) {
    await deps.reply(meta.chatId, meta.threadId, s.sessionsNoWorkspace);
    return;
  }

  const raw = arg.trim();
  if (raw) {
    // Direct set: /model <provider/modelId> or /model <modelId>.
    await applyModelByArg(deps, meta, conv, raw);
    return;
  }

  // No arg: show the picker.
  const page = 0;
  let keyboard: { header: string; rows: InlineKeyboardRows } | null;
  try {
    keyboard = await buildModelsKeyboard(deps, meta, page);
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `读取模型失败：${errMsg(error)}`);
    return;
  }
  if (!keyboard) {
    await deps.reply(meta.chatId, meta.threadId, s.sessionsNoWorkspace);
    return;
  }
  await deps.reply(meta.chatId, meta.threadId, keyboard.header, {
    parseMode: "HTML",
    inlineKeyboard: keyboard.rows,
  });
}

/** Resolves a `/model <arg>` against the visible model list and persists it. */
async function applyModelByArg(
  deps: DispatcherDeps,
  meta: CommandMeta,
  conv: NonNullable<ReturnType<TelegramStore["getConversation"]>>,
  raw: string,
): Promise<void> {
  const s = strings(meta.locale);
  const workspace = conv.workspace!;
  let models: ModelOption[];
  try {
    models = await deps.listModels(workspace);
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `读取模型失败：${errMsg(error)}`);
    return;
  }
  const needle = raw.toLowerCase();
  const match = models.find((m) => {
    const full = `${m.provider}/${m.id}`.toLowerCase();
    return full === needle || m.id.toLowerCase() === needle;
  });
  if (!match) {
    await deps.reply(meta.chatId, meta.threadId, s.modelInvalid, { parseMode: "HTML" });
    return;
  }
  deps.store.updateConversation(meta.chatId, meta.threadId ?? 0, {
    modelProvider: match.provider,
    modelId: match.id,
  });
  if (conv.activeSessionId) {
    try {
      await deps.applyModelToActiveSession(conv.activeSessionId, match.provider, match.id);
    } catch {
      // Non-fatal: the pin applies on the next open/resume.
    }
  }
  await deps.reply(
    meta.chatId,
    meta.threadId,
    s.modelSwitched(match.name || match.id),
    { parseMode: "HTML" },
  );
}

async function handleCommands(
  meta: CommandMeta,
  deps: DispatcherDeps,
): Promise<void> {
  const s = strings(meta.locale);
  const cmds = commandList(meta.locale);
  // Group commands by category for readability.
  const groups: Record<string, string[]> = {
    [s.commandsGroupBasic]: ["start", "help", "pair", "status", "lang"],
    [s.commandsGroupSession]: ["session", "new", "sessions", "workspace", "context", "model"],
    [s.commandsGroupRun]: ["abort", "retry"],
    [s.commandsGroupTask]: ["tasks", "task", "run", "commands"],
  };
  const byName = new Map(cmds.map((c) => [c.command, c.description]));
  const lines: string[] = [`<b>${esc(s.commandsTitle)}</b>`, ""];
  for (const [groupName, names] of Object.entries(groups)) {
    lines.push(`<b>${esc(groupName)}</b>`);
    for (const name of names) {
      const desc = byName.get(name);
      if (!desc) continue;
      lines.push(`/${esc(name)} — ${esc(desc)}`);
    }
    lines.push("");
  }
  await deps.reply(meta.chatId, meta.threadId, lines.join("\n"), { parseMode: "HTML" });
}

/** Parses a 1-based page number from a command arg ("2" → 1, i.e. 0-based). */
function parsePageIndex(arg: string): number {
  const n = parseInt(arg.trim(), 10);
  if (!Number.isFinite(n) || n <= 1) return 0;
  return n - 1;
}

/**
 * Re-renders a /sessions page as a fresh message. Used by the session_switch
 * "page" callback (prev/next buttons). Exposed so the runtime can wire it into
 * the callback router without duplicating the rendering logic.
 *
 * Known limitation: this posts a new message rather than editing the original
 * inline keyboard in place (the `reply` dep does not expose editMessageText/
 * editMessageReplyMarkup yet). Old messages' buttons are inert — their action
 * tokens are single-use — but they remain visible, so the chat accumulates one
 * list message per page flip. Can be upgraded to in-place edits in a later pass
 * by extending the reply dep with the transport's edit helpers.
 */
export async function renderSessionsPage(
  deps: DispatcherDeps,
  input: {
    chatId: number;
    threadId: number;
    userId: number;
    page: number;
    locale: Locale;
  },
): Promise<void> {
  const meta: CommandMeta = {
    // Role isn't needed for rendering; reuse a minimal stub. Authorization was
    // already checked by the callback router before reaching here.
    user: { telegramUserId: input.userId } as TelegramUser,
    chatId: input.chatId,
    threadId: input.threadId,
    locale: input.locale,
  };
  let keyboard: { header: string; rows: InlineKeyboardRows } | null;
  try {
    keyboard = await buildSessionsKeyboard(deps, meta, input.page);
  } catch (error) {
    await deps.reply(input.chatId, input.threadId, `读取 Session 失败：${errMsg(error)}`);
    return;
  }
  if (!keyboard) {
    await deps.reply(input.chatId, input.threadId, strings(input.locale).sessionsNoWorkspace);
    return;
  }
  await deps.reply(input.chatId, input.threadId, keyboard.header, {
    parseMode: "HTML",
    inlineKeyboard: keyboard.rows,
  });
}

/** Re-renders a /model page as a fresh message (model_switch "page" callback).
 *  See renderSessionsPage for the known in-place-edit limitation. */
export async function renderModelsPage(
  deps: DispatcherDeps,
  input: {
    chatId: number;
    threadId: number;
    userId: number;
    page: number;
    locale: Locale;
  },
): Promise<void> {
  const meta: CommandMeta = {
    user: { telegramUserId: input.userId } as TelegramUser,
    chatId: input.chatId,
    threadId: input.threadId,
    locale: input.locale,
  };
  let keyboard: { header: string; rows: InlineKeyboardRows } | null;
  try {
    keyboard = await buildModelsKeyboard(deps, meta, input.page);
  } catch (error) {
    await deps.reply(input.chatId, input.threadId, `读取模型失败：${errMsg(error)}`);
    return;
  }
  if (!keyboard) {
    await deps.reply(input.chatId, input.threadId, strings(input.locale).sessionsNoWorkspace);
    return;
  }
  await deps.reply(input.chatId, input.threadId, keyboard.header, {
    parseMode: "HTML",
    inlineKeyboard: keyboard.rows,
  });
}

// ---------------------------------------------------------------------------
// Task commands (§18.6): /tasks, /task <id>, /run <id>
// ---------------------------------------------------------------------------

async function handleTasks(
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const service = deps.resolveScheduler();
  if (!service) {
    await deps.reply(meta.chatId, meta.threadId, "调度器未就绪。");
    return;
  }
  let result;
  try {
    result = service.listTasks({ limit: 20 });
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `读取任务失败：${errMsg(error)}`);
    return;
  }
  if (result.items.length === 0) {
    await deps.reply(meta.chatId, meta.threadId, "暂无定时任务。可在 Pi Hub 网页端创建。");
    return;
  }
  const lines: string[] = ["<b>定时任务</b>", ""];
  for (const t of result.items) {
    const next = t.nextRunAt ? fmtLocal(t.nextRunAt) : "—";
    lines.push(
      `• <code>${esc(t.id.slice(0, 8))}</code> ${esc(t.name)} (${statusLabel(t.status)})`,
      `   下次：${next} · <code>/run ${esc(t.id.slice(0, 8))}</code>`,
    );
  }
  lines.push("", "发送 <code>/run &lt;id&gt;</code> 立即执行。发送 <code>/task &lt;id&gt;</code> 查看详情。");
  await deps.reply(meta.chatId, meta.threadId, lines.join("\n"), { parseMode: "HTML" });
}

async function handleTaskDetail(
  arg: string,
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  const id = resolveTaskId(arg, deps);
  if (!id) {
    await deps.reply(meta.chatId, meta.threadId, "用法：<code>/task &lt;id&gt;</code>", { parseMode: "HTML" });
    return;
  }
  const service = deps.resolveScheduler();
  if (!service) {
    await deps.reply(meta.chatId, meta.threadId, "调度器未就绪。");
    return;
  }
  let taskWithRun: TaskDefinition & { lastRun: unknown };
  try {
    taskWithRun = service.getTaskWithLastRun(id) as TaskDefinition & { lastRun: unknown };
  } catch {
    await deps.reply(meta.chatId, meta.threadId, "未找到该任务。");
    return;
  }
  const runs = service.listRuns({ taskId: id, limit: 3 }).items;
  const lines: string[] = [
    `<b>${esc(taskWithRun.name)}</b>`,
    `状态：${statusLabel(taskWithRun.status)}`,
    `工作区：<code>${esc(taskWithRun.cwd)}</code>`,
    taskWithRun.nextRunAt ? `下次执行：${fmtLocal(taskWithRun.nextRunAt)}` : "下次执行：—",
    "",
    "<b>最近执行</b>",
  ];
  if (runs.length === 0) {
    lines.push("暂无执行记录。");
  } else {
    for (const r of runs) {
      lines.push(`• ${runStatusLabel(r.status)} <code>${esc(r.id.slice(0, 8))}</code> ${fmtLocal(r.finishedAt ?? r.startedAt ?? r.queuedAt)}`);
    }
  }
  await deps.reply(meta.chatId, meta.threadId, lines.join("\n"), { parseMode: "HTML" });
}

async function handleRun(
  arg: string,
  meta: { user: TelegramUser; chatId: number; threadId: number | undefined; locale: Locale },
  deps: DispatcherDeps,
): Promise<void> {
  if (meta.user.role === "viewer") {
    await deps.reply(meta.chatId, meta.threadId, "权限不足：需要 operator 或 owner。");
    return;
  }
  const id = resolveTaskId(arg, deps);
  if (!id) {
    await deps.reply(meta.chatId, meta.threadId, "用法：<code>/run &lt;id&gt;</code>", { parseMode: "HTML" });
    return;
  }
  const service = deps.resolveScheduler();
  if (!service) {
    await deps.reply(meta.chatId, meta.threadId, "调度器未就绪。");
    return;
  }
  try {
    const { run, created } = service.triggerRun(id);
    await deps.reply(
      meta.chatId,
      meta.threadId,
      created ? `✅ 已加入队列（run <code>${esc(run.id.slice(0, 8))}</code>）。` : "该任务已在队列中。",
      { parseMode: "HTML" },
    );
  } catch (error) {
    await deps.reply(meta.chatId, meta.threadId, `执行失败：${errMsg(error)}`);
  }
}

/** Accepts a full id or an 8-char prefix; resolves against the task list. */
function resolveTaskId(arg: string, deps: DispatcherDeps): string | null {
  const raw = arg.trim();
  if (!raw) return null;
  const service = deps.resolveScheduler();
  if (!service) return null;
  if (raw.length >= 32) return raw; // full id
  const match = service.listTasks({ limit: 200 }).items.find((t) => t.id.startsWith(raw));
  return match ? match.id : null;
}

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return "启用";
    case "paused":
      return "暂停";
    case "completed":
      return "已完成";
    default:
      return status;
  }
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "success":
      return "✅";
    case "failed":
      return "❌";
    case "running":
      return "⏳";
    case "queued":
      return "📥";
    case "cancelled":
    case "interrupted":
      return "⏹";
    default:
      return "•";
  }
}

function fmtLocal(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(epochMs);
  }
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function denyMessage(
  code: string | null,
  _locale: Locale,
  s: ReturnType<typeof strings>,
): string {
  switch (code) {
    case "TELEGRAM_PRIVATE_ONLY":
      return s.privateOnly;
    case "TELEGRAM_CHAT_NOT_ALLOWED":
      return s.chatNotAllowed;
    case "TELEGRAM_USER_NOT_ALLOWED":
    default:
      return s.notPaired;
  }
}

/**
 * Standalone pairing-code factory used by the API route. Generates a plaintext
 * + hash pair and persists it. Returns the plaintext once for display.
 */
export function issuePairingCode(
  store: TelegramStore,
  role: "owner" | "operator" | "viewer",
  ttlMs = 10 * 60 * 1000,
): { plaintext: string; id: string; role: typeof role; expiresAt: number } {
  const plaintext = generatePairingCode();
  const codeHash = hashPairingCode(plaintext);
  const id = randomUUID();
  const expiresAt = Date.now() + ttlMs;
  store.createPairingCode({ id, codeHash, role, expiresAt });
  return { plaintext, id, role, expiresAt };
}

// Re-export for API convenience.
export { verifyPairingCode } from "./telegram-pairing";
