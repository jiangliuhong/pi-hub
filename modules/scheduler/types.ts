/**
 * Pi Hub scheduler domain types.
 *
 * These types describe the persistence + business layer. The API layer
 * (DTOs) and the frontend mirror live in `app/api/...` route handlers and
 * `lib/scheduler-client.ts` respectively, converting epoch-ms timestamps
 * to/from ISO strings and flattening schedule fields.
 *
 * All timestamps are Unix epoch milliseconds stored as UTC (INTEGER column).
 * Per design doc §11.1: times are interpreted using each task's own IANA
 * timezone, never a fixed UTC offset.
 */

// ---------------------------------------------------------------------------
// Enums (as string-literal unions; persisted as TEXT with CHECK constraints)
// ---------------------------------------------------------------------------

export type ScheduleType = "recurring" | "once";
/** Front-end facing schedule kinds (mapped to ScheduleType at the API edge). */
export type ScheduleKind = "daily" | "once";

export type TaskStatus = "active" | "paused" | "completed";

export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "skipped"
  | "missed";

export type TriggerType = "scheduled" | "manual";

/** V1 only supports "skip". Kept as a field so the schema is forward-compatible. */
export type OverlapPolicy = "skip";

export type MisfirePolicy = "run_once" | "skip";

// ---------------------------------------------------------------------------
// Schedule input (what the UI/API submits — local time + timezone)
// ---------------------------------------------------------------------------

/** Daily schedule input: local HH:MM in the given IANA timezone. */
export interface DailyScheduleInput {
  type: "daily";
  time: string; // "HH:MM"
  timezone: string; // IANA, e.g. "Asia/Singapore"
}

/**
 * Standard 5-field cron schedule input, interpreted in the given IANA
 * timezone. Persisted as `scheduleType: "recurring"` with `cronExpression`
 * set and `executeAt` null (design doc §"数据模型").
 */
export interface CronScheduleInput {
  type: "cron";
  /** 5-field cron: "minute hour day-of-month month day-of-week". */
  cronExpression: string;
  timezone: string;
}

/** One-time schedule input: local date-time in the given IANA timezone. */
export interface OnceScheduleInput {
  type: "once";
  /** Local wall-clock datetime without timezone, e.g. "2026-08-08T10:00:00". */
  localDateTime: string;
  timezone: string;
}

export type ScheduleInput =
  | DailyScheduleInput
  | CronScheduleInput
  | OnceScheduleInput;

/** Persisted schedule representation (mirrors scheduled_tasks columns). */
export interface PersistedSchedule {
  scheduleType: ScheduleType;
  /** For recurring: 5-field cron in the task timezone, e.g. "0 8 * * *". */
  cronExpression: string | null;
  /** For once: UTC epoch ms. */
  executeAt: number | null;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Execution configuration (model / thinking / tools / timeouts)
// ---------------------------------------------------------------------------

export interface ExecutionOptions {
  /** Optional pinned model; null/undefined = use session default. */
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  /** Allowed tool names; empty = tools disabled. */
  toolNames: string[];
  /** Maximum run duration in seconds. */
  timeoutSeconds: number;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

// ---------------------------------------------------------------------------
// Resume target (resume mode — continue an existing session)
// ---------------------------------------------------------------------------

/**
 * When set, the task runs in RESUME MODE: instead of creating a fresh Pi
 * session each run, it opens the referenced session file and continues the
 * conversation. Used to recover runs interrupted by provider rate limits.
 *
 * Design: docs/pi-hub/scheduled-execution-resume-design.zh-CN.md.
 */
export interface ResumeTarget {
  /** Absolute path of the session .jsonl file to continue. */
  sessionFile: string;
  /** Redundant session id — used for the in-process mutex check (§9). */
  sessionId: string;
  /**
   * Override the resumed session's model. startRpcSession ignores
   * initialModel for sessions with existing messages (§10), so the executor
   * issues an explicit set_model after startup when these are set.
   */
  provider?: string | null;
  modelId?: string | null;
}

/**
 * Optional auto-reschedule on rate-limit failures (resume §11). When enabled,
 * a run that fails with a rate-limit error is rescheduled after
 * `intervalMinutes`, up to `maxAttempts` times.
 */
export interface RetryOnRateLimit {
  enabled: boolean;
  /** Reschedule interval in minutes, e.g. 300 = 5 hours. */
  intervalMinutes: number;
  /** Max attempts including the first; further failures stop rescheduling. */
  maxAttempts: number;
}

// ---------------------------------------------------------------------------
// Core persisted entities
// ---------------------------------------------------------------------------

export interface TaskDefinition {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  schedule: PersistedSchedule;
  /** UTC epoch ms of the next due time, or null when paused/completed. */
  nextRunAt: number | null;
  execution: ExecutionOptions;
  /** Non-null ⇒ resume mode; null/undefined ⇒ V1 "create a new session each run". */
  resume?: ResumeTarget | null;
  /** Optional auto-reschedule on rate-limit failures (resume §11). */
  retryOnRateLimit?: RetryOnRateLimit | null;
  /** Consecutive rate-limit failures; reset to 0 on success. */
  attemptCount: number;

  status: TaskStatus;
  overlapPolicy: OverlapPolicy;
  misfirePolicy: MisfirePolicy;
  misfireGraceSeconds: number;

  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Optimistic-lock version; bumped on every successful mutation. */
  revision: number;
}

export interface TaskRun {
  id: string;
  /** FK to scheduled_tasks; null after the task is deleted (history kept). */
  taskId: string | null;
  /** UNIQUE — prevents the same planned time from being triggered twice. */
  dedupeKey: string;

  // Snapshot of the task at execution time so history stays interpretable
  // after the task is edited or deleted (design doc §10.2).
  taskNameSnapshot: string;
  promptSnapshot: string;
  cwdSnapshot: string;
  scheduleSnapshotJson: string;
  executionOptionsSnapshotJson: string;
  /** Snapshot of the task's resume target at claim time; null = new-session run. */
  resumeSnapshotJson: string | null;

  triggerType: TriggerType;
  /** Planned execution time (UTC epoch ms). */
  scheduledFor: number;

  status: RunStatus;
  /** Pi session id, once the agent session is created. */
  sessionId: string | null;
  /** Final assistant text excerpt (≤ 4000 chars). */
  resultExcerpt: string | null;
  errorCode: string | null;
  errorMessage: string | null;

  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Last heartbeat while running; used to detect stale runs after restart. */
  heartbeatAt: number | null;
  createdAt: number;
}

/** Subset of TaskRun surfaced in list views (avoids heavy snapshot fields). */
export interface TaskRunSummary {
  id: string;
  taskId: string | null;
  taskNameSnapshot: string;
  triggerType: TriggerType;
  scheduledFor: number;
  status: RunStatus;
  sessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// Input DTOs (used by TaskService)
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  name: string;
  prompt: string;
  cwd: string;
  schedule: ScheduleInput;
  execution: ExecutionOptions;
  /** Optional resume target; omit for the default new-session behavior. */
  resume?: ResumeTarget | null;
  /** Optional rate-limit auto-reschedule policy. */
  retryOnRateLimit?: RetryOnRateLimit | null;
}

export interface UpdateTaskPatch {
  name?: string;
  prompt?: string;
  cwd?: string;
  schedule?: ScheduleInput;
  execution?: Partial<ExecutionOptions>;
  /** undefined ⇒ unchanged; null ⇒ clear (revert to new-session mode); object ⇒ set. */
  resume?: ResumeTarget | null;
  /** undefined ⇒ unchanged; null ⇒ clear; object ⇒ set. */
  retryOnRateLimit?: RetryOnRateLimit | null;
  status?: TaskStatus;
  /** Caller's current revision; mismatch → 409 Conflict. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Scheduler runtime status (returned by /api/scheduler/status)
// ---------------------------------------------------------------------------

export interface SchedulerRuntimeStatus {
  running: boolean;
  leader: boolean;
  ownerId: string | null;
  lastTickAt: number | null;
  nextTickAt: number | null;
  queuedRuns: number;
  runningRuns: number;
  maxConcurrency: number;
  databasePath: string;
  /** Non-null when the scheduler failed to start (migration error, etc.). */
  error: string | null;
}
