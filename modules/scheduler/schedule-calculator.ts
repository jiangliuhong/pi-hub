/**
 * Timezone-aware schedule calculation for the Pi Hub scheduler.
 *
 * Pure functions — no I/O, no database. This keeps scheduling logic in one
 * place (design doc §11.2) so the API, scanner, and tests all agree.
 *
 * Strategy for converting "local wall-clock time in an IANA zone" to UTC:
 * we synthesize a fixed-format local timestamp string, then use
 * `Intl.DateTimeFormat` to validate the zone and `Date` parsing on a
 * constructed ISO string that *claims* UTC to recover the epoch, then offset
 * by the zone's actual offset for that instant. This avoids pulling in a
 * cron/tz library and correctly handles DST gaps and folds.
 */

import { CronExpressionParser } from "cron-parser";

import { SchedulerError, SchedulerErrorCode } from "./errors";
import type {
  DailyScheduleInput,
  OnceScheduleInput,
  PersistedSchedule,
  ScheduleInput,
} from "./types";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** Max accepted cron expression length (design doc: ≤ 256 chars). */
const MAX_CRON_LENGTH = 256;
/**
 * Tokens cron-parser accepts (L, #) but Pi Hub does NOT support (design doc:
 * no Quartz L/W/# or Jenkins H). W and H are also rejected by cron-parser,
 * but listing them here yields a clearer error before parsing even starts.
 */
const UNSUPPORTED_CRON_TOKEN = /[LWH#]/;

/** Returns the IANA offset (minutes east of UTC) for `epochMs` in `zone`. */
export function offsetMinutesForZone(epochMs: number, zone: string): number {
  // Format the instant in the target zone and read back the offset field.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Construct what the UTC epoch WOULD be if these local parts were UTC.
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asUtc - epochMs) / 60000);
}

/** Throws if `zone` is not a valid IANA timezone identifier. */
export function assertValidTimezone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_TIMEZONE,
      `Invalid timezone: ${zone}`,
    );
  }
}

function assertValidDaily(input: DailyScheduleInput): void {
  assertValidTimezone(input.timezone);
  if (!TIME_REGEX.test(input.time)) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid daily time: ${input.time} (expected HH:MM)`,
    );
  }
}

function assertValidOnce(input: OnceScheduleInput): void {
  assertValidTimezone(input.timezone);
  if (!LOCAL_DATETIME_REGEX.test(input.localDateTime)) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid once datetime: ${input.localDateTime} (expected YYYY-MM-DDTHH:MM[:SS])`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local-time → epoch conversion
// ---------------------------------------------------------------------------

/**
 * Converts local wall-clock Y/M/D/H/M/S in `zone` to a UTC epoch ms.
 *
 * Handles DST fold (ambiguous time — returns the earlier/first occurrence,
 * matching "run as soon as the clock reaches this time") and DST gap
 * (non-existent time — falls forward to the first real instant after it).
 */
function localToEpoch(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): number {
  // First guess: pretend the local fields are UTC. Compute the offset of that
  // instant in the zone, then subtract it to get the true epoch.
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = offsetMinutesForZone(guessUtc, zone);
  let epoch = guessUtc - offset * 60000;

  // DST gap fix: if the offset at the corrected instant differs from the
  // offset we applied, the local time didn't exist. Fall forward by
  // re-deriving from the corrected instant.
  const offset2 = offsetMinutesForZone(epoch, zone);
  if (offset2 !== offset) {
    epoch = guessUtc - offset2 * 60000;
  }
  return epoch;
}

/**
 * Cron-style expression for a daily task: "M H * * *" with unpadded numeric
 * fields (e.g. "0 8 * * *" for 08:00), matching design doc §11.2. cron-parser
 * accepts both padded and unpadded forms.
 */
export function cronFromDaily(time: string): string {
  const m = TIME_REGEX.exec(time);
  if (!m) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_SCHEDULE,
      `Invalid daily time: ${time}`,
    );
  }
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

// ---------------------------------------------------------------------------
// Standard 5-field cron (design doc §"Cron 解析")
// ---------------------------------------------------------------------------

/**
 * Validates + normalizes a 5-field cron expression.
 *
 * Enforces the design-doc restrictions: non-empty, ≤ 256 chars, exactly five
 * whitespace-separated fields (so 6-field seconds expressions are rejected),
 * no Quartz L/W/# or Jenkins H tokens, and syntactic validity via
 * cron-parser. Returns the whitespace-normalized string.
 */
export function validateCronExpression(expression: string): string {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      "Cron expression is required",
    );
  }
  const normalized = expression.trim().replace(/\s+/g, " ");
  if (normalized.length > MAX_CRON_LENGTH) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Cron expression too long (max ${MAX_CRON_LENGTH} chars)`,
    );
  }
  const fields = normalized.split(" ");
  if (fields.length !== 5) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}`,
    );
  }
  if (UNSUPPORTED_CRON_TOKEN.test(normalized)) {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      "Cron expression uses an unsupported token (L/W/#/H are not supported)",
    );
  }
  try {
    CronExpressionParser.parse(normalized, { tz: "UTC" });
  } catch {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Invalid cron expression: ${expression}`,
    );
  }
  return normalized;
}

/**
 * Computes the next UTC epoch ms a cron expression fires, strictly after
 * `afterMs`. Timezone + DST handling is delegated to cron-parser.
 */
export function nextCronRun(
  expression: string,
  timezone: string,
  afterMs: number,
): number {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(afterMs),
    tz: timezone,
  });
  return interval.next().toDate().getTime();
}

/** Computes the next `count` run times (UTC epoch ms), strictly after afterMs. */
export function nextCronRuns(
  expression: string,
  timezone: string,
  afterMs: number,
  count: number,
): number[] {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(afterMs),
    tz: timezone,
  });
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(interval.next().toDate().getTime());
  }
  return out;
}

/**
 * True iff `cron` is a simple daily pattern "M H * * *" (single literal
 * minute + hour). Used by the DTO layer to map a persisted recurring task
 * back to the "daily" UI kind instead of the generic "cron" kind.
 */
export function isDailyCronPattern(
  cron: string | null | undefined,
): boolean {
  if (!cron) return false;
  return /^\d{1,2} \d{1,2} \* \* \*$/.test(cron.trim());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedSchedule {
  scheduleType: "recurring" | "once";
  cronExpression: string | null;
  executeAt: number | null;
  timezone: string;
  /** First next-run time (UTC epoch ms). */
  nextRunAt: number;
}

/** Validates input and computes the persisted schedule + first next run. */
export function resolveSchedule(input: ScheduleInput): ResolvedSchedule {
  if (input.type === "daily") {
    assertValidDaily(input);
    const cron = cronFromDaily(input.time);
    const next = nextCronRun(cron, input.timezone, Date.now());
    return {
      scheduleType: "recurring",
      cronExpression: cron,
      executeAt: null,
      timezone: input.timezone,
      nextRunAt: next,
    };
  }
  if (input.type === "cron") {
    assertValidTimezone(input.timezone);
    const cron = validateCronExpression(input.cronExpression);
    const next = nextCronRun(cron, input.timezone, Date.now());
    return {
      scheduleType: "recurring",
      cronExpression: cron,
      executeAt: null,
      timezone: input.timezone,
      nextRunAt: next,
    };
  }
  assertValidOnce(input);
  const [datePart, timePart] = input.localDateTime.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, se = 0] = timePart.split(":").map(Number);
  const executeAt = localToEpoch(y, mo, d, h, mi, se, input.timezone);
  return {
    scheduleType: "once",
    cronExpression: null,
    executeAt,
    timezone: input.timezone,
    nextRunAt: executeAt,
  };
}

/**
 * Computes the next run for an already-persisted task, at or strictly after
 * `afterMs`. For once-tasks returns `executeAt` (which may be in the past).
 * For recurring tasks the stored 5-field cron (daily or general) is evaluated
 * via cron-parser in the task's own timezone (DST-aware).
 */
export function calculateNextRun(
  schedule: PersistedSchedule,
  afterMs: number,
): number {
  if (schedule.scheduleType === "once") {
    return schedule.executeAt ?? afterMs;
  }
  try {
    return nextCronRun(
      schedule.cronExpression ?? "",
      schedule.timezone,
      afterMs,
    );
  } catch {
    throw new SchedulerError(
      SchedulerErrorCode.INVALID_CRON,
      `Unsupported or invalid cron expression: ${schedule.cronExpression}`,
    );
  }
}

/** True if a due task is within its misfire grace window. */
export function withinMisfireGrace(
  dueAt: number,
  now: number,
  graceSeconds: number,
): boolean {
  return now - dueAt <= graceSeconds * 1000;
}

/**
 * Preview helper for the UI: returns the next-run instant for a schedule
 * input plus its human-readable local + UTC forms and a few upcoming run
 * times. Pure / synchronous.
 */
export interface PreviewResult {
  nextRunAt: number;
  localDisplay: string;
  utcDisplay: string;
  /** Upcoming UTC epoch-ms run times (length depends on `runCount`). */
  nextRuns: number[];
}

export function previewNextRun(
  input: ScheduleInput,
  runCount = 3,
): PreviewResult {
  const resolved = resolveSchedule(input);
  const localDisplay = formatZoned(resolved.nextRunAt, input.timezone);
  const utcDisplay = formatUtc(resolved.nextRunAt);
  // Derive the upcoming series from the already-resolved first run so
  // nextRuns[0] always equals nextRunAt (avoids a second Date.now() that
  // could straddle a cron boundary). For recurring tasks we ask cron-parser
  // for the runs strictly after nextRunAt and prepend it.
  const nextRuns =
    resolved.scheduleType === "once"
      ? [resolved.nextRunAt]
      : [
          resolved.nextRunAt,
          ...nextCronRuns(
            resolved.cronExpression ?? "",
            input.timezone,
            resolved.nextRunAt,
            runCount - 1,
          ),
        ];
  return { nextRunAt: resolved.nextRunAt, localDisplay, utcDisplay, nextRuns };
}

const PAD = (n: number) => n.toString().padStart(2, "0");

function formatUtc(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${PAD(d.getUTCMonth() + 1)}-${PAD(
    d.getUTCDate(),
  )} ${PAD(d.getUTCHours())}:${PAD(d.getUTCMinutes())} UTC`;
}

function formatZoned(epochMs: number, zone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour") === "24" ? "00" : get("hour")}:${get("minute")} ${zone}`;
}
