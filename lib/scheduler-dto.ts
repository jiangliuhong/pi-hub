/**
 * Shared DTO + error helpers for the Pi Hub scheduler API routes.
 *
 * The scheduler domain layer uses epoch-ms numbers and nested schedule
 * objects; the HTTP layer uses ISO strings and the flat-ish shapes the
 * frontend expects. Keeping the conversion in one place keeps route
 * handlers thin and ensures the wire contract is consistent.
 *
 * This module is server-only (imports NextResponse).
 */

import { NextResponse } from "next/server";

import {
  SchedulerError,
  isDailyCronPattern,
  type TaskDefinition,
  type TaskRun,
  type TaskRunSummary,
  type ExecutionOptions,
  type SchedulerRuntimeStatus,
} from "@/modules/scheduler";

// ---------------------------------------------------------------------------
// epoch ms <-> ISO string
// ---------------------------------------------------------------------------

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Domain -> wire DTOs
// ---------------------------------------------------------------------------

export interface ScheduleDto {
  type: "daily" | "cron" | "once";
  /** Local time for daily, e.g. "08:00". */
  time?: string;
  /** Local date-time for once, e.g. "2026-08-08T10:00:00". */
  localDateTime?: string;
  /** Cron expression for cron, e.g. a 5-field minute-hour-day-month-weekday expr. */
  cronExpression?: string;
  timezone: string;
}

/**
 * Derives the frontend-facing schedule from a persisted task. A recurring
 * task whose cron is a simple "M H * * *" maps to "daily"; any other
 * recurring cron maps to "cron".
 */
export function scheduleToDto(task: TaskDefinition): ScheduleDto {
  if (task.schedule.scheduleType === "recurring") {
    const cron = task.schedule.cronExpression ?? "";
    if (isDailyCronPattern(cron)) {
      // "M H * * *" -> parse hour/minute for the daily UI control.
      const parts = cron.split(/\s+/);
      const minute = parts[0] ?? "0";
      const hour = parts[1] ?? "0";
      return {
        type: "daily",
        time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
        timezone: task.schedule.timezone,
      };
    }
    return {
      type: "cron",
      cronExpression: cron,
      timezone: task.schedule.timezone,
    };
  }
  // once: reconstruct local date-time in the task timezone
  const executeAt = task.schedule.executeAt ?? task.nextRunAt ?? 0;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: task.schedule.timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(executeAt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    type: "once",
    localDateTime: `${get("year")}-${get("month")}-${get("day")}T${hour}:${get(
      "minute",
    )}:${get("second")}`,
    timezone: task.schedule.timezone,
  };
}

export interface ExecutionDto {
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  toolNames: string[];
  timeoutSeconds: number;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

export function executionToDto(e: ExecutionOptions): ExecutionDto {
  return { ...e };
}

export interface ResumeTargetDto {
  sessionFile: string;
  sessionId: string;
  provider?: string | null;
  modelId?: string | null;
}

export interface RetryOnRateLimitDto {
  enabled: boolean;
  intervalMinutes: number;
  maxAttempts: number;
}

export interface TaskDto {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  schedule: ScheduleDto;
  execution: ExecutionDto;
  /** Non-null ⇒ resume mode (continue an existing session). */
  resume?: ResumeTargetDto | null;
  /** Optional rate-limit auto-reschedule policy. */
  retryOnRateLimit?: RetryOnRateLimitDto | null;
  /** Consecutive rate-limit failures (read-only on the client). */
  attemptCount: number;
  status: TaskDefinition["status"];
  misfirePolicy: TaskDefinition["misfirePolicy"];
  misfireGraceSeconds: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  lastRun?: RunSummaryDto | null;
}

export function taskToDto(
  task: TaskDefinition,
  lastRun?: TaskRunSummary | null,
): TaskDto {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    schedule: scheduleToDto(task),
    execution: executionToDto(task.execution),
    resume: task.resume ?? null,
    retryOnRateLimit: task.retryOnRateLimit ?? null,
    attemptCount: task.attemptCount,
    status: task.status,
    misfirePolicy: task.misfirePolicy,
    misfireGraceSeconds: task.misfireGraceSeconds,
    nextRunAt: iso(task.nextRunAt),
    lastRunAt: iso(task.lastRunAt),
    createdAt: iso(task.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(task.updatedAt) ?? new Date(0).toISOString(),
    revision: task.revision,
    lastRun: lastRun ? runSummaryToDto(lastRun) : null,
  };
}

export interface RunSummaryDto {
  id: string;
  taskId: string | null;
  taskNameSnapshot: string;
  triggerType: TaskRun["triggerType"];
  scheduledFor: string;
  status: TaskRun["status"];
  sessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function runSummaryToDto(run: TaskRunSummary): RunSummaryDto {
  return {
    id: run.id,
    taskId: run.taskId,
    taskNameSnapshot: run.taskNameSnapshot,
    triggerType: run.triggerType,
    scheduledFor: iso(run.scheduledFor) ?? "",
    status: run.status,
    sessionId: run.sessionId,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    queuedAt: iso(run.queuedAt) ?? "",
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
  };
}

export interface RunDetailDto extends RunSummaryDto {
  promptSnapshot: string;
  cwdSnapshot: string;
  resultExcerpt: string | null;
  durationMs: number | null;
  heartbeatAt: string | null;
}

export function runToDto(run: TaskRun): RunDetailDto {
  const finishedAt = run.finishedAt ?? null;
  const startedAt = run.startedAt ?? null;
  const durationMs =
    finishedAt != null && startedAt != null ? finishedAt - startedAt : null;
  return {
    ...runSummaryToDto(run),
    promptSnapshot: run.promptSnapshot,
    cwdSnapshot: run.cwdSnapshot,
    resultExcerpt: run.resultExcerpt,
    durationMs,
    heartbeatAt: iso(run.heartbeatAt),
  };
}

export interface SchedulerStatusDto {
  running: boolean;
  leader: boolean;
  ownerId: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  queuedRuns: number;
  runningRuns: number;
  maxConcurrency: number;
  databasePath: string;
  error: string | null;
}

export function schedulerStatusToDto(
  s: SchedulerRuntimeStatus,
): SchedulerStatusDto {
  return {
    ...s,
    lastTickAt: iso(s.lastTickAt),
    nextTickAt: iso(s.nextTickAt),
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** Converts a thrown value into a NextResponse JSON error. */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof SchedulerError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  return NextResponse.json(
    { error: String(error) },
    { status: 500 },
  );
}
