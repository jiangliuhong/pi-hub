/**
 * TelegramTaskNotifier — bridges scheduler events into the Telegram outbox
 * (design doc §18.1, §18.4, §18.5).
 *
 * Implements the scheduler's `TaskNotifier` interface. It is constructed once
 * (in instrumentation.ts) and handed to the scheduler runtime; it resolves the
 * live Telegram store lazily so the scheduler can start before/after the
 * Telegram runtime without ordering coupling.
 *
 * Responsibilities:
 *   - decide which chat(s) to notify (V1: task subscriptions, else every
 *     enabled owner/operator private chat that has a conversation);
 *   - render the §18.4/§18.5 message text + inline buttons;
 *   - mint single-use action tokens for "rerun" buttons (§8.7);
 *   - enqueue into the outbox — never sends directly (§18.1, §18.3).
 *
 * Failures (no store, no subscriptions, outbox full) are swallowed so they can
 * never change a task run's outcome (§18.3, safeNotify contract).
 */

import type { TaskNotifier, TaskRunNotification, TaskRunDeferredNotification } from "@/modules/scheduler/task-notifier";

import type { ExecutionOptions, TaskRun } from "@/modules/scheduler/types";

import { ActionService } from "./telegram-actions";
import { esc, fmtDuration, fmtTime, workspaceAllows } from "./telegram-format";
import { OutboxWriter, type InlineKeyboardRows, type OutboxMessagePayload } from "./telegram-outbox";
import type { TelegramStore } from "./telegram-store";
import type { OutboxEventType } from "./types";

/** Lazily resolves the live store (set once the Telegram runtime is up). */
export type StoreResolver = () => TelegramStore | null;

export interface TelegramTaskNotifierOptions {
  /** Resolves the live store. Returns null when Telegram isn't running. */
  resolveStore: StoreResolver;
  /** Public URL base for "open session" links; null → omit the link button. */
  resolvePublicUrl?: () => string | null;
  /**
   * Resolves a cwd to its project root for worktree-aware workspace scoping
   * (folds worktree sessions back to the main repo). Optional; when absent,
   * scoping falls back to the raw task cwd. Only invoked when strict
   * scoping is active (allowAllWorkspaceNotifications off).
   */
  resolveProjectRoot?: (cwd: string) => Promise<string>;
}

export class TelegramTaskNotifier implements TaskNotifier {
  private readonly resolveStore: StoreResolver;
  private readonly resolvePublicUrl?: () => string | null;
  private readonly resolveProjectRoot?: (cwd: string) => Promise<string>;

  constructor(options: TelegramTaskNotifierOptions) {
    this.resolveStore = options.resolveStore;
    this.resolvePublicUrl = options.resolvePublicUrl;
    this.resolveProjectRoot = options.resolveProjectRoot;
  }

  async onRunStarted(event: TaskRunNotification): Promise<void> {
    // Only send a "started" ping when the task opted into any completion
    // notification — a task with both flags off should be fully silent.
    const opts = parseExecutionOptions(event.run);
    if (!opts.notifyOnSuccess && !opts.notifyOnFailure) return;
    await this.notify(event, "task_started", (run, taskName) => renderStarted(run, taskName));
  }

  async onRunSucceeded(event: TaskRunNotification): Promise<void> {
    if (!parseExecutionOptions(event.run).notifyOnSuccess) return;
    await this.notify(event, "task_success", (run, taskName) =>
      renderSucceeded(run, taskName, this.resolvePublicUrl?.() ?? null, (taskId) => this.rerunButton(taskId)),
    );
  }

  async onRunFailed(event: TaskRunNotification): Promise<void> {
    if (!parseExecutionOptions(event.run).notifyOnFailure) return;
    await this.notify(event, "task_failure", (run, taskName) =>
      renderFailed(run, taskName, this.resolvePublicUrl?.() ?? null, (taskId) => this.rerunButton(taskId)),
    );
  }

  async onRunDeferred(event: TaskRunDeferredNotification): Promise<void> {
    // Deferred is failure-adjacent — only ping users who opted into failure
    // notifications. (A task with both flags off stays fully silent.) Unlike
    // onRunFailed, no rerun button is attached: a retry is already queued.
    if (!parseExecutionOptions(event.run).notifyOnFailure) return;
    await this.notify(event, "task_deferred", (run, taskName) =>
      renderDeferred(run, taskName, event.reason, event.nextRunAt),
    );
  }

  // ---- internal ------------------------------------------------------------

  private async notify(
    event: TaskRunNotification,
    eventType: OutboxEventType,
    build: (run: TaskRun, taskName: string) => { text: string; buttons?: InlineKeyboardRows },
  ): Promise<void> {
    let store: TelegramStore | null;
    try {
      store = this.resolveStore();
    } catch (error) {
      logWarn("store resolve failed", error);
      return;
    }
    if (!store) return; // Telegram not running — silently skip.

    // Worktree-aware scoping: when strict scoping is active, fold the task's
    // cwd back to its project root so worktree sessions match a chat bound
    // to the project root (consistent with how the app groups sessions).
    const scopeCwd = await this.resolveScopeCwd(store, event.run.cwdSnapshot);
    const targets = resolveTargets(store, event.run.taskId, scopeCwd);
    if (targets.length === 0) return;

    let writer: OutboxWriter;
    let actions: ActionService;
    try {
      writer = new OutboxWriter(store);
      actions = new ActionService(store);
    } catch (error) {
      logWarn("writer/actions init failed", error);
      return;
    }

    const dedupeKey = (chatId: number, threadId: number) =>
      `${eventTypeKey(eventType, event.run.id)}:${chatId}:${threadId}`;
    for (const target of targets) {
      try {
        const { text, buttons } = build(event.run, event.taskName);
        const message: OutboxMessagePayload = {
          text,
          parseMode: "HTML",
          ...(buttons && buttons.length > 0 ? { inlineKeyboard: buttons } : {}),
        };
        // Mint any action tokens referenced by buttons up front so they exist
        // before the message is sent (the button callback_data carries the
        // token). rerunButton() below already created them; nothing to do here.
        void actions; // tokens created inside render via closures
        writer.enqueue({
          dedupeKey: dedupeKey(target.chatId, target.threadId),
          chatId: target.chatId,
          threadId: target.threadId,
          eventType,
          message,
        });
      } catch (error) {
        logWarn(`enqueue failed (${eventType})`, error);
      }
    }
  }

  /** Builds the [再次执行/重新执行] row with a single-use action token. */
  private rerunButton(taskId: string | null): InlineKeyboardRows {
    if (!taskId) return [];
    const store = this.resolveStore();
    if (!store) return [];
    try {
      const actions = new ActionService(store);
      const { callbackData } = actions.create({
        actionType: "task_run",
        payload: { taskId },
        userId: null, // any authorized operator/owner may rerun
        chatId: 0,
        threadId: 0,
      });
      return [[{ text: "🔄 再次执行", callbackData }]];
    } catch (error) {
      logWarn("rerun token create failed", error);
      return [];
    }
  }

  /**
   * Returns the cwd to use for workspace scoping. When strict scoping is off
   * (the default), or no resolver is wired, returns the raw cwd unchanged.
   * Otherwise resolves the project root so worktree sessions fold back to
   * the main repo. Never throws — falls back to the raw cwd on failure.
   */
  private async resolveScopeCwd(
    store: TelegramStore,
    rawCwd: string,
  ): Promise<string> {
    const allowAll = store.getSettings().allowAllWorkspaceNotifications;
    if (allowAll || !rawCwd || !this.resolveProjectRoot) return rawCwd;
    try {
      return await this.resolveProjectRoot(rawCwd);
    } catch (error) {
      logWarn("projectRoot resolve failed", error);
      return rawCwd;
    }
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

interface ChatTarget {
  chatId: number;
  threadId: number;
}

/**
 * V1 delivery rule:
 *   1. explicit task subscriptions (notify_started/success/failure flags) —
 *      these are explicit opt-ins and are NEVER workspace-scoped;
 *   2. otherwise every enabled owner/operator user that has a conversation
 *      in a private chat, subject to the workspace-scoping rule.
 */
function resolveTargets(
  store: TelegramStore,
  taskId: string | null,
  sessionCwd: string | null,
): ChatTarget[] {
  const settings = store.getSettings();
  const allowAll = settings.allowAllWorkspaceNotifications;

  const targets: ChatTarget[] = [];
  const seen = new Set<string>();

  if (taskId) {
    const subs = store.listSubscriptionsForTask(taskId);
    for (const sub of subs) {
      const key = `${sub.chatId}:${sub.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ chatId: sub.chatId, threadId: sub.threadId });
    }
  }

  if (targets.length > 0) return targets;

  // Default: owner/operator private-chat conversations.
  const users = store.listUsers().filter(
    (u) => u.enabled && (u.role === "owner" || u.role === "operator"),
  );
  const conversations = store.listConversations();
  for (const conv of conversations) {
    if (conv.threadId !== 0) continue; // private chat root only
    const key = `${conv.chatId}:${conv.threadId}`;
    if (seen.has(key)) continue;
    // Only deliver to chats owned by an enabled owner/operator.
    if (conv.ownerUserId !== null && !users.some((u) => u.telegramUserId === conv.ownerUserId)) {
      continue;
    }
    if (!workspaceAllows(conv.workspace, sessionCwd, allowAll)) continue;
    seen.add(key);
    targets.push({ chatId: conv.chatId, threadId: conv.threadId });
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Rendering (§18.4 / §18.5). Telegram HTML; values are escaped.
// ---------------------------------------------------------------------------

function eventTypeKey(eventType: OutboxEventType, runId: string): string {
  switch (eventType) {
    case "task_started":
      return `task-run:${runId}:started`;
    case "task_success":
      return `task-run:${runId}:success`;
    case "task_failure":
      return `task-run:${runId}:failed`;
    case "task_deferred":
      return `task-run:${runId}:deferred`;
    default:
      return `task-run:${runId}:${eventType}`;
  }
}

function renderStarted(run: TaskRun, taskName: string): { text: string } {
  return {
    text: [
      "⏳ 任务开始执行",
      "",
      `<b>任务：</b>${esc(taskName)}`,
      `<b>计划时间：</b>${fmtTime(run.scheduledFor)}`,
      run.startedAt ? `<b>开始时间：</b>${fmtTime(run.startedAt)}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function renderSucceeded(
  run: TaskRun,
  taskName: string,
  publicUrl: string | null,
  rerun: (taskId: string | null) => InlineKeyboardRows,
): { text: string; buttons?: InlineKeyboardRows } {
  const lines = [
    "✅ 任务执行成功",
    "",
    `<b>任务：</b>${esc(taskName)}`,
    run.startedAt ? `<b>开始时间：</b>${fmtTime(run.startedAt)}` : null,
    run.finishedAt && run.startedAt
      ? `<b>耗时：</b>${fmtDuration(run.finishedAt - run.startedAt)}`
      : null,
  ];
  if (run.resultExcerpt) {
    lines.push("", "<b>结果：</b>", esc(run.resultExcerpt));
  }
  if (run.sessionId) {
    lines.push("", `<b>Session：</b><code>${esc(run.sessionId)}</code>`);
  }
  const buttons = buildFooterButtons(publicUrl, run.sessionId, run.taskId, rerun);
  return { text: lines.filter(Boolean).join("\n"), buttons };
}

function renderFailed(
  run: TaskRun,
  taskName: string,
  publicUrl: string | null,
  rerun: (taskId: string | null) => InlineKeyboardRows,
): { text: string; buttons?: InlineKeyboardRows } {
  const lines = [
    "❌ 任务执行失败",
    "",
    `<b>任务：</b>${esc(taskName)}`,
    run.startedAt && run.finishedAt
      ? `<b>耗时：</b>${fmtDuration(run.finishedAt - run.startedAt)}`
      : null,
  ];
  if (run.errorCode) {
    lines.push(`<b>错误：</b><code>${esc(run.errorCode)}</code>`);
  }
  if (run.errorMessage) {
    lines.push("", esc(run.errorMessage));
  }
  if (run.sessionId) {
    lines.push("", `<b>Session：</b><code>${esc(run.sessionId)}</code>`);
  }
  const buttons = buildFooterButtons(publicUrl, run.sessionId, run.taskId, rerun);
  return { text: lines.filter(Boolean).join("\n"), buttons };
}

/** Renders a transient-failure notice: the run did NOT terminally fail — it
 *  was auto-rescheduled. Worded as "retrying" with the next attempt time, and
 *  carries no rerun button (a retry is already queued). */
function renderDeferred(
  run: TaskRun,
  taskName: string,
  reason: "session_busy" | "rate_limit",
  nextRunAt: number,
): { text: string } {
  const headline =
    reason === "session_busy"
      ? "⏳ 会话被占用，稍后自动重试"
      : "⏳ 触发限额，稍后自动重试";
  const lines = [
    headline,
    "",
    `<b>任务：</b>${esc(taskName)}`,
    `<b>下次重试：</b>${fmtTime(nextRunAt)}`,
  ];
  if (run.errorCode) {
    lines.push(`<b>原因：</b><code>${esc(run.errorCode)}</code>`);
  }
  if (run.sessionId) {
    lines.push("", `<b>Session：</b><code>${esc(run.sessionId)}</code>`);
  }
  return { text: lines.filter(Boolean).join("\n") };
}

function buildFooterButtons(
  publicUrl: string | null,
  sessionId: string | null,
  taskId: string | null,
  rerun: (taskId: string | null) => InlineKeyboardRows,
): InlineKeyboardRows {
  const rows: { text: string; callbackData: string }[][] = [];
  const row: { text: string; callbackData: string }[] = [];
  if (publicUrl && sessionId) {
    // Inline keyboard URL buttons can't use callback_data; but our transport
    // only emits callback buttons. For V1 we omit the URL button and rely on
    // the Session id in text. (URL buttons are a P1 transport addition.)
  }
  rows.push(...rerun(taskId).map((r) => [...r]));
  if (row.length > 0) rows.push(row);
  return rows;
}

// ---- snapshot parsing -----------------------------------------------------

/** Parses the run's execution-options snapshot; never throws. */
function parseExecutionOptions(run: TaskRun): ExecutionOptions {
  try {
    const parsed = JSON.parse(run.executionOptionsSnapshotJson) as Partial<ExecutionOptions>;
    return {
      notifyOnSuccess: parsed.notifyOnSuccess ?? false,
      notifyOnFailure: parsed.notifyOnFailure ?? true,
    } as ExecutionOptions;
  } catch {
    // Corrupt snapshot → fall back to the service defaults (failure-only).
    return { notifyOnSuccess: false, notifyOnFailure: true } as ExecutionOptions;
  }
}

function logWarn(prefix: string, error: unknown): void {
  console.warn(
    `[pi-hub:telegram] notifier ${prefix}`,
    error instanceof Error ? error.message : error,
  );
}
