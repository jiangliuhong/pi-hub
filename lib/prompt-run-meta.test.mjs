import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readRunMeta } = await jiti.import("./prompt-run-meta.ts");

test("readRunMeta: returns runId + source for a well-formed command", () => {
  const meta = readRunMeta({ type: "prompt", runMeta: { runId: "abc", source: "web" } });
  assert.deepEqual(meta, { runId: "abc", source: "web" });
});

test("readRunMeta: accepts every known source", () => {
  for (const source of ["web", "telegram", "scheduler", "api"]) {
    const meta = readRunMeta({ runMeta: { runId: "x", source } });
    assert.equal(meta?.source, source);
  }
});

test("readRunMeta: returns null when runMeta is absent", () => {
  assert.equal(readRunMeta({ type: "prompt", message: "hi" }), null);
});

test("readRunMeta: returns null for malformed shapes (defensive)", () => {
  assert.equal(readRunMeta(null), null);
  assert.equal(readRunMeta("prompt"), null);
  assert.equal(readRunMeta({ runMeta: null }), null);
  assert.equal(readRunMeta({ runMeta: "x" }), null);
  assert.equal(readRunMeta({ runMeta: { source: "web" } }), null); // missing runId
  assert.equal(readRunMeta({ runMeta: { runId: "", source: "web" } }), null); // empty runId
  assert.equal(readRunMeta({ runMeta: { runId: 42, source: "web" } }), null); // wrong type
  assert.equal(readRunMeta({ runMeta: { runId: "abc", source: "unknown" } }), null); // bad source
  assert.equal(readRunMeta({ runMeta: { runId: "abc" } }), null); // missing source
});
