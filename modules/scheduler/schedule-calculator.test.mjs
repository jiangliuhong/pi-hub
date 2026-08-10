import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  resolveSchedule,
  calculateNextRun,
  nextCronRun,
  previewNextRun,
  withinMisfireGrace,
  cronFromDaily,
  assertValidTimezone,
  SchedulerError,
} = await jiti.import("./schedule-calculator.ts");

// Daily scheduling now flows through cron-parser via cronFromDaily() ("M H * * *"),
// the same path production uses. These assert the same expected instants the
// old hand-rolled nextDailyRun produced.

test("daily: next run is the following day when reference is exactly the target time", () => {
  // 2026-08-07T00:00Z == 08:00 SGT. Since cron-parser's next() is strictly-after,
  // the answer is the next day's 08:00 SGT (2026-08-08T00:00Z).
  const next = nextCronRun(cronFromDaily("08:00"), "Asia/Singapore", Date.UTC(2026, 7, 7, 0, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T00:00:00.000Z");
});

test("daily: next run is today when reference is before the target time", () => {
  // 2026-08-06T18:00Z = 2026-08-07 02:00 SGT, before 08:00 → same day 08:00 SGT.
  const next = nextCronRun(cronFromDaily("08:00"), "Asia/Singapore", Date.UTC(2026, 7, 6, 18, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-07T00:00:00.000Z");
});

test("daily: crosses month boundary", () => {
  // 2026-08-31T16:00Z = 2026-09-01 00:00 SGT → next 08:00 is Sep 1 08:00 SGT.
  const next = nextCronRun(cronFromDaily("08:00"), "Asia/Singapore", Date.UTC(2026, 7, 31, 16, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-09-01T00:00:00.000Z");
});

test("daily: crosses year boundary", () => {
  // 2026-12-31T16:00Z = 2027-01-01 00:00 SGT → next 08:00 SGT = 2027-01-01T00:00Z.
  const next = nextCronRun(cronFromDaily("08:00"), "Asia/Singapore", Date.UTC(2026, 11, 31, 16, 0, 0));
  assert.equal(new Date(next).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("daily: different timezone (UTC) — 09:30 UTC", () => {
  const next = nextCronRun(cronFromDaily("09:30"), "UTC", Date.UTC(2026, 7, 7, 9, 30, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T09:30:00.000Z");
});

test("daily: DST start (spring forward) — America/New_York 02:30 does not exist", () => {
  // US 2026 DST starts 2026-03-08 02:00 EST → clocks jump to 03:00 EDT.
  // 02:30 local does not exist. cron-parser falls forward to a single valid
  // instant that day (03:30 EDT); we only assert a deterministic, valid future
  // instant in March (no infinite loop, no throw, runs once).
  const ref = Date.UTC(2026, 2, 7, 12, 0, 0); // 2026-03-07 noon UTC
  const next = nextCronRun(cronFromDaily("02:30"), "America/New_York", ref);
  const d = new Date(next);
  assert.ok(d.getUTCMonth() === 2 && (d.getUTCDate() === 8 || d.getUTCDate() === 9));
});

test("once: converts local datetime + timezone to UTC epoch", () => {
  const r = resolveSchedule({
    type: "once",
    localDateTime: "2026-08-08T10:00:00",
    timezone: "Asia/Singapore",
  });
  assert.equal(r.scheduleType, "once");
  assert.equal(new Date(r.nextRunAt).toISOString(), "2026-08-08T02:00:00.000Z");
});

test("once: returns executeAt equal to nextRunAt", () => {
  const r = resolveSchedule({
    type: "once",
    localDateTime: "2026-08-08T10:00:00",
    timezone: "UTC",
  });
  assert.equal(r.executeAt, r.nextRunAt);
  assert.equal(new Date(r.nextRunAt).toISOString(), "2026-08-08T10:00:00.000Z");
});

test("calculateNextRun: recurring advances by one day", () => {
  const schedule = {
    scheduleType: "recurring",
    cronExpression: "0 8 * * *",
    executeAt: null,
    timezone: "Asia/Singapore",
  };
  const next = calculateNextRun(schedule, Date.UTC(2026, 7, 7, 0, 0, 0));
  assert.equal(new Date(next).toISOString(), "2026-08-08T00:00:00.000Z");
});

test("calculateNextRun: once returns executeAt", () => {
  const executeAt = Date.UTC(2026, 7, 8, 2, 0, 0);
  const schedule = { scheduleType: "once", cronExpression: null, executeAt, timezone: "UTC" };
  assert.equal(calculateNextRun(schedule, Date.now()), executeAt);
});

test("cronFromDaily: converts HH:MM to cron M H * * *", () => {
  assert.equal(cronFromDaily("08:00"), "0 8 * * *");
  assert.equal(cronFromDaily("23:45"), "45 23 * * *");
});

test("previewNextRun: returns local + UTC display strings", () => {
  const p = previewNextRun({ type: "daily", time: "08:00", timezone: "Asia/Singapore" });
  assert.ok(p.nextRunAt > Date.now() - 86400000);
  assert.match(p.localDisplay, /Asia\/Singapore/);
  assert.match(p.utcDisplay, /UTC/);
});

test("withinMisfireGrace: boundary", () => {
  const due = 1000000;
  assert.equal(withinMisfireGrace(due, due + 60000, 120), true); // 1 min late, 2 min grace → within
  assert.equal(withinMisfireGrace(due, due + 60000, 30), false); // 1 min late, 30s grace → outside
  assert.equal(withinMisfireGrace(due, due, 0), true); // exactly on time: now-due=0 <= 0 → within
  assert.equal(withinMisfireGrace(due, due + 1, 0), false); // 1ms late, 0 grace → outside
});

test("assertValidTimezone: rejects invalid zone", () => {
  assert.throws(() => assertValidTimezone("Not/A/Zone"), SchedulerError);
});

test("resolveSchedule: rejects invalid daily time", () => {
  assert.throws(
    () => resolveSchedule({ type: "daily", time: "25:00", timezone: "UTC" }),
    SchedulerError,
  );
});
