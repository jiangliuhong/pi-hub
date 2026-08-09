/**
 * SchedulerRuntime — singleton that owns the scheduler lifecycle.
 *
 * Responsibilities:
 *   - idempotent startup (globalThis guard, §30.7) keyed on `__piHubSchedulerRuntime`
 *   - DB open + migration + stale-run recovery (§19)
 *   - leader lease acquisition + renewal (§8.2)
 *   - scanner tick (§8.3) and execution queue (concurrency 1, overlap skip)
 *   - status reporting for /api/scheduler/status
 *
 * The runtime does NOT hold DB transactions across Agent work (§30.4). Runs
 * claimed by the scanner are executed through `executeRun`, with progress
 * persisted between phases (session-started / heartbeat / finish).
 */

import { randomUUID } from "crypto";

import { scanOnce } from "./due-task-scanner";
import { executeRun, createRealSessionStarter, type RunProgress, type SessionStarter } from "./pi-task-executor";
import { isRateLimitError } from "./rate-limit";
import { safeNotify, NoopTaskNotifier, type TaskNotifier } from "./task-notifier";
import { SqliteTaskStore } from "./sqlite-task-store";
import { ensureHubHome, getDbPath, getDbPathDisplay } from "./paths";
import { TaskService } from "./task-service";
import { SchedulerErrorCode } from "./errors";
import type { TaskStore } from "./task-store";
import type { SchedulerRuntimeStatus, TaskDefinition, TaskRun } from "./types";

const LEASE_NAME = "scheduler";
const LEASE_MS = 15_000; // lease validity
const LEASE_RENEW_MS = 5_000; // renewal cadence
const TICK_MS = 10_000; // scan frequency
const HEARTBEAT_TIMEOUT_MS = 90_000; // stale-run cutoff (3 missed heartbeats)
const MAX_CONCURRENCY = 1;

/**
 * Dispatches at most the currently available number of queued runs.
 * Kept outside the runtime class so the global concurrency invariant can be
 * tested without starting timers or opening the scheduler database.
 */
export function dispatchQueuedRuns(
  store: Pick<TaskStore, "listRuns" | "getRun">,
  activeCount: number,
  start: (run: TaskRun) => void,
  maxConcurrency = MAX_CONCURRENCY,
): number {
  const slots = Math.max(0, maxConcurrency - activeCount);
  if (slots === 0) return 0;

  let dispatched = 0;
  const queued = store.listRuns({ status: "queued", limit: slots });
  for (const summary of queued) {
    if (dispatched >= slots) break;
    const run = store.getRun(summary.id);
    if (!run || run.status !== "queued") continue;
    start(run);
    dispatched++;
  }
  return dispatched;
}

/** Short retry interval when a resume run finds its target session open in the
 *  browser (resume §9). Fixed — not user-configurable — because this is the
 *  resume safety net, not an opt-in policy. The user just needs a window to
 *  close the browser tab; 5 min keeps the retry responsive without spamming. */
export const SESSION_BUSY_RETRY_INTERVAL_MS = 5 * 60_000; // 5 minutes
/** Max session-busy retries before giving up (≈30 min total window). Bounded
 *  so a session left open indefinitely can't loop forever. */
export const MAX_SESSION_BUSY_ATTEMPTS = 6;

/** Outcome of {@link computeRecovery} — how to reschedule a failed run. */
export interface RecoveryDecision {
  /** UTC epoch ms for the next run. */
  nextRunAt: number;
  /** New consecutive-failure counter to persist. */
  attemptCount: number;
  /** Which recovery path matched (for logging / tests). */
  reason: "session_busy" | "rate_limit";
  /** The cap this path is bounded by (for logging). */
  cap: number;
}

/**
 * Pure decision: should `task` be auto-rescheduled after `run` failed, and if
 * so, with what nextRunAt / attemptCount? Returns null when the failure is
 * not recoverable, the cap is reached, the task is not a once task, or the
 * run was manually triggered (recovery preserves the *scheduler's* execution
 * plan; a manual run is an explicit user action they can re-trigger).
 *
 * Two recoverable paths:
 *  - **SESSION_BUSY** (resume §9): the target session is open in the browser.
 *    Reactivate with a short, fixed interval. This is the resume safety net —
 *    it does NOT depend on the opt-in retryOnRateLimit policy, because without
 *    it a once resume task would be permanently lost the moment the claim
 *    marked it completed (the claim advances a once task to `completed`
 *    before execution even starts).
 *  - **Rate-limit** (resume §11): only when the task opts in via
 *    retryOnRateLimit; honours the user-configured interval and cap.
 *
 * Only once tasks are rescued — a recurring task already advanced to its next
 * cycle during claim, so rescheduling would only overwrite that cadence.
 *
 * `attemptCount` semantics: consecutive recoverable failures (busy OR
 * rate-limit), reset to 0 on success. Shared between both paths; since a run
 * can only be one of them, the only cross-contamination is a task that first
 * hits busy a few times then rate-limits — which stops slightly earlier
 * (conservative, never excessive).
 */
export function computeRecovery(
  task: TaskDefinition,
  run: TaskRun,
  now: number,
): RecoveryDecision | null {
  // Only scheduled runs are auto-recovered. A manual trigger is the user's
  // explicit action — they're present to retry — so never reschedule it.
  if (run.triggerType !== "scheduled") return null;
  // Only once tasks need rescuing; recurring already advanced its schedule.
  if (task.schedule.scheduleType !== "once") return null;
  // attemptCount counts prior failures; this just-failed run is the
  // (attemptCount + 1)-th attempt.
  const attemptsSoFar = task.attemptCount + 1;

  // Session busy (resume §9): fixed short interval, fixed cap, NOT opt-in.
  if (run.errorCode === SchedulerErrorCode.SESSION_BUSY) {
    if (attemptsSoFar >= MAX_SESSION_BUSY_ATTEMPTS) return null;
    return {
      nextRunAt: now + SESSION_BUSY_RETRY_INTERVAL_MS,
      attemptCount: attemptsSoFar,
      reason: "session_busy",
      cap: MAX_SESSION_BUSY_ATTEMPTS,
    };
  }

  // Rate-limit (resume §11): opt-in policy with user interval + cap.
  if (
    task.retryOnRateLimit?.enabled &&
    isRateLimitError(run.errorMessage)
  ) {
    if (attemptsSoFar >= task.retryOnRateLimit.maxAttempts) return null;
    return {
      nextRunAt: now + task.retryOnRateLimit.intervalMinutes * 60_000,
      attemptCount: attemptsSoFar,
      reason: "rate_limit",
      cap: task.retryOnRateLimit.maxAttempts,
    };
  }

  return null;
}

interface RuntimeInternals {
  store: SqliteTaskStore;
  service: TaskService;
  notifier: TaskNotifier;
  ownerId: string;
  startSession: SessionStarter;
  /** In-process mutex check injected into executeRun for resume mode (§9). */
  isSessionInUse: (sessionId: string) => boolean;
  leaseTimer: ReturnType<typeof setInterval>;
  scanTimer: ReturnType<typeof setInterval>;
  lastTickAt: number;
  leader: boolean;
  /** Active cancellers keyed by run id (for cancel + stop). */
  active: Map<string, AbortController>;
  stopped: boolean;
  error: string | null;
}

declare global {
  var __piHubSchedulerRuntime: SchedulerRuntime | undefined;
}

export class SchedulerRuntime {
  private inner: RuntimeInternals | null = null;

  /** True once the runtime has been started (successfully or not). */
  get started(): boolean {
    return this.inner !== null;
  }

  /**
   * Starts the runtime. Idempotent within a process — subsequent calls return
   * the existing instance. Throws on migration/DB failure so the caller
   * (instrumentation.ts) can catch and keep the web server running with a
   * clearly-reported scheduler error state (§9.3).
   */
  async start(options?: {
    store?: SqliteTaskStore;
    startSession?: SessionStarter;
    notifier?: TaskNotifier;
    isSessionInUse?: (sessionId: string) => boolean;
  }): Promise<void> {
    if (this.inner) return;

    ensureHubHome();
    const store = options?.store ?? SqliteTaskStore.open(getDbPath());
    const service = new TaskService(store);
    const notifier = options?.notifier ?? new NoopTaskNotifier();

    // Stale-run recovery: any 'running' run whose heartbeat is stale belonged
    // to a previous process. Mark interrupted; do not re-run (§19).
    const recovered = store.markStaleRunningAsInterrupted(
      Date.now(),
      HEARTBEAT_TIMEOUT_MS,
    );
    if (recovered > 0) {
      console.warn(
        `[pi-hub:scheduler] marked ${recovered} stale run(s) as interrupted`,
      );
    }

    const ownerId = randomUUID();
    const isSessionInUse =
      options?.isSessionInUse ?? (await buildDefaultChecker());
    const inner: RuntimeInternals = {
      store,
      service,
      notifier,
      ownerId,
      startSession: options?.startSession ?? lazyStarter,
      isSessionInUse,
      leaseTimer: undefined as never,
      scanTimer: undefined as never,
      lastTickAt: 0,
      leader: false,
      active: new Map(),
      stopped: false,
      error: null,
    };
    this.inner = inner;

    // Attempt initial lease acquisition; non-fatal if not leader yet.
    inner.leader = store.tryAcquireLease(LEASE_NAME, ownerId, LEASE_MS);

    inner.leaseTimer = setInterval(() => this.renewLease(), LEASE_RENEW_MS);
    inner.scanTimer = setInterval(() => this.tick(), TICK_MS);

    // Kick an immediate scan so newly-started runtimes don't wait 10s.
    void this.tick();
    console.info(
      `[pi-hub:scheduler] started (leader=${inner.leader}, db=${getDbPathDisplay()})`,
    );
  }

  /** Stops timers and rejects active runs. Safe to call multiple times. */
  stop(): void {
    const inner = this.inner;
    if (!inner) return;
    inner.stopped = true;
    clearInterval(inner.leaseTimer);
    clearInterval(inner.scanTimer);
    for (const controller of inner.active.values()) {
      controller.abort();
    }
    inner.active.clear();
    try {
      inner.store.close();
    } catch {
      // ignore
    }
    this.inner = null;
    console.info("[pi-hub:scheduler] stopped");
  }

  /** Current status for /api/scheduler/status. */
  getStatus(): SchedulerRuntimeStatus {
    const inner = this.inner;
    if (!inner) {
      return {
        running: false,
        leader: false,
        ownerId: null,
        lastTickAt: null,
        nextTickAt: null,
        queuedRuns: 0,
        runningRuns: 0,
        maxConcurrency: MAX_CONCURRENCY,
        databasePath: getDbPathDisplay(),
        error: null,
      };
    }
    const queuedRuns = inner.store.countRuns({ status: "queued" });
    const runningRuns = inner.store.countRuns({ status: "running" });
    return {
      running: !inner.stopped,
      leader: inner.leader,
      ownerId: inner.ownerId,
      lastTickAt: inner.lastTickAt || null,
      nextTickAt: inner.lastTickAt ? inner.lastTickAt + TICK_MS : null,
      queuedRuns,
      runningRuns,
      maxConcurrency: MAX_CONCURRENCY,
      databasePath: getDbPathDisplay(),
      error: inner.error,
    };
  }

  /** Service accessor for API routes. */
  getTaskService(): TaskService {
    const inner = this.inner;
    if (!inner) {
      throw new Error("Scheduler runtime not started");
    }
    return inner.service;
  }

  /** Store accessor (file-access root registration, tests). */
  getStore(): TaskStore | null {
    return this.inner?.store ?? null;
  }

  // ---- internal ------------------------------------------------------------

  private renewLease(): void {
    const inner = this.inner;
    if (!inner || inner.stopped) return;
    const wasLeader = inner.leader;
    inner.leader = inner.store.renewLease(LEASE_NAME, inner.ownerId, LEASE_MS)
      || inner.store.tryAcquireLease(LEASE_NAME, inner.ownerId, LEASE_MS);
    if (wasLeader && !inner.leader) {
      console.warn("[pi-hub:scheduler] lost leader lease");
    } else if (!wasLeader && inner.leader) {
      console.info("[pi-hub:scheduler] acquired leader lease");
    }
  }

  private async tick(): Promise<void> {
    const inner = this.inner;
    if (!inner || inner.stopped) return;
    inner.lastTickAt = Date.now();
    if (!inner.leader) return; // only the leader scans/executes

    try {
      // Both scheduled claims and manual triggers enter the same persisted
      // queue. Dispatch only after scanning so every execution path observes
      // the same global concurrency limit.
      const { skipped } = scanOnce(inner.store, Date.now());
      this.drainQueued(inner);
      if (skipped.length) {
        console.debug(
          `[pi-hub:scheduler] skipped ${skipped.length} run(s) this tick`,
        );
      }
    } catch (error) {
      console.error(
        "[pi-hub:scheduler] tick failed",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Picks queued runs off the store (manual triggers land there) and runs them. */
  private drainQueued(inner: RuntimeInternals): void {
    if (inner.stopped || !inner.leader) return;
    dispatchQueuedRuns(
      inner.store,
      inner.active.size,
      (run) => { void this.execute(inner, run); },
    );
  }

  private async execute(inner: RuntimeInternals, run: TaskRun): Promise<void> {
    // Overlap guard: same task already running → skip this run.
    if (run.taskId) {
      const conflict = inner.store
        .listRuns({ taskId: run.taskId, status: "running", limit: 1 })
        .find((r) => r.id !== run.id);
      if (conflict) {
        inner.store.updateRun(run.id, {
          status: "skipped",
          finishedAt: Date.now(),
          errorCode: "TASK_ALREADY_RUNNING",
          errorMessage: `Another run for this task is already in progress (${conflict.id})`,
        });
        return;
      }
    }

    // Mark running + register canceller.
    const controller = new AbortController();
    inner.active.set(run.id, controller);
    inner.store.updateRun(run.id, {
      status: "running",
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    });
    const refreshed = inner.store.getRun(run.id) ?? run;
    await safeNotify(inner.notifier, "onRunStarted", {
      run: refreshed,
      taskName: refreshed.taskNameSnapshot,
    });

    const progress: RunProgress = {
      onSessionStarted: (sessionId) => {
        inner.store.updateRun(run.id, { sessionId, heartbeatAt: Date.now() });
      },
      onHeartbeat: () => {
        inner.store.updateRun(run.id, { heartbeatAt: Date.now() });
      },
      onFinish: (result) => {
        const finalStatus = result.status;
        inner.store.updateRun(run.id, {
          status: finalStatus,
          resultExcerpt: result.resultExcerpt,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          finishedAt: Date.now(),
        });
        const finished = inner.store.getRun(run.id);
        if (!finished) return;
        if (finalStatus === "success") {
          if (finished.taskId) inner.store.resetAttemptCount(finished.taskId);
          void safeNotify(inner.notifier, "onRunSucceeded", {
            run: finished,
            taskName: finished.taskNameSnapshot,
          });
        } else if (finalStatus === "failed") {
          // Recoverable-failure auto-reschedule (resume §9 / §11). Decide +
          // persist FIRST, then notify: a deferred (rescheduled) run emits
          // onRunDeferred (a soft "retrying" notice) instead of onRunFailed,
          // so the user isn't told the task terminally failed while it is
          // actually being retried. Only a terminal failure notifies failed.
          const decision = this.maybeRescheduleForRecovery(inner, finished);
          if (decision) {
            void safeNotify(inner.notifier, "onRunDeferred", {
              run: finished,
              taskName: finished.taskNameSnapshot,
              nextRunAt: decision.nextRunAt,
              reason: decision.reason,
            });
          } else {
            void safeNotify(inner.notifier, "onRunFailed", {
              run: finished,
              taskName: finished.taskNameSnapshot,
            });
          }
        }
      },
    };

    try {
      await executeRun(refreshed, {
        startSession: inner.startSession,
        progress,
        signal: controller.signal,
        isSessionInUse: inner.isSessionInUse,
      });
    } catch (error) {
      // executeRun is not supposed to throw, but guard the queue anyway.
      inner.store.updateRun(run.id, {
        status: "failed",
        errorCode: "PROMPT_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now(),
      });
    } finally {
      inner.active.delete(run.id);
      // Continue draining immediately instead of leaving the next persisted
      // run waiting for the 10-second scanner interval.
      this.drainQueued(inner);
    }
  }

  /**
   * Recoverable-failure auto-reschedule (resume §9 + §11). Delegates the
   * decision to the pure {@link computeRecovery} so it is unit-testable, then
   * persists it. Returns the decision so the caller can emit an
   * {@link TaskNotifier.onRunDeferred} notification; returns null for a
   * non-recoverable error, a reached cap, or a recurring/manual run (those
   * leave the run failed and notify onRunFailed).
   */
  private maybeRescheduleForRecovery(
    inner: RuntimeInternals,
    run: TaskRun,
  ): RecoveryDecision | null {
    if (!run.taskId) return null;
    const task = inner.store.getTask(run.taskId);
    if (!task) return null;
    const decision = computeRecovery(task, run, Date.now());
    if (!decision) return null;
    inner.store.rescheduleTask(
      run.taskId,
      decision.nextRunAt,
      decision.attemptCount,
    );
    console.info(
      `[pi-hub:scheduler] task ${run.taskId} rescheduled (${decision.reason}; attempt ${decision.attemptCount}/${decision.cap})`,
    );
    return decision;
  }
}

// ---- singleton accessors ----------------------------------------------------

/**
 * Starts (idempotently) and returns the process-wide runtime. The first call
 * opens the DB + begins scanning; later calls return the same instance.
 * Migration/DB failures are caught and reported via the runtime's status
 * (the web server keeps running, §9.3).
 */
export async function startSchedulerRuntime(options?: {
  notifier?: TaskNotifier;
}): Promise<SchedulerRuntime> {
  if (!globalThis.__piHubSchedulerRuntime) {
    const runtime = new SchedulerRuntime();
    try {
      await runtime.start(options?.notifier ? { notifier: options.notifier } : undefined);
      globalThis.__piHubSchedulerRuntime = runtime;
    } catch (error) {
      // Record the error but keep a runtime instance so status reflects it.
      globalThis.__piHubSchedulerRuntime = makeFailedRuntime(
        error instanceof Error ? error.message : String(error),
      );
      console.error(
        "[pi-hub:scheduler] init failed — web server continues without scheduler",
        error,
      );
    }
  }
  return globalThis.__piHubSchedulerRuntime;
}

/** Builds a runtime instance whose status reports `error` and nothing else. */
function makeFailedRuntime(error: string): SchedulerRuntime {
  const failed = new SchedulerRuntime();
  // Stamp an error-only payload onto the private slot so getStatus() surfaces it.
  const stub: RuntimeInternals = {
    store: undefined as never,
    service: undefined as never,
    notifier: new NoopTaskNotifier(),
    ownerId: "",
    startSession: undefined as never,
    isSessionInUse: () => false,
    leaseTimer: undefined as never,
    scanTimer: undefined as never,
    lastTickAt: 0,
    leader: false,
    active: new Map(),
    stopped: true,
    error,
  };
  (failed as unknown as { inner: RuntimeInternals | null }).inner = stub;
  return failed;
}

/** Returns the current runtime (may be a failed/stopped instance). */
export function getSchedulerRuntime(): SchedulerRuntime | undefined {
  return globalThis.__piHubSchedulerRuntime;
}

// ---- default session starter (lazy import to keep Edge bundles clean) ------

// ---- default session-in-use checker (lazy import of rpc-manager) ------

let defaultSessionChecker: ((sessionId: string) => boolean) | null = null;
async function buildDefaultChecker(): Promise<(sessionId: string) => boolean> {
  if (defaultSessionChecker) return defaultSessionChecker;
  // Dynamic import so the scheduler module stays loadable in non-Pi test
  // contexts without pulling the full rpc-manager graph at module load time.
  const { getRpcSession } = await import("@/lib/rpc-manager");
  defaultSessionChecker = (sessionId: string) =>
    Boolean(getRpcSession(sessionId)?.isAlive());
  return defaultSessionChecker;
}

let defaultSessionStarter: SessionStarter | null = null;
async function buildDefaultStarter(): Promise<SessionStarter> {
  if (defaultSessionStarter) return defaultSessionStarter;
  // Dynamic import so the scheduler module can be loaded in non-Pi contexts
  // (e.g. tests) without pulling the full rpc-manager graph.
  const { startRpcSession } = await import("@/lib/rpc-manager");
  defaultSessionStarter = createRealSessionStarter(
    startRpcSession as never,
  );
  return defaultSessionStarter;
}

/** Proxy starter that resolves the real one lazily on first use. */
const lazyStarter: SessionStarter = async (...args) =>
  (await buildDefaultStarter())(...args);
