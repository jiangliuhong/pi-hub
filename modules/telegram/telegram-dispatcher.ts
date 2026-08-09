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
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

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
        await bot.api.setMyCommands(commandList(settings.defaultLocale));
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
      await deps.reply(meta.chatId, meta.threadId, s.featureNotReady);
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
    case "model":
    case "context":
    case "commands": {
      await deps.reply(meta.chatId, meta.threadId, s.featureNotReady);
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
