/**
 * Notification Outbox — writer + worker (design doc §18.3).
 *
 * The `TelegramTaskNotifier` (and any future producer) enqueues fully-rendered
 * messages here; the leader-only `OutboxWorker` drains the queue through the
 * `TelegramTransport`. Producers never touch the network, so a notification
 * failure is recorded as a Warning and never alters the producing domain's
 * state (§18.3 "发送失败只记录 Warning，不修改 Task Run 状态").
 *
 * Retry policy (§18.3):
 *   - max 5 attempts;
 *   - exponential backoff with a cap;
 *   - Telegram 429 honors `retry_after`;
 *   - invalid token → mark this entry failed + emit a terminal signal so the
 *     runtime can surface a config error (no more blind hammering).
 *
 * Idempotency: each entry carries a `dedupeKey` (e.g.
 * `task-run:{runId}:success`) enforced by a UNIQUE constraint in the store, so
 * a duplicated notification event is silently dropped.
 */

import { randomUUID } from "crypto";

import { TelegramErrorCode, type TelegramError } from "./errors";
import { TelegramTransport } from "./telegram-transport";
import type { TelegramStore } from "./telegram-store";
import type { OutboxEventType, OutboxStatus } from "./types";

// ---------------------------------------------------------------------------
// Payload (stored as payloadJson) — the worker renders nothing; it just sends.
// ---------------------------------------------------------------------------

export type InlineKeyboardRows = ReadonlyArray<
  ReadonlyArray<{ text: string; callbackData: string }>
>;

export interface OutboxMessagePayload {
  text: string;
  parseMode?: "HTML";
  disablePreview?: boolean;
  inlineKeyboard?: InlineKeyboardRows;
}

export interface EnqueueInput {
  /** Stable key; duplicates are dropped (UNIQUE). e.g. `task-run:{runId}:success`. */
  dedupeKey: string;
  chatId: number;
  threadId: number;
  eventType: OutboxEventType;
  message: OutboxMessagePayload;
  /** Epoch ms to first attempt; defaults to now. */
  runAt?: number;
}

/** Writes rendered messages into the outbox without touching the network. */
export class OutboxWriter {
  constructor(private readonly store: TelegramStore) {}

  enqueue(input: EnqueueInput): boolean {
    const runAt = input.runAt ?? Date.now();
    const entry = this.store.enqueueNotification({
      id: randomUUID(),
      dedupeKey: input.dedupeKey,
      chatId: input.chatId,
      threadId: input.threadId,
      eventType: input.eventType,
      payloadJson: JSON.stringify(input.message),
      nextAttemptAt: runAt,
    });
    return entry !== null;
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface OutboxWorkerOptions {
  store: TelegramStore;
  /** Resolves the leader's transport (null when not leader / no bot). */
  getTransport: () => TelegramTransport | null;
  intervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
  /** Entries stuck in "sending" longer than this are reclaimed to "pending". */
  staleSendingMs?: number;
  /** Fired when an entry is abandoned (token invalid or max attempts). */
  onTerminal?: (entry: TerminalEntry) => void;
}

export interface TerminalEntry {
  id: string;
  dedupeKey: string;
  eventType: OutboxEventType;
  lastError: string | null;
  reason: "max_attempts" | "invalid_token";
}

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly store: TelegramStore;
  private readonly getTransport: () => TelegramTransport | null;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly staleSendingMs: number;
  private readonly onTerminal?: (entry: TerminalEntry) => void;

  constructor(opts: OutboxWorkerOptions) {
    this.store = opts.store;
    this.getTransport = opts.getTransport;
    this.intervalMs = opts.intervalMs ?? 4_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseBackoffMs = opts.baseBackoffMs ?? 4_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30 * 60 * 1_000;
    this.batchSize = opts.batchSize ?? 20;
    this.staleSendingMs = opts.staleSendingMs ?? 60_000;
    this.onTerminal = opts.onTerminal;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce(Date.now()).catch((error) => {
        console.warn(
          "[pi-hub:telegram] outbox drain error",
          error instanceof Error ? error.message : error,
        );
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drains one batch. Returns the number of entries processed (sent +
   * rescheduled + failed). Pure for testing: no internal timer.
   */
  async runOnce(now: number): Promise<number> {
    this.reclaimStaleSending(now);

    const transport = this.getTransport();
    const pending = this.store.listOutbox("pending", this.batchSize);
    let processed = 0;
    for (const entry of pending) {
      // Backoff not yet elapsed → leave for a later tick.
      if (entry.nextAttemptAt > now) continue;
      // No transport (not leader / bot down) → wait; don't burn attempts.
      if (!transport) break;

      processed++;
      // Soft-lock the entry as "sending" so a concurrent tick can't double-send.
      this.store.updateOutbox(entry.id, { status: "sending", lastError: null });

      let payload: OutboxMessagePayload;
      try {
        payload = JSON.parse(entry.payloadJson) as OutboxMessagePayload;
      } catch {
        // Corrupt payload is unrecoverable.
        this.store.updateOutbox(entry.id, {
          status: "failed",
          lastError: "invalid payload JSON",
        });
        this.fireTerminal(entry, "invalid payload JSON", "max_attempts");
        continue;
      }

      try {
        await transport.sendMessage({
          chatId: entry.chatId,
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
          text: payload.text,
          ...(payload.parseMode ? { parseMode: payload.parseMode } : {}),
          ...(payload.disablePreview ? { disablePreview: true } : {}),
          ...(payload.inlineKeyboard ? { inlineKeyboard: payload.inlineKeyboard } : {}),
        });
        this.store.updateOutbox(entry.id, {
          status: "sent",
          sentAt: Date.now(),
          lastError: null,
        });
      } catch (error) {
        this.handleSendFailure(entry, error, now);
      }
    }
    return processed;
  }

  // ---- internal ------------------------------------------------------------

  private reclaimStaleSending(now: number): void {
    const sending = this.store.listOutbox("sending", this.batchSize * 2);
    for (const entry of sending) {
      if (now - entry.updatedAt > this.staleSendingMs) {
        this.store.updateOutbox(entry.id, { status: "pending" });
      }
    }
  }

  private handleSendFailure(
    entry: { id: string; dedupeKey: string; eventType: OutboxEventType; attemptCount: number },
    error: unknown,
    now: number,
  ): void {
    const code = (error as TelegramError | undefined)?.code;
    const message =
      error instanceof Error ? error.message : String(error);

    // Invalid token → abandon immediately and signal the runtime (§18.3).
    if (code === TelegramErrorCode.TELEGRAM_TOKEN_INVALID) {
      this.store.updateOutbox(entry.id, {
        status: "failed",
        lastError: message,
      });
      this.fireTerminal(entry, message, "invalid_token");
      return;
    }

    const nextAttempt = entry.attemptCount + 1;
    if (nextAttempt >= this.maxAttempts) {
      this.store.updateOutbox(entry.id, {
        status: "failed",
        attemptCount: nextAttempt,
        lastError: message,
      });
      this.fireTerminal(entry, message, "max_attempts");
      return;
    }

    const retryAfterSec = extractRetryAfter(message, code);
    const backoff = retryAfterSec
      ? retryAfterSec * 1_000
      : Math.min(this.baseBackoffMs * 2 ** entry.attemptCount, this.maxBackoffMs);
    this.store.updateOutbox(entry.id, {
      status: "pending",
      attemptCount: nextAttempt,
      nextAttemptAt: now + Math.max(1_000, backoff),
      lastError: message,
    });
  }

  private fireTerminal(
    entry: { id: string; dedupeKey: string; eventType: OutboxEventType },
    lastError: string | null,
    reason: "max_attempts" | "invalid_token",
  ): void {
    console.warn(
      `[pi-hub:telegram] outbox ${reason}: ${entry.eventType} ${entry.dedupeKey} (${lastError ?? "unknown"})`,
    );
    this.onTerminal?.({ id: entry.id, dedupeKey: entry.dedupeKey, eventType: entry.eventType, lastError, reason });
  }
}

/** Parses Telegram's "(retry after Ns)" hint, if present. */
function extractRetryAfter(message: string, code?: string): number | null {
  if (code !== TelegramErrorCode.TELEGRAM_RATE_LIMITED) return null;
  const match = /retry after (\d+)/i.exec(message);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Convenience for tests/inspection. */
export function outboxStatusList(store: TelegramStore, status: OutboxStatus): number {
  return store.countOutbox(status);
}
