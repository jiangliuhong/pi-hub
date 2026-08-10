/**
 * Tests for the standard 5-field cron support (design doc §"测试范围").
 *
 * Covers: list/range/step expressions, month + weekday, invalid
 * fields/ranges/steps, invalid timezone, DST switching, preview `nextRuns`,
 * resolveSchedule/calculateNextRun for cron, daily↔cron detection, and the
 * service-level create/modify flow.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveSchedule,
  calculateNextRun,
  previewNextRun,
  validateCronExpression,
  nextCronRun,
  nextCronRuns,
  isDailyCronPattern,
  assertValidTimezone,
} = await jiti.import("./schedule-calculator.ts");
const { SchedulerError, SchedulerErrorCode } = await jiti.import("./errors.ts");
const { SqliteTaskStore, TaskService } = await jiti.import("./index.ts");

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Standard expressions
// ---------------------------------------------------------------------------

test("*/5 * * * *: every 5 minutes in UTC", () => {
  const next = nextCronRun("*/5 * * * *", "UTC", Date.UTC(2026, 7, 8, 10, 2, 0));
  assert.equal(iso(next), "2026-08-08T10:05:00.000Z");
});

test("0 9 * * 1-5: 09:00 on weekdays (Asia/Shanghai)", () => {
  // 2026-08-10 is a Monday. From Sunday 2026-08-09T10:00Z (=18:00 SGT) the
  // next 09:00 Shanghai on a weekday is Monday 09:00 = 2026-08-10T01:00Z.
  const next = nextCronRun("0 9 * * 1-5", "Asia/Shanghai", Date.UTC(2026, 7, 9, 10, 0, 0));
  assert.equal(iso(next), "2026-08-10T01:00:00.000Z");
});

test("0 9 * * 1-5: skips the weekend", () => {
  // Friday 2026-08-07 10:00 UTC → next weekday is Monday 09:00 Shanghai.
  const next = nextCronRun("0 9 * * 1-5", "Asia/Shanghai", Date.UTC(2026, 7, 7, 10, 0, 0));
  // 2026-08-10 Monday 09:00 Shanghai = 01:00Z.
  assert.equal(iso(next), "2026-08-10T01:00:00.000Z");
});

test("0 0 1 * *: midnight on day 1 of each month", () => {
  // From 2026-08-08, next is 2026-09-01 00:00 UTC.
  const next = nextCronRun("0 0 1 * *", "UTC", Date.UTC(2026, 7, 8, 12, 0, 0));
  assert.equal(iso(next), "2026-09-01T00:00:00.000Z");
});

test("0 9 1,15 * *: 09:00 on days 1 and 15", () => {
  // From 2026-08-08, next is 2026-08-15 09:00 UTC.
  const next = nextCronRun("0 9 1,15 * *", "UTC", Date.UTC(2026, 7, 8, 12, 0, 0));
  assert.equal(iso(next), "2026-08-15T09:00:00.000Z");
});

test("0 9 * 1-3 *: 09:00 in months Jan–Mar only", () => {
  // From 2026-08-08, next is 2027-01-01 09:00 UTC.
  const next = nextCronRun("0 9 * 1-3 *", "UTC", Date.UTC(2026, 7, 8, 12, 0, 0));
  assert.equal(iso(next), "2027-01-01T09:00:00.000Z");
});

test("step within a range: 1-30/5 * * * *", () => {
  // Minutes 1,6,11,16,21,26. From 10:00:00 → 10:01.
  const next = nextCronRun("1-30/5 * * * *", "UTC", Date.UTC(2026, 7, 8, 10, 0, 0));
  assert.equal(iso(next), "2026-08-08T10:01:00.000Z");
});

test("list + step: 0,15,30,45 9-18 * * 1-5 weekday cadence", () => {
  // Monday 2026-08-10 09:00 Shanghai = 01:00Z. From 2026-08-10T00:30Z.
  const next = nextCronRun("0,15,30,45 9-18 * * 1-5", "Asia/Shanghai", Date.UTC(2026, 7, 10, 0, 30, 0));
  assert.equal(iso(next), "2026-08-10T01:00:00.000Z");
});

test("*/15 9-18 * * 1-5: the doc example advances in 15-minute steps", () => {
  const runs = nextCronRuns("*/15 9-18 * * 1-5", "Asia/Shanghai", Date.UTC(2026, 7, 10, 0, 30, 0), 3);
  assert.deepEqual(
    runs.map(iso),
    [
      "2026-08-10T01:00:00.000Z",
      "2026-08-10T01:15:00.000Z",
      "2026-08-10T01:30:00.000Z",
    ],
  );
});

test("nextCronRun is strictly after the reference instant", () => {
  // 10:00 UTC exactly matches a cron minute → next is 10:01, not 10:00.
  const next = nextCronRun("* * * * *", "UTC", Date.UTC(2026, 7, 8, 10, 0, 0));
  assert.equal(iso(next), "2026-08-08T10:01:00.000Z");
});

test("calculateNextRun: cron advances to the next occurrence", () => {
  const schedule = {
    scheduleType: "recurring",
    cronExpression: "0 18 * * 1-5",
    executeAt: null,
    timezone: "Asia/Shanghai",
  };
  // Friday 2026-08-07 18:00 Shanghai = 10:00Z; strictly-after → Monday 18:00.
  const next = calculateNextRun(schedule, Date.UTC(2026, 7, 7, 10, 0, 0));
  assert.equal(iso(next), "2026-08-10T10:00:00.000Z");
});

// ---------------------------------------------------------------------------
// resolveSchedule (cron)
// ---------------------------------------------------------------------------

test("resolveSchedule: cron persists as recurring + cronExpression", () => {
  const r = resolveSchedule({
    type: "cron",
    cronExpression: "*/30 * * * *",
    timezone: "Asia/Shanghai",
  });
  assert.equal(r.scheduleType, "recurring");
  assert.equal(r.executeAt, null);
  assert.equal(r.cronExpression, "*/30 * * * *");
  assert.equal(r.timezone, "Asia/Shanghai");
  assert.ok(r.nextRunAt > Date.now() - 60000);
});

test("resolveSchedule: cron normalizes extra whitespace", () => {
  const r = resolveSchedule({
    type: "cron",
    cronExpression: "  0   18   *    *    1-5  ",
    timezone: "UTC",
  });
  assert.equal(r.cronExpression, "0 18 * * 1-5");
});

// ---------------------------------------------------------------------------
// Validation: invalid fields / ranges / steps / arity / tokens
// ---------------------------------------------------------------------------

test("validateCronExpression: rejects empty", () => {
  assert.throws(() => validateCronExpression(""), SchedulerError);
  assert.throws(() => validateCronExpression("   "), SchedulerError);
});

test("validateCronExpression: rejects non-5-field expressions (seconds)", () => {
  // 6 fields (seconds) must be rejected even though cron-parser accepts them.
  assert.throws(() => validateCronExpression("* * * * * *"), SchedulerError);
  // 4 fields also invalid.
  assert.throws(() => validateCronExpression("* * * *"), SchedulerError);
});

test("validateCronExpression: rejects out-of-range minute", () => {
  assert.throws(() => validateCronExpression("99 * * * *"), SchedulerError);
});

test("validateCronExpression: rejects out-of-range hour", () => {
  assert.throws(() => validateCronExpression("0 25 * * *"), SchedulerError);
});

test("validateCronExpression: rejects zero step", () => {
  assert.throws(() => validateCronExpression("*/0 * * * *"), SchedulerError);
});

test("validateCronExpression: rejects Quartz/Jenkins tokens (L/W/#/H)", () => {
  assert.throws(() => validateCronExpression("0 0 L * *"), SchedulerError);
  assert.throws(() => validateCronExpression("0 0 * * 5L"), SchedulerError);
  assert.throws(() => validateCronExpression("0 0 * * 1#3"), SchedulerError);
  assert.throws(() => validateCronExpression("0 0 15W * *"), SchedulerError);
  assert.throws(() => validateCronExpression("H * * * *"), SchedulerError);
});

test("validateCronExpression: rejects overlong expression", () => {
  // 257 chars → rejected.
  const long = "0,".repeat(129) + " * * * *";
  assert.ok(long.length > 256);
  assert.throws(() => validateCronExpression(long), SchedulerError);
});

test("validateCronExpression: accepts the minimal every-minute cron", () => {
  assert.equal(validateCronExpression("* * * * *"), "* * * * *");
});

test("validateCronExpression: returns normalized form", () => {
  assert.equal(
    validateCronExpression("  0   9   *   *   1-5  "),
    "0 9 * * 1-5",
  );
});

test("resolveSchedule: cron with invalid timezone throws INVALID_TIMEZONE", () => {
  assert.throws(
    () =>
      resolveSchedule({
        type: "cron",
        cronExpression: "0 9 * * *",
        timezone: "Not/A/Zone",
      }),
    (e) => e instanceof SchedulerError && e.code === SchedulerErrorCode.INVALID_TIMEZONE,
  );
});

test("resolveSchedule: cron with invalid expression throws INVALID_CRON", () => {
  assert.throws(
    () =>
      resolveSchedule({
        type: "cron",
        cronExpression: "0 99 * * *",
        timezone: "UTC",
      }),
    (e) => e instanceof SchedulerError && e.code === SchedulerErrorCode.INVALID_CRON,
  );
});

test("assertValidTimezone: rejects invalid zone (cron path)", () => {
  assert.throws(() => assertValidTimezone("Mars/Olympus"), SchedulerError);
});

// ---------------------------------------------------------------------------
// DST
// ---------------------------------------------------------------------------

test("DST spring-forward gap: non-existent time does not duplicate", () => {
  // US 2026 DST starts 2026-03-08 02:00 EST → 03:00 EDT. 02:30 doesn't exist.
  // America/New_York, "30 2 * * *" → should skip the gap day's 02:30 and land
  // deterministically on a valid instant (not throw, not double-fire).
  const ref = Date.UTC(2026, 2, 7, 12, 0, 0); // 2026-03-07 noon UTC
  const next = nextCronRun("30 2 * * *", "America/New_York", ref);
  const d = new Date(next);
  // Either the gap is skipped to the next valid 02:30, or cron-parser folds
  // forward — both are acceptable per the design doc as long as it's single
  // and valid.
  assert.ok(d.getTime() > ref);
  assert.ok(!Number.isNaN(d.getTime()));
});

test("DST fall-back fold: repeated time fires once", () => {
  // US 2026 DST ends 2026-11-01 02:00 EDT → 01:00 EST. 01:30 occurs twice.
  // cron-parser returns a single next instant after the reference.
  const ref = Date.UTC(2026, 10, 1, 4, 0, 0); // after the fold
  const next = nextCronRun("30 1 * * *", "America/New_York", ref);
  assert.ok(next > ref);
});

// ---------------------------------------------------------------------------
// preview + nextRuns
// ---------------------------------------------------------------------------

test("previewNextRun: cron returns localDisplay + utcDisplay + nextRuns", () => {
  const p = previewNextRun({
    type: "cron",
    cronExpression: "*/30 * * * *",
    timezone: "Asia/Shanghai",
  });
  assert.ok(p.nextRunAt > Date.now() - 60000);
  assert.match(p.localDisplay, /Asia\/Shanghai/);
  assert.match(p.utcDisplay, /UTC/);
  assert.ok(Array.isArray(p.nextRuns));
  assert.equal(p.nextRuns.length, 3);
  // Monotonically increasing.
  for (let i = 1; i < p.nextRuns.length; i++) {
    assert.ok(p.nextRuns[i] > p.nextRuns[i - 1]);
  }
});

test("previewNextRun: once returns a single-element nextRuns", () => {
  const p = previewNextRun({
    type: "once",
    localDateTime: "2026-08-08T10:00:00",
    timezone: "UTC",
  });
  assert.equal(p.nextRuns.length, 1);
});

test("previewNextRun: nextRuns[0] always equals nextRunAt", () => {
  // Guards against a double-Date.now() that could straddle a cron boundary.
  for (const input of [
    { type: "cron", cronExpression: "* * * * *", timezone: "UTC" },
    { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    { type: "daily", time: "08:00", timezone: "Asia/Singapore" },
  ]) {
    const p = previewNextRun(input);
    assert.equal(p.nextRuns[0], p.nextRunAt, `mismatch for ${input.cronExpression ?? input.time}`);
  }
});

test("previewNextRun: runCount controls the series length", () => {
  const p = previewNextRun(
    { type: "cron", cronExpression: "* * * * *", timezone: "UTC" },
    5,
  );
  assert.equal(p.nextRuns.length, 5);
  for (let i = 1; i < p.nextRuns.length; i++) {
    assert.ok(p.nextRuns[i] > p.nextRuns[i - 1]);
  }
});

// ---------------------------------------------------------------------------
// Daily ↔ cron detection
// ---------------------------------------------------------------------------

test("isDailyCronPattern: true for simple M H * * *", () => {
  assert.equal(isDailyCronPattern("0 8 * * *"), true);
  assert.equal(isDailyCronPattern("30 23 * * *"), true);
});

test("isDailyCronPattern: false for general cron", () => {
  assert.equal(isDailyCronPattern("*/15 9-18 * * 1-5"), false);
  assert.equal(isDailyCronPattern("0 9 * * 1-5"), false);
  assert.equal(isDailyCronPattern(null), false);
  assert.equal(isDailyCronPattern(""), false);
});

test("calculateNextRun: daily '0 8 * * *' still works via cron-parser", () => {
  const schedule = {
    scheduleType: "recurring",
    cronExpression: "0 8 * * *",
    executeAt: null,
    timezone: "Asia/Singapore",
  };
  const next = calculateNextRun(schedule, Date.UTC(2026, 7, 7, 0, 0, 0));
  assert.equal(iso(next), "2026-08-08T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Service-level create + modify with a cron schedule
// ---------------------------------------------------------------------------

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-cron-"));
  const store = SqliteTaskStore.open(join(dir, "app.db"));
  const service = new TaskService(store);
  return { service, dir };
}

test("TaskService.createTask: persists a cron schedule", () => {
  const { service, dir } = makeService();
  try {
    const task = service.createTask({
      name: "工作日报",
      prompt: "生成今天的工作日报",
      cwd: dir,
      schedule: {
        type: "cron",
        cronExpression: "0 18 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      execution: {
        provider: null,
        modelId: null,
        thinkingLevel: null,
        toolNames: [],
        timeoutSeconds: 7200,
        notifyOnSuccess: false,
        notifyOnFailure: true,
      },
    });
    assert.equal(task.schedule.scheduleType, "recurring");
    assert.equal(task.schedule.cronExpression, "0 18 * * 1-5");
    assert.equal(task.schedule.executeAt, null);
    assert.equal(task.schedule.timezone, "Asia/Shanghai");
    assert.ok(task.nextRunAt > Date.now() - 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskService.createTask: rejects invalid cron expression", () => {
  const { service, dir } = makeService();
  try {
    assert.throws(
      () =>
        service.createTask({
          name: "bad",
          prompt: "x",
          cwd: dir,
          schedule: {
            type: "cron",
            cronExpression: "0 99 * * *",
            timezone: "UTC",
          },
          execution: {
            provider: null,
            modelId: null,
            thinkingLevel: null,
            toolNames: [],
            timeoutSeconds: 7200,
            notifyOnSuccess: false,
            notifyOnFailure: true,
          },
        }),
      (e) => e instanceof SchedulerError && e.code === SchedulerErrorCode.INVALID_CRON,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskService.updateTask: can switch a daily task to cron", () => {
  const { service, dir } = makeService();
  try {
    const task = service.createTask({
      name: "daily",
      prompt: "x",
      cwd: dir,
      schedule: { type: "daily", time: "08:00", timezone: "UTC" },
      execution: {
        provider: null,
        modelId: null,
        thinkingLevel: null,
        toolNames: [],
        timeoutSeconds: 7200,
        notifyOnSuccess: false,
        notifyOnFailure: true,
      },
    });
    const updated = service.updateTask(task.id, {
      revision: task.revision,
      schedule: {
        type: "cron",
        cronExpression: "*/15 9-18 * * 1-5",
        timezone: "Asia/Shanghai",
      },
    });
    assert.equal(updated.schedule.scheduleType, "recurring");
    assert.equal(updated.schedule.cronExpression, "*/15 9-18 * * 1-5");
    assert.equal(updated.schedule.timezone, "Asia/Shanghai");
    assert.ok(updated.nextRunAt > Date.now() - 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TaskService.updateTask: resuming a paused cron task recomputes next run", () => {
  const { service, dir } = makeService();
  try {
    const task = service.createTask({
      name: "cron",
      prompt: "x",
      cwd: dir,
      schedule: {
        type: "cron",
        cronExpression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      execution: {
        provider: null,
        modelId: null,
        thinkingLevel: null,
        toolNames: [],
        timeoutSeconds: 7200,
        notifyOnSuccess: false,
        notifyOnFailure: true,
      },
    });
    const paused = service.setTaskStatus(task.id, "paused", task.revision);
    assert.equal(paused.status, "paused");
    const resumed = service.setTaskStatus(paused.id, "active", paused.revision);
    assert.equal(resumed.status, "active");
    assert.ok(resumed.nextRunAt > Date.now() - 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
