import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { dispatchQueuedRuns } = await jiti.import("./scheduler-runtime.ts");

function makeRun(id) {
  return { id, status: "queued" };
}

function makeStore(ids) {
  const runs = new Map(ids.map((id) => [id, makeRun(id)]));
  return {
    listRuns: ({ limit }) => ids.slice(0, limit).map((id) => ({ id })),
    getRun: (id) => runs.get(id) ?? null,
  };
}

test("global concurrency one dispatches only one queued run", () => {
  const started = [];
  const count = dispatchQueuedRuns(
    makeStore(["run-1", "run-2", "run-3"]),
    0,
    (run) => started.push(run.id),
  );

  assert.equal(count, 1);
  assert.deepEqual(started, ["run-1"]);
});

test("an active run leaves no execution slot", () => {
  const started = [];
  const count = dispatchQueuedRuns(
    makeStore(["run-1", "run-2"]),
    1,
    (run) => started.push(run.id),
  );

  assert.equal(count, 0);
  assert.deepEqual(started, []);
});

test("a larger configured limit dispatches only the available slots", () => {
  const started = [];
  const count = dispatchQueuedRuns(
    makeStore(["run-1", "run-2", "run-3"]),
    1,
    (run) => started.push(run.id),
    3,
  );

  assert.equal(count, 2);
  assert.deepEqual(started, ["run-1", "run-2"]);
});
