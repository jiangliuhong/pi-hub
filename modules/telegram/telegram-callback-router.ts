/**
 * Telegram callback router — resolves inline-keyboard button presses
 * (design doc §8.7, §18.6).
 *
 * A button carries `callback_data = a:<token>`. This module validates +
 * single-use consumes the token (see `ActionService`) for the pressing user,
 * then dispatches the bound action. The only P0 action is `task_run`
 * ("再次执行 / 重新执行" on task notifications), which calls
 * `TaskService.triggerRun(taskId)` — it never talks to the Pi Agent directly
 * and never changes a recurring task's `next_run_at` (§18.6).
 *
 * Authorization: the pressing user must be an enabled operator/owner (viewers
 * cannot trigger runs) and must match the token's bound user (unless the token
 * was created unbound, e.g. notification rerun buttons).
 */

import { authorize } from "./telegram-auth";
import { ActionService } from "./telegram-actions";
import { parseCallbackData } from "./telegram-transport";
import type { TelegramStore } from "./telegram-store";
import type { Locale } from "./telegram-i18n";
import { strings } from "./telegram-i18n";
import type { TaskService } from "@/modules/scheduler";
import type { TelegramPromptRunner } from "./telegram-prompt-runner";
import type { InlineKeyboardRows } from "./telegram-outbox";

/** Lazily resolves the scheduler TaskService (null when scheduler is down). */
export type SchedulerServiceResolver = () => TaskService | null;

export interface CallbackDeps {
  store: TelegramStore;
  resolveScheduler: SchedulerServiceResolver;
  /** Acknowledge the callback query (clears the spinner). */
  answerCallback: (callbackQueryId: string, text?: string, showAlert?: boolean) => Promise<void>;
  /** Reply in the originating chat (optionally HTML + buttons). */
  reply: (
    chatId: number,
    threadId: number | undefined,
    text: string,
    opts?: { parseMode?: "HTML"; inlineKeyboard?: InlineKeyboardRows },
  ) => Promise<void>;
  /** Lazily resolves the prompt runner (for abort buttons). */
  getRunner: () => TelegramPromptRunner | null;
  /** Resolve settings for the private-only / role checks. */
  isPrivateOnly: () => boolean;
  /** Re-renders a /sessions page (used by the prev/next buttons). */
  renderSessionsPage: (input: RenderPageInput) => Promise<void>;
  /** Re-renders a /model page (used by the prev/next buttons). */
  renderModelsPage: (input: RenderPageInput) => Promise<void>;
  /** Applies a model change to an active session; false if not in memory. */
  applyModelToActiveSession: (
    sessionId: string,
    provider: string,
    modelId: string,
  ) => Promise<boolean>;
}

/** Input to re-render a paginated list as a fresh message. */
export interface RenderPageInput {
  chatId: number;
  threadId: number;
  userId: number;
  page: number;
  locale: Locale;
}

export interface CallbackInput {
  callbackQueryId: string;
  /** The pressing user's Telegram id. */
  userId: number;
  /** Originating chat. */
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  threadId: number | undefined;
  /** Raw callback_data from the pressed button. */
  data: string | undefined;
  locale: Locale;
}

export interface CallbackResult {
  handled: boolean;
  reason?: string;
}

export async function routeCallbackQuery(
  deps: CallbackDeps,
  input: CallbackInput,
): Promise<CallbackResult> {
  const s = strings(input.locale);
  const token = parseCallbackData(input.data);
  if (!token) {
    await deps.answerCallback(input.callbackQueryId);
    return { handled: false, reason: "no_token" };
  }

  // Authorize first — unpaired users can't press buttons.
  const auth = authorize({
    store: deps.store,
    userId: input.userId,
    chatId: input.chatId,
    chatType: input.chatType,
    privateOnly: deps.isPrivateOnly(),
  });
  if (!auth.allowed || !auth.user) {
    await deps.answerCallback(input.callbackQueryId, s.notPaired, true);
    return { handled: false, reason: auth.denyCode ?? "unauthorized" };
  }

  const actions = new ActionService(deps.store);
  const result = actions.consume(token, input.userId);
  if (!result.ok || !result.action) {
    const text =
      result.reason === "forbidden"
        ? s.notPaired
        : result.reason === "used"
          ? s.callbackExpired
          : s.callbackExpired;
    await deps.answerCallback(input.callbackQueryId, text, true);
    return { handled: false, reason: result.reason ?? "consume_failed" };
  }

  switch (result.action.actionType) {
    case "task_run":
      return handleTaskRun(deps, input, result.action.payload, auth.user.role);
    case "abort":
      return handleAbort(deps, input, auth.user.telegramUserId, auth.user.role === "owner");
    case "workspace_switch":
      return handleWorkspaceSwitch(deps, input, result.action.payload);
    case "session_switch":
      return handleSessionSwitch(deps, input, result.action.payload);
    case "model_switch":
      return handleModelSwitch(deps, input, result.action.payload, auth.user.role);
    default:
      // Other action types arrive in later phases.
      await deps.answerCallback(input.callbackQueryId, s.featureNotReady);
      return { handled: false, reason: "not_implemented" };
  }
}

async function handleAbort(
  deps: CallbackDeps,
  input: CallbackInput,
  userId: number,
  isOwner: boolean,
): Promise<CallbackResult> {
  const runner = deps.getRunner();
  if (!runner) {
    await deps.answerCallback(input.callbackQueryId, "运行时未就绪", true);
    return { handled: false, reason: "no_runner" };
  }
  const res = await runner.abort(input.chatId, input.threadId ?? 0, userId, isOwner);
  await deps.answerCallback(
    input.callbackQueryId,
    res.ok ? "已请求停止" : res.error ?? "无法停止",
    !res.ok,
  );
  return { handled: res.ok };
}

async function handleTaskRun(
  deps: CallbackDeps,
  input: CallbackInput,
  payload: Record<string, unknown>,
  role: string,
): Promise<CallbackResult> {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  if (!taskId) {
    await deps.answerCallback(input.callbackQueryId, "无效的任务", true);
    return { handled: false, reason: "no_task_id" };
  }
  if (role === "viewer") {
    await deps.answerCallback(input.callbackQueryId, "权限不足", true);
    return { handled: false, reason: "forbidden_role" };
  }
  const service = deps.resolveScheduler();
  if (!service) {
    await deps.answerCallback(input.callbackQueryId, "调度器未就绪", true);
    return { handled: false, reason: "scheduler_unavailable" };
  }
  try {
    const { run, created } = service.triggerRun(taskId);
    await deps.answerCallback(
      input.callbackQueryId,
      created ? `已加入队列 (${run.id.slice(0, 8)})` : "任务已在队列中",
    );
    return { handled: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallback(input.callbackQueryId, `执行失败：${message}`, true);
    return { handled: false, reason: "trigger_failed" };
  }
}

async function handleWorkspaceSwitch(
  deps: CallbackDeps,
  input: CallbackInput,
  payload: Record<string, unknown>,
): Promise<CallbackResult> {
  const s = strings(input.locale);
  const workspace = typeof payload.workspace === "string" ? payload.workspace : null;
  const name = typeof payload.name === "string" ? payload.name : (workspace ?? "");
  if (!workspace) {
    await deps.answerCallback(input.callbackQueryId, s.featureNotReady, true);
    return { handled: false, reason: "no_workspace" };
  }
  const threadId = input.threadId ?? 0;
  const existing = deps.store.getConversation(input.chatId, threadId);
  if (existing) {
    deps.store.updateConversation(input.chatId, threadId, { workspace });
  } else {
    // First interaction: no conversation row yet (e.g. user picks a workspace
    // before ever sending a prompt). Create one so the choice sticks.
    deps.store.upsertConversation({
      chatId: input.chatId,
      threadId,
      ownerUserId: input.userId,
      workspace,
      locale: input.locale,
    });
  }
  await deps.answerCallback(input.callbackQueryId, s.workspaceSwitched(name));
  // Send a chat message so the user sees what to do next (the callback toast is
  // ephemeral; this makes the chosen workspace + next step visible inline).
  await deps.reply(input.chatId, input.threadId, s.workspaceReady(name));
  return { handled: true };
}

/**
 * Handles both modes of the session_switch action:
 *  - { mode: "switch", sessionId, sessionPath, name }: rebind the conversation
 *    to an existing session (§13.2 /sessions).
 *  - { mode: "page", page }: re-render the sessions list at the given page.
 */
async function handleSessionSwitch(
  deps: CallbackDeps,
  input: CallbackInput,
  payload: Record<string, unknown>,
): Promise<CallbackResult> {
  const s = strings(input.locale);
  const mode = typeof payload.mode === "string" ? payload.mode : "switch";
  const threadId = input.threadId ?? 0;

  if (mode === "page") {
    const page = typeof payload.page === "number" && payload.page > 0 ? payload.page : 0;
    await deps.answerCallback(input.callbackQueryId);
    await deps.renderSessionsPage({
      chatId: input.chatId,
      threadId,
      userId: input.userId,
      page,
      locale: input.locale,
    });
    return { handled: true };
  }

  // mode === "switch"
  // Note: viewers are allowed to switch sessions — rebinding only updates the
  // conversation pointer and never executes code. The actual run is still
  // gated by runPrompt's role check, so this stays safe.
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const sessionPath = typeof payload.sessionPath === "string" ? payload.sessionPath : null;
  const name = typeof payload.name === "string" ? payload.name : s.sessionsUnnamed;
  if (!sessionId || !sessionPath) {
    await deps.answerCallback(input.callbackQueryId, s.featureNotReady, true);
    return { handled: false, reason: "no_session" };
  }
  // Refuse switching while a run is active for this conversation.
  const conv = deps.store.getConversation(input.chatId, threadId);
  if (conv && conv.state === "running") {
    await deps.answerCallback(input.callbackQueryId, s.sessionsBusy, true);
    return { handled: false, reason: "busy" };
  }
  deps.store.updateConversation(input.chatId, threadId, {
    activeSessionId: sessionId,
    activeSessionPath: sessionPath,
    state: "idle",
  });
  await deps.answerCallback(input.callbackQueryId, s.sessionsSwitched(name));
  return { handled: true };
}

/**
 * Handles both modes of the model_switch action:
 *  - { mode: "switch", provider, modelId, name }: persist the model on the
 *    conversation and apply it to the live session if present.
 *  - { mode: "page", page }: re-render the model list at the given page.
 */
async function handleModelSwitch(
  deps: CallbackDeps,
  input: CallbackInput,
  payload: Record<string, unknown>,
  role: string,
): Promise<CallbackResult> {
  const s = strings(input.locale);
  const mode = typeof payload.mode === "string" ? payload.mode : "switch";
  const threadId = input.threadId ?? 0;

  if (mode === "page") {
    const page = typeof payload.page === "number" && payload.page > 0 ? payload.page : 0;
    await deps.answerCallback(input.callbackQueryId);
    await deps.renderModelsPage({
      chatId: input.chatId,
      threadId,
      userId: input.userId,
      page,
      locale: input.locale,
    });
    return { handled: true };
  }

  // mode === "switch"
  const provider = typeof payload.provider === "string" ? payload.provider : null;
  const modelId = typeof payload.modelId === "string" ? payload.modelId : null;
  const name = typeof payload.name === "string" ? payload.name : (modelId ?? "");
  if (!provider || !modelId) {
    await deps.answerCallback(input.callbackQueryId, s.modelInvalid, true);
    return { handled: false, reason: "no_model" };
  }
  if (role === "viewer") {
    await deps.answerCallback(input.callbackQueryId, s.featureNotReady, true);
    return { handled: false, reason: "forbidden_role" };
  }
  const conv = deps.store.getConversation(input.chatId, threadId);
  if (conv && conv.state === "running") {
    await deps.answerCallback(input.callbackQueryId, s.modelBusy, true);
    return { handled: false, reason: "busy" };
  }
  // Persist on the conversation row (applied on next session open/resume).
  if (conv) {
    deps.store.updateConversation(input.chatId, threadId, {
      modelProvider: provider,
      modelId,
    });
  } else {
    deps.store.upsertConversation({
      chatId: input.chatId,
      threadId,
      ownerUserId: input.userId,
      workspace: null,
      locale: input.locale,
      modelProvider: provider,
      modelId,
    });
  }
  // Apply to the live session immediately if it is still in memory.
  if (conv?.activeSessionId) {
    try {
      await deps.applyModelToActiveSession(conv.activeSessionId, provider, modelId);
    } catch {
      // Non-fatal: the persisted pin will apply on the next open/resume.
    }
  }
  await deps.answerCallback(input.callbackQueryId, s.modelSwitched(name));
  return { handled: true };
}
