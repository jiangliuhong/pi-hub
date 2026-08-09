/**
 * TelegramManualRunNotifier — sends a "manual run completed" card to Telegram
 * when a user-driven (Web chat) Agent run finishes.
 *
 * Unlike `TelegramTaskNotifier` (fed by the scheduler), this is invoked on
 * demand from the web client via `POST /api/integrations/telegram/notify-run`.
 * It reuses the same outbox pipeline and the same default delivery rule
 * (enabled owner/operator private chats), so the transport, leader-only
 * sending, and retry semantics are identical.
 *
 * As with the task notifier, any failure to enqueue is swallowed so it can
 * never affect the Agent run that already completed (design doc §30.10).
 */

import { esc, fmtDuration, fmtTime, resolveOwnerChatTargets } from "./telegram-format";
import { OutboxWriter, type OutboxMessagePayload } from "./telegram-outbox";
import type { TelegramStore } from "./telegram-store";
import type { OutboxEventType } from "./types";

export interface ManualRunNotifyInput {
  /** Pi session id of the completed run. */
  sessionId: string;
  status: "success" | "failed";
  /** Optional session display name for context. */
  sessionName?: string | null;
  /** Actual session working directory — shown in the notification card. */
  cwd?: string | null;
  /**
   * Project root of the session cwd, used for worktree-aware workspace
   * scoping (folds worktree sessions back to the main repo, matching how the
   * rest of the app groups sessions). Falls back to `cwd` when absent.
   */
  sessionProjectRoot?: string | null;
  /** The user prompt that started the run (truncated for display). */
  prompt?: string | null;
  /** Last assistant text excerpt (≤ 4000 chars). */
  resultExcerpt?: string | null;
  /** Error message when status === "failed". */
  errorMessage?: string | null;
  /** Epoch ms when the run started, if known. */
  startedAt?: number | null;
  /** Epoch ms when the run finished. */
  finishedAt?: number | null;
  /** Public URL base for "open session" links; null → omit. */
  publicUrl?: string | null;
}

const MAX_PROMPT_EXCERPT = 400;

export interface ManualRunNotifyResult {
  /** Number of chats the notification was enqueued to. */
  notified: number;
  /** 0 when Telegram is not running/configured. */
  skipped: boolean;
}

/**
 * Renders + enqueues a manual-run completion notification to every owner/
 * operator private chat. Never throws — returns a result describing what
 * happened. `notified: 0` is a silent no-op (e.g. Telegram off, no chats).
 */
export function notifyManualRun(
  store: TelegramStore,
  input: ManualRunNotifyInput,
): ManualRunNotifyResult {
  const targets = resolveOwnerChatTargets(store, {
    sessionCwd: input.sessionProjectRoot ?? input.cwd,
  });
  if (targets.length === 0) return { notified: 0, skipped: true };

  let writer: OutboxWriter;
  try {
    writer = new OutboxWriter(store);
  } catch (error) {
    logWarn("writer init failed", error);
    return { notified: 0, skipped: true };
  }

  const eventType: OutboxEventType =
    input.status === "success" ? "task_success" : "task_failure";
  const nonce = input.finishedAt ?? Date.now();
  let enqueued = 0;

  for (const target of targets) {
    try {
      const text =
        input.status === "success" ? renderSucceeded(input) : renderFailed(input);
      const message: OutboxMessagePayload = { text, parseMode: "HTML" };
      const ok = writer.enqueue({
        dedupeKey: `manual-run:${input.sessionId}:${nonce}:${target.chatId}:${target.threadId}`,
        chatId: target.chatId,
        threadId: target.threadId,
        eventType,
        message,
      });
      if (ok) enqueued += 1;
    } catch (error) {
      logWarn(`enqueue failed (${eventType})`, error);
    }
  }

  return { notified: enqueued, skipped: false };
}

// ---------------------------------------------------------------------------
// Rendering. Telegram HTML; values are escaped.
// ---------------------------------------------------------------------------

function renderSucceeded(input: ManualRunNotifyInput): string {
  const lines = [
    "✅ 手动任务完成",
    "",
    input.sessionName ? `<b>会话：</b>${esc(input.sessionName)}` : null,
  ];
  if (input.startedAt) {
    lines.push(`<b>开始：</b>${fmtTime(input.startedAt)}`);
  }
  if (input.startedAt && input.finishedAt) {
    lines.push(`<b>耗时：</b>${fmtDuration(input.finishedAt - input.startedAt)}`);
  } else if (input.finishedAt) {
    lines.push(`<b>完成：</b>${fmtTime(input.finishedAt)}`);
  }
  if (input.prompt) {
    lines.push("", `<b>指令：</b>${esc(truncate(input.prompt, MAX_PROMPT_EXCERPT))}`);
  }
  if (input.resultExcerpt) {
    lines.push("", "<b>结果：</b>", esc(truncate(input.resultExcerpt, 1200)));
  }
  if (input.cwd) {
    lines.push("", `<b>目录：</b><code>${esc(shortenPath(input.cwd))}</code>`);
  }
  lines.push("", `<b>Session：</b><code>${esc(input.sessionId)}</code>`);
  if (input.publicUrl && input.sessionId) {
    lines.push(
      `🔗 <a href="${esc(buildSessionUrl(input.publicUrl, input.sessionId))}">打开会话</a>`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

function renderFailed(input: ManualRunNotifyInput): string {
  const lines = ["❌ 手动任务失败", ""];
  if (input.sessionName) lines.push(`<b>会话：</b>${esc(input.sessionName)}`);
  if (input.startedAt && input.finishedAt) {
    lines.push(`<b>耗时：</b>${fmtDuration(input.finishedAt - input.startedAt)}`);
  } else if (input.finishedAt) {
    lines.push(`<b>时间：</b>${fmtTime(input.finishedAt)}`);
  }
  if (input.prompt) {
    lines.push("", `<b>指令：</b>${esc(truncate(input.prompt, MAX_PROMPT_EXCERPT))}`);
  }
  if (input.errorMessage) {
    lines.push("", esc(truncate(input.errorMessage, 1200)));
  }
  lines.push("", `<b>Session：</b><code>${esc(input.sessionId)}</code>`);
  if (input.publicUrl && input.sessionId) {
    lines.push(
      `🔗 <a href="${esc(buildSessionUrl(input.publicUrl, input.sessionId))}">打开会话</a>`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

/** Builds a deep link to the session in the web UI. */
function buildSessionUrl(publicUrl: string, sessionId: string): string {
  const base = publicUrl.replace(/\/$/, "");
  return `${base}/?session=${encodeURIComponent(sessionId)}`;
}

// ---- helpers --------------------------------------------------------------

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function shortenPath(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function logWarn(prefix: string, error: unknown): void {
  console.warn(
    `[pi-hub:telegram] manual-run ${prefix}`,
    error instanceof Error ? error.message : error,
  );
}
