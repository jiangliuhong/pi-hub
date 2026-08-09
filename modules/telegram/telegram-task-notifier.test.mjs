import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { TelegramTaskNotifier } = await jiti.import("./telegram-task-notifier.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-tn-"));
  return { store: SqliteTelegramStore.open(join(dir, "app.db")), dir };
}

/** A minimal TaskRun-like object for the notifier. */
function fakeRun(overrides = {}) {
  return {
    id: "run_abc123",
    taskId: "task_001",
    taskNameSnapshot: "Daily Check",
    promptSnapshot: "",
    cwdSnapshot: "/tmp",
    scheduleSnapshotJson: "{}",
    // Defaults match a task that opted into both notifications; individual
    // tests override the snapshot to exercise the notify-flag gating.
    executionOptionsSnapshotJson: JSON.stringify({ notifyOnSuccess: true, notifyOnFailure: true }),
    triggerType: "scheduled",
    scheduledFor: Date.now(),
    status: "running",
    sessionId: "sess-xyz",
    resultExcerpt: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: Date.now(),
    startedAt: Date.now() - 10_000,
    finishedAt: null,
    heartbeatAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

test("notifier: success enqueues one outbox entry per target conversation", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertUser({ telegramUserId: 7, role: "operator", enabled: true });
    // owner has a private-chat conversation
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 }); store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });
    store.upsertChat({ chatId: 200, chatType: "private", approvedBy: 7 }); store.upsertConversation({ chatId: 200, threadId: 0, ownerUserId: 7 });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    await n.onRunSucceeded({ run: fakeRun({ resultExcerpt: "all green" }), taskName: "Daily Check" });

    assert.equal(store.countOutbox("pending"), 2);
    const entries = store.listOutbox("pending", 5);
    const chatIds = entries.map((e) => e.chatId).sort();
    assert.deepEqual(chatIds, [100, 200]);
    // success dedupe key
    assert.ok(entries.every((e) => e.dedupeKey.startsWith("task-run:run_abc123:success")));
    // HTML payload present
    for (const e of entries) {
      const payload = JSON.parse(e.payloadJson);
      assert.equal(payload.parseMode, "HTML");
      assert.match(payload.text, /✅ 任务执行成功/);
      assert.match(payload.text, /Daily Check/);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: failure renders error code + session, dedupes by run id", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 }); store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    const run = fakeRun({ status: "failed", errorCode: "TASK_TIMEOUT", errorMessage: "timed out", finishedAt: Date.now() });
    await n.onRunFailed({ run, taskName: "Server Check" });
    await n.onRunFailed({ run, taskName: "Server Check" }); // duplicate → dropped

    assert.equal(store.countOutbox("pending"), 1);
    const entry = store.listOutbox("pending", 1)[0];
    const payload = JSON.parse(entry.payloadJson);
    assert.equal(entry.dedupeKey, "task-run:run_abc123:failed:100:0");
    assert.match(payload.text, /❌ 任务执行失败/);
    assert.match(payload.text, /TASK_TIMEOUT/);
    assert.match(payload.text, /timed out/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: explicit subscriptions override the default owner-chats rule", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 }); store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });
    // subscribe a different chat to this task
    store.upsertSubscription({
      taskId: "task_001",
      chatId: 999,
      threadId: 5,
      notifyStarted: false,
      notifySuccess: true,
      notifyFailure: false,
    });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    await n.onRunSucceeded({ run: fakeRun(), taskName: "Daily Check" });

    assert.equal(store.countOutbox("pending"), 1);
    const entry = store.listOutbox("pending", 1)[0];
    assert.equal(entry.chatId, 999);
    assert.equal(entry.threadId, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: no store / no targets → silent no-op (never throws)", async () => {
  const { store, dir } = makeStore();
  try {
    // no users, no conversations
    const n1 = new TelegramTaskNotifier({ resolveStore: () => store });
    await n1.onRunSucceeded({ run: fakeRun(), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 0);

    // null store (telegram not running)
    const n2 = new TelegramTaskNotifier({ resolveStore: () => null });
    await n2.onRunFailed({ run: fakeRun(), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: rerun button mints a single-use action token", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 }); store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    await n.onRunSucceeded({ run: fakeRun(), taskName: "Daily Check" });

    const entry = store.listOutbox("pending", 1)[0];
    const payload = JSON.parse(entry.payloadJson);
    assert.ok(payload.inlineKeyboard, "expected an inline keyboard with a rerun button");
    const callbackData = payload.inlineKeyboard[0][0].callbackData;
    assert.match(callbackData, /^a:/);
    // the token exists in the actions table
    const token = callbackData.slice(2);
    assert.ok(store.getAction(token), "action token persisted");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: respects notifyOnSuccess/notifyOnFailure flags from the snapshot", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 }); store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42 });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });

    // notifyOnSuccess=false → success is silent
    const optsSuccessOff = JSON.stringify({ notifyOnSuccess: false, notifyOnFailure: true });
    await n.onRunSucceeded({ run: fakeRun({ executionOptionsSnapshotJson: optsSuccessOff }), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 0);

    // notifyOnFailure=false → failure is silent
    const optsFailureOff = JSON.stringify({ notifyOnSuccess: true, notifyOnFailure: false });
    await n.onRunFailed({ run: fakeRun({ executionOptionsSnapshotJson: optsFailureOff, status: "failed" }), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 0);

    // both off → started is silent too (no notification at all)
    const optsBothOff = JSON.stringify({ notifyOnSuccess: false, notifyOnFailure: false });
    await n.onRunStarted({ run: fakeRun({ executionOptionsSnapshotJson: optsBothOff }), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 0);

    // failure-only default ({} snapshot) still fires on failure
    await n.onRunFailed({ run: fakeRun({ executionOptionsSnapshotJson: "{}", status: "failed" }), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: cross-workspace delivery is allowed by default", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42, workspace: "/repos/bot-ws" });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    // No explicit setting → defaults to allowAll=true → different cwd still notified.
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/other-ws" }), taskName: "Daily Check" });
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: default delivery is workspace-scoped when scoping is opted in", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42, workspace: "/repos/bot-ws" });
    store.upsertSettings({ allowAllWorkspaceNotifications: false });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    // task runs in a DIFFERENT cwd → no notification
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/other-ws" }), taskName: "Daily Check" });
    assert.equal(store.countOutbox("pending"), 0);

    // matching cwd → notified
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/bot-ws" }), taskName: "Daily Check" });
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: allowAllWorkspaceNotifications delivers to every chat", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42, workspace: "/repos/bot-ws" });
    store.upsertSettings({ allowAllWorkspaceNotifications: true });

    const n = new TelegramTaskNotifier({ resolveStore: () => store });
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/other-ws" }), taskName: "Daily Check" });
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: resolveProjectRoot folds worktree cwd to the project root for scoping", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42, workspace: "/repos/main" });
    store.upsertSettings({ allowAllWorkspaceNotifications: false });

    // Fake resolver: any "-worktrees/..." path folds back to the main repo.
    const foldWorktree = async (cwd) =>
      cwd.includes("-worktrees/")
        ? cwd.replace(/-worktrees\/.*$/, "")
        : cwd;
    const n = new TelegramTaskNotifier({ resolveStore: () => store, resolveProjectRoot: foldWorktree });

    // Task ran inside a worktree → folds to /repos/main → matches the chat.
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/main-worktrees/feature" }), taskName: "WT Task" });
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notifier: resolveProjectRoot is NOT called when scoping is off (default)", async () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 42, role: "owner", enabled: true });
    store.upsertChat({ chatId: 100, chatType: "private", approvedBy: 42 });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 42, workspace: "/repos/main" });

    let calls = 0;
    const n = new TelegramTaskNotifier({
      resolveStore: () => store,
      resolveProjectRoot: async (cwd) => { calls += 1; return cwd; },
    });
    // Default allowAll=true → resolver must not be invoked.
    await n.onRunSucceeded({ run: fakeRun({ cwdSnapshot: "/repos/elsewhere" }), taskName: "x" });
    assert.equal(store.countOutbox("pending"), 1);
    assert.equal(calls, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
