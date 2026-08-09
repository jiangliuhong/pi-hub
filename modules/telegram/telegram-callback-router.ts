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

/** Lazily resolves the scheduler TaskService (null when scheduler is down). */
export type SchedulerServiceResolver = () => TaskService | null;

export interface CallbackDeps {
  store: TelegramStore;
  resolveScheduler: SchedulerServiceResolver;
  /** Acknowledge the callback query (clears the spinner). */
  answerCallback: (callbackQueryId: string, text?: string, showAlert?: boolean) => Promise<void>;
  /** Reply in the originating chat. */
  reply: (chatId: number, threadId: number | undefined, text: string) => Promise<void>;
  /** Lazily resolves the prompt runner (for abort buttons). */
  getRunner: () => TelegramPromptRunner | null;
  /** Resolve settings for the private-only / role checks. */
  isPrivateOnly: () => boolean;
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
    default:
      // Other action types (session_switch, abort, …) arrive in phase 3.
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
