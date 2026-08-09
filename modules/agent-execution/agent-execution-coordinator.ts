/**
 * AgentExecutionCoordinator — process-wide per-session run lock (design §8).
 *
 * Guarantees (§8.5 V1):
 *   - a session runs at most one prompt at a time;
 *   - a second acquire while a run is live fails fast with the current owner
 *     (no implicit queuing — §8.5 "V1 不自动把第二个 Prompt 排队");
 *   - `extension_ui_response` / interactive ownership is queryable (§8.6);
 *   - a leaked lock (process bug, forgotten release) is reclaimed by a
 *     max-TTL watchdog so a session can never be wedged forever.
 *
 * The coordinator is a pure in-process registry — it does NOT route Agent
 * events. Each client subscribes to its own event stream (Web SSE, Telegram's
 * in-process subscription). This module only answers "who owns this session
 * right now?" so callers can enforce the single-writer rule (§8.1).
 *
 * Singleton via `globalThis` so it survives Next.js hot-reload, mirroring the
 * rpc-manager wrapper registry pattern.
 */

import {
  SOURCE_LABELS,
  type AgentRunContext,
  type RunSource,
} from "./run-context";

/** Result of an acquire attempt. */
export interface AcquireResult {
  ok: boolean;
  /** Present (with the live owner) when the session is busy. */
  owner?: AgentRunContext;
}

export interface AcquireInput {
  runId: string;
  sessionId: string;
  source: RunSource;
  ownerKey: string;
  sourceLabel?: string;
}

/**
 * Map semantics: a session → its current run context. One entry per session.
 */
export class AgentExecutionCoordinator {
  private readonly locks = new Map<string, AgentRunContext>();
  private readonly maxTtlMs: number;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxTtlMs?: number }) {
    this.maxTtlMs = options?.maxTtlMs ?? 30 * 60 * 1_000; // 30 min safety net
  }

  /**
   * Attempts to claim the session for `runId`. Returns `{ ok: true }` on
   * success, or `{ ok: false, owner }` describing the live owner when busy.
   * Re-acquiring with the same `runId` is idempotent (returns ok).
   */
  acquire(input: AcquireInput): AcquireResult {
    const existing = this.locks.get(input.sessionId);
    if (existing) {
      if (existing.runId === input.runId) {
        return { ok: true }; // idempotent re-acquire by the same run
      }
      // Stale lock past TTL is reclaimable (defensive — runners release on done).
      if (Date.now() - existing.startedAt > this.maxTtlMs) {
        this.locks.delete(input.sessionId);
      } else {
        return { ok: false, owner: existing };
      }
    }
    this.locks.set(input.sessionId, {
      runId: input.runId,
      sessionId: input.sessionId,
      source: input.source,
      ownerKey: input.ownerKey,
      startedAt: Date.now(),
      sourceLabel: input.sourceLabel ?? SOURCE_LABELS[input.source],
    });
    return { ok: true };
  }

  /**
   * Releases the lock. Only the owning `runId` may release unless `force`
   * (used by abort/cleanup paths). No-op if already released or owned by
   * another run (without force).
   */
  release(sessionId: string, runId: string, options?: { force?: boolean }): boolean {
    const existing = this.locks.get(sessionId);
    if (!existing) return false;
    if (existing.runId !== runId && !options?.force) return false;
    this.locks.delete(sessionId);
    return true;
  }

  /** The current run context for a session, or null when idle. */
  getOwner(sessionId: string): AgentRunContext | null {
    const existing = this.locks.get(sessionId);
    if (!existing) return null;
    if (Date.now() - existing.startedAt > this.maxTtlMs) {
      this.locks.delete(sessionId);
      return null;
    }
    return existing;
  }

  /** True when the session is owned by the given owner key (same client). */
  isOwnedBy(sessionId: string, ownerKey: string): boolean {
    const owner = this.getOwner(sessionId);
    return owner?.ownerKey === ownerKey;
  }

  /** Number of sessions currently locked (for status/diagnostics). */
  size(): number {
    return this.locks.size;
  }

  /** Starts the stale-lock watchdog. Idempotent. */
  startWatchdog(intervalMs = 60_000): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.sweep(), intervalMs);
  }

  /** Stops the watchdog (tests / shutdown). */
  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Removes locks held longer than maxTtlMs. Exposed for tests. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [sessionId, ctx] of this.locks) {
      if (now - ctx.startedAt > this.maxTtlMs) {
        this.locks.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton (survives Next.js hot-reload)
// ---------------------------------------------------------------------------

declare global {
  var __piHubAgentExecutionCoordinator: AgentExecutionCoordinator | undefined;
}

/** Returns the process-wide coordinator, creating it lazily on first use. */
export function getAgentExecutionCoordinator(): AgentExecutionCoordinator {
  if (!globalThis.__piHubAgentExecutionCoordinator) {
    globalThis.__piHubAgentExecutionCoordinator = new AgentExecutionCoordinator();
  }
  return globalThis.__piHubAgentExecutionCoordinator;
}

/** Test-only: reset the singleton + its state. */
export function __resetAgentExecutionCoordinator(): void {
  globalThis.__piHubAgentExecutionCoordinator?.stopWatchdog();
  globalThis.__piHubAgentExecutionCoordinator = undefined;
}
