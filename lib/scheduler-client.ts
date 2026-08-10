/**
 * Typed client for the Pi Hub scheduler API.
 *
 * Browser-side fetch helper mirroring the shapes returned by the route DTOs
 * (`lib/scheduler-dto.ts`). All timestamps arrive as ISO strings. Throws an
 * Error whose `message` is the server's `error` field on non-2xx responses,
 * so callers can surface failures in the UI.
 */

// ---------------------------------------------------------------------------
// Wire types (mirror of lib/scheduler-dto.ts DTOs)
// ---------------------------------------------------------------------------

export interface ScheduleDto {
  type: "daily" | "cron" | "once";
  time?: string;
  localDateTime?: string;
  cronExpression?: string;
  timezone: string;
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
  /** Consecutive rate-limit failures (read-only). */
  attemptCount: number;
  status: "active" | "paused" | "completed";
  misfirePolicy: "run_once" | "skip";
  misfireGraceSeconds: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  lastRun?: RunSummaryDto | null;
}

export interface RunSummaryDto {
  id: string;
  taskId: string | null;
  taskNameSnapshot: string;
  triggerType: "scheduled" | "manual";
  scheduledFor: string;
  status:
    | "queued"
    | "running"
    | "success"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "skipped"
    | "missed";
  sessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetailDto extends RunSummaryDto {
  promptSnapshot: string;
  cwdSnapshot: string;
  resultExcerpt: string | null;
  durationMs: number | null;
  heartbeatAt: string | null;
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
  databasePath: string | null;
  error: string | null;
}

export interface PreviewResultDto {
  nextRunAt: string;
  localDisplay: string;
  utcDisplay: string;
  /** Upcoming run times (ISO strings). */
  nextRuns?: string[];
}

export interface CreateTaskPayload {
  name: string;
  cwd: string;
  prompt: string;
  schedule: ScheduleDto;
  execution?: Partial<ExecutionDto>;
  resume?: ResumeTargetDto | null;
  retryOnRateLimit?: RetryOnRateLimitDto | null;
}

export interface UpdateTaskPayload {
  name?: string;
  cwd?: string;
  prompt?: string;
  schedule?: ScheduleDto;
  execution?: Partial<ExecutionDto>;
  resume?: ResumeTargetDto | null;
  retryOnRateLimit?: RetryOnRateLimitDto | null;
  status?: TaskDto["status"];
  revision: number;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    [k: string]: unknown;
  };
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body as unknown as T;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export function listTasks(filter?: {
  status?: TaskDto["status"];
}): Promise<{ items: TaskDto[]; total: number }> {
  const qs = filter?.status ? `?status=${encodeURIComponent(filter.status)}` : "";
  return request(`/api/tasks${qs}`);
}

export function getTask(id: string): Promise<TaskDto> {
  return request(`/api/tasks/${encodeURIComponent(id)}`);
}

export function createTask(payload: CreateTaskPayload): Promise<TaskDto> {
  return request(`/api/tasks`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTask(
  id: string,
  payload: UpdateTaskPayload,
): Promise<TaskDto> {
  return request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteTask(id: string): Promise<{ success: boolean }> {
  return request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function triggerRun(
  id: string,
): Promise<{ runId: string; status: string; created: boolean }> {
  return request(`/api/tasks/${encodeURIComponent(id)}/run`, {
    method: "POST",
  });
}

export function listRuns(
  taskId: string,
): Promise<{ items: RunSummaryDto[]; total: number }> {
  return request(
    `/api/task-runs?taskId=${encodeURIComponent(taskId)}`,
  );
}

export function getRun(id: string): Promise<RunDetailDto> {
  return request(`/api/task-runs/${encodeURIComponent(id)}`);
}

export function cancelRun(id: string): Promise<RunDetailDto> {
  return request(`/api/task-runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
}

export function getSchedulerStatus(): Promise<SchedulerStatusDto> {
  return request(`/api/scheduler/status`);
}

export function previewSchedule(
  schedule: ScheduleDto,
): Promise<PreviewResultDto> {
  return request(`/api/scheduler/preview`, {
    method: "POST",
    body: JSON.stringify({ schedule }),
  });
}
