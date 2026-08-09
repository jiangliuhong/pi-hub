import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { notifyManualRun } = await jiti.import("./telegram-manual-run-notifier.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-mrn-"));
  return { store: SqliteTelegramStore.open(join(dir, "app.db")), dir };
}

function seedOwner(store, workspace) {
  store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
  store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
  store.upsertConversation({
    chatId: 100,
    threadId: 0,
    ownerUserId: 42,
    ...(workspace !== undefined ? { workspace } : {}),
  });
}

test("manual-run: success enqueues to every owner chat", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    const result = notifyManualRun(store, {
      sessionId: "sess-1",
      runId: "run-aaa",
      status: "success",
      sessionName: "My Chat",
      prompt: "refactor the parser",
      resultExcerpt: "done",
      finishedAt: 1_700_000_000_000,
    });
    assert.equal(result.notified, 1);
    const entry = store.listOutbox("pending", 5)[0];
    const payload = JSON.parse(entry.payloadJson);
    assert.equal(payload.parseMode, "HTML");
    assert.match(payload.text, /✅ 手动任务完成/);
    assert.match(payload.text, /My Chat/);
    assert.match(payload.text, /refactor the parser/);
    assert.match(payload.text, /sess-1/);
    // dedupe key is now stable on the runId, not the finishedAt timestamp.
    assert.equal(entry.dedupeKey, "manual-run:sess-1:run-aaa:100:0");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: failure renders error message", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    const result = notifyManualRun(store, {
      sessionId: "sess-2",
      runId: "run-bbb",
      status: "failed",
      errorMessage: "model rate limited",
      finishedAt: 1_700_000_000_001,
    });
    assert.equal(result.notified, 1);
    const payload = JSON.parse(store.listOutbox("pending", 1)[0].payloadJson);
    assert.match(payload.text, /❌ 手动任务失败/);
    assert.match(payload.text, /model rate limited/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: no targets / no store → silent no-op", () => {
  const { store, dir } = makeStore();
  try {
    // no users → nothing to enqueue, no throw
    const result = notifyManualRun(store, { sessionId: "s", runId: "run-zz", status: "success" });
    assert.equal(result.notified, 0);
    assert.equal(result.skipped, true);
    assert.equal(store.countOutbox("pending"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: publicUrl renders an open-session link", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    notifyManualRun(store, {
      sessionId: "sess-3",
      runId: "run-ccc",
      status: "success",
      publicUrl: "https://hub.example.com/",
    });
    const payload = JSON.parse(store.listOutbox("pending", 1)[0].payloadJson);
    assert.match(payload.text, /打开会话/);
    assert.match(payload.text, /https:\/\/hub\.example\.com\/\?session=sess-3/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: stable runId dedupes repeated notifications for the same run", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store);
    // Simulate SSE replay + HTTP retry: the same run notified twice with
    // different finishedAt timestamps must only enqueue once.
    const first = notifyManualRun(store, {
      sessionId: "sess-dedup",
      runId: "run-stable",
      status: "success",
      finishedAt: 1_700_000_000_000,
    });
    const second = notifyManualRun(store, {
      sessionId: "sess-dedup",
      runId: "run-stable",
      status: "success",
      finishedAt: 1_700_000_000_999,
    });
    assert.equal(first.notified, 1);
    assert.equal(second.notified, 0); // dedupe key identical → not re-enqueued
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: cross-workspace is notified by default (allowAll on)", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store, "/repos/bot-workspace");
    // No explicit setting → defaults to allowAll=true → cross-workspace OK.
    const result = notifyManualRun(store, {
      sessionId: "sess-default",
      runId: "run-d1",
      status: "success",
      cwd: "/repos/other-workspace",
      finishedAt: 1_700_000_000_010,
    });
    assert.equal(result.notified, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: workspace mismatch blocks delivery when scoping is opted in", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store, "/repos/bot-workspace");
    store.upsertSettings({ allowAllWorkspaceNotifications: false });
    const result = notifyManualRun(store, {
      sessionId: "sess-x",
      runId: "run-d2",
      status: "success",
      cwd: "/repos/other-workspace",
      finishedAt: 1_700_000_000_002,
    });
    assert.equal(result.notified, 0); // different workspace → not notified
    assert.equal(store.countOutbox("pending"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: allowAllWorkspaceNotifications bypasses the workspace check", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store, "/repos/bot-workspace");
    store.upsertSettings({ allowAllWorkspaceNotifications: true });
    const result = notifyManualRun(store, {
      sessionId: "sess-y",
      runId: "run-d3",
      status: "success",
      cwd: "/repos/other-workspace",
      finishedAt: 1_700_000_000_003,
    });
    assert.equal(result.notified, 1);
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: matching workspace is notified; trailing-slash tolerant", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store, "/repos/bot-workspace/");
    store.upsertSettings({ allowAllWorkspaceNotifications: false });
    const result = notifyManualRun(store, {
      sessionId: "sess-z",
      runId: "run-d4",
      status: "success",
      cwd: "/repos/bot-workspace",
      finishedAt: 1_700_000_000_004,
    });
    assert.equal(result.notified, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: sessionProjectRoot folds worktree sessions to the project root", () => {
  const { store, dir } = makeStore();
  try {
    // Bot is bound to the project root; the session ran inside a worktree.
    seedOwner(store, "/repos/main");
    store.upsertSettings({ allowAllWorkspaceNotifications: false });
    const result = notifyManualRun(store, {
      sessionId: "sess-wt",
      runId: "run-d5",
      status: "success",
      cwd: "/repos/main-worktrees/feature", // raw cwd differs
      sessionProjectRoot: "/repos/main", // resolved root matches the chat
      finishedAt: 1_700_000_000_005,
    });
    assert.equal(result.notified, 1); // worktree → same project → notified
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual-run: without sessionProjectRoot, worktree cwd does NOT match", () => {
  const { store, dir } = makeStore();
  try {
    seedOwner(store, "/repos/main");
    store.upsertSettings({ allowAllWorkspaceNotifications: false });
    const result = notifyManualRun(store, {
      sessionId: "sess-wt-raw",
      runId: "run-d6",
      status: "success",
      cwd: "/repos/main-worktrees/feature", // no resolved root → raw cwd used
      finishedAt: 1_700_000_000_006,
    });
    assert.equal(result.notified, 0); // exact cwd differs → scoped out
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
