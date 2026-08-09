import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runPromptAndWait } = await jiti.import("./prompt-run-waiter.ts");

/**
 * Minimal fake session: records sent commands and lets the test inject events.
 * Mirrors the WaiterSession shape (onEvent + send).
 */
function makeFakeSession() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(command) {
      sent.push(command);
      return Promise.resolve(null);
    },
    emit(event) {
      for (const l of listeners) l(event);
    },
  };
}

test("resolves on prompt_done (success)", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  // Let the send() microtask flush (subscribe-before-send), then emit done.
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(session.sent.map((c) => c.type), ["prompt"]);
});

test("fails when prompt_error precedes prompt_done", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  await Promise.resolve();
  session.emit({ type: "prompt_error", errorMessage: "boom" });
  session.emit({ type: "prompt_done" });
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "boom");
});

test("does NOT resolve on the first agent_end (waits for prompt_done)", async () => {
  const session = makeFakeSession();
  let resolved = false;
  const promise = runPromptAndWait(session, "hi", 5000).then((r) => {
    resolved = true;
    return r;
  });
  await Promise.resolve();
  session.emit({ type: "agent_end" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false);
  session.emit({ type: "prompt_done" });
  const result = await promise;
  assert.equal(result.ok, true);
});

test("times out and sends abort", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 20);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
  assert.ok(session.sent.some((c) => c.type === "abort"));
});

test("auto-responds to confirm extension_ui_request with confirmed:false", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  await Promise.resolve();
  session.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "ok?" });
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  const result = await promise;
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("confirm")));
  const response = session.sent.find(
    (c) => c.type === "extension_ui_response" && c.id === "ui-1",
  );
  assert.ok(response);
  assert.equal(response.confirmed, false);
});

test("auto-responds to select extension_ui_request with cancelled:true", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  await Promise.resolve();
  session.emit({ type: "extension_ui_request", id: "ui-2", method: "select", title: "pick", options: ["a", "b"] });
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  await promise;
  const response = session.sent.find(
    (c) => c.type === "extension_ui_response" && c.id === "ui-2",
  );
  assert.ok(response);
  assert.equal(response.cancelled, true);
});

test("notify extension_ui_request is not auto-cancelled (no warning)", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  await Promise.resolve();
  session.emit({ type: "extension_ui_request", id: "ui-3", method: "notify", message: "hi" });
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  const result = await promise;
  assert.equal(result.warnings.length, 0);
});

test("resolves exactly once even if multiple prompt_done events fire", async () => {
  const session = makeFakeSession();
  let count = 0;
  const promise = runPromptAndWait(session, "hi", 5000).then((r) => {
    count++;
    return r;
  });
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  session.emit({ type: "prompt_done" });
  await promise;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(count, 1);
});

test("external abort signal cancels the run", async () => {
  const session = makeFakeSession();
  const controller = new AbortController();
  const promise = runPromptAndWait(session, "hi", 5000, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.ok(session.sent.some((c) => c.type === "abort"));
});

test("forwards runMeta onto the prompt command so terminal events are source-tagged", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000, {
    runMeta: { runId: "task-run-42", source: "scheduler" },
  });
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  await promise;
  const promptCmd = session.sent.find((c) => c.type === "prompt");
  assert.deepEqual(promptCmd.runMeta, { runId: "task-run-42", source: "scheduler" });
});

test("omits runMeta when not provided (legacy callers)", async () => {
  const session = makeFakeSession();
  const promise = runPromptAndWait(session, "hi", 5000);
  await Promise.resolve();
  session.emit({ type: "prompt_done" });
  await promise;
  const promptCmd = session.sent.find((c) => c.type === "prompt");
  assert.equal("runMeta" in promptCmd, false);
});
