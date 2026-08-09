import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-tg-"));
  const store = SqliteTelegramStore.open(join(dir, "app.db"));
  return { store, dir };
}

// ---------------------------------------------------------------------------
// Settings + bot api server columns
// ---------------------------------------------------------------------------

test("migration: opens a fresh db and seeds the singleton settings row", () => {
  const { store, dir } = makeStore();
  try {
    const s = store.getSettings();
    assert.equal(s.enabled, false);
    assert.equal(s.botApi.mode, "official");
    assert.equal(s.botApi.apiRoot, "https://api.telegram.org");
    assert.equal(s.botApi.localMode, false);
    assert.equal(s.botApi.localFileRoot, null);
    assert.equal(s.privateOnly, true);
    assert.equal(s.toolVerbosity, "summary");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration: re-opening is idempotent", () => {
  const { store, dir } = makeStore();
  try {
    store.close();
    const store2 = SqliteTelegramStore.open(join(dir, "app.db"));
    store2.upsertSettings({ enabled: true });
    assert.equal(store2.getSettings().enabled, true);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertSettings: self-hosted bot api + local mode persists", () => {
  const { store, dir } = makeStore();
  try {
    store.upsertSettings({
      enabled: true,
      botApiMode: "self-hosted",
      apiRoot: "https://tg.example.com",
      localMode: true,
      localFileRoot: "/var/lib/telegram-bot-api",
      botId: 42,
      botUsername: "pi_hub_bot",
    });
    const s = store.getSettings();
    assert.equal(s.enabled, true);
    assert.equal(s.botApi.mode, "self-hosted");
    assert.equal(s.botApi.apiRoot, "https://tg.example.com");
    assert.equal(s.botApi.localMode, true);
    assert.equal(s.botApi.localFileRoot, "/var/lib/telegram-bot-api");
    assert.equal(s.botId, 42);
    assert.equal(s.botUsername, "pi_hub_bot");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

test("users: first user can become owner; upsert is idempotent", () => {
  const { store, dir } = makeStore();
  try {
    assert.equal(store.userCount(), 0);
    store.upsertUser({ telegramUserId: 111, role: "owner" });
    store.upsertUser({ telegramUserId: 111, role: "owner", displayName: "Alice" });
    const users = store.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, "owner");
    assert.equal(users[0].displayName, "Alice");
    assert.equal(store.userCount(), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("users: update + disable + delete", () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 222, role: "operator" });
    store.updateUser(222, { role: "viewer", enabled: false });
    const u = store.getUser(222);
    assert.equal(u.role, "viewer");
    assert.equal(u.enabled, false);
    assert.equal(store.deleteUser(222), true);
    assert.equal(store.getUser(222), null);
    assert.equal(store.deleteUser(999), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Conversations + transient recovery
// ---------------------------------------------------------------------------

test("conversations: upsert + update + state recovery", () => {
  const { store, dir } = makeStore();
  try {
    store.upsertUser({ telegramUserId: 111, role: "owner" });
    store.upsertChat({ chatId: 100, chatType: "private" });
    store.upsertConversation({ chatId: 100, threadId: 0, ownerUserId: 111 });
    store.updateConversation(100, 0, { state: "running", activeSessionId: "abc" });
    let conv = store.getConversation(100, 0);
    assert.equal(conv.state, "running");
    assert.equal(conv.activeSessionId, "abc");

    const recovered = store.resetTransientStates(Date.now());
    assert.equal(recovered, 1);
    conv = store.getConversation(100, 0);
    assert.equal(conv.state, "idle");

    assert.equal(store.conversationCount(), 1);
    assert.equal(store.deleteConversation(100, 0), true);
    assert.equal(store.conversationCount(), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pairing codes (single-use + expiry)
// ---------------------------------------------------------------------------

test("pairing: unused unexpired code is consumable exactly once", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.createPairingCode({ id: "p1", codeHash: "h1", role: "owner", expiresAt: now + 60000 });
    const candidates = store.listUnusedPairingCodes(now);
    assert.equal(candidates.length, 1);

    const first = store.consumePairingCode("h1", 111, now);
    assert.ok(first);
    const second = store.consumePairingCode("h1", 222, now);
    assert.equal(second, null);
    assert.equal(store.listUnusedPairingCodes(now).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairing: expired codes are not listed and purged", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.createPairingCode({ id: "p2", codeHash: "h2", role: "viewer", expiresAt: now - 1000 });
    assert.equal(store.listUnusedPairingCodes(now).length, 0);
    const purged = store.purgeExpiredPairingCodes(now);
    assert.equal(purged, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Actions (single-use)
// ---------------------------------------------------------------------------

test("actions: consume once", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.createAction({
      token: "tok1", actionType: "abort", payloadJson: "{}",
      userId: 111, chatId: 100, threadId: 0, expiresAt: now + 60000,
    });
    assert.ok(store.consumeAction("tok1", now));
    assert.equal(store.consumeAction("tok1", now), null);
    assert.equal(store.consumeAction("missing", now), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Outbox (dedupe)
// ---------------------------------------------------------------------------

test("outbox: dedupe_key prevents duplicate enqueue", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    const a = store.enqueueNotification({
      id: "o1", dedupeKey: "task-run:r1:success", chatId: 100, threadId: 0,
      eventType: "task_success", payloadJson: "{}", nextAttemptAt: now,
    });
    assert.ok(a);
    const b = store.enqueueNotification({
      id: "o2", dedupeKey: "task-run:r1:success", chatId: 100, threadId: 0,
      eventType: "task_success", payloadJson: "{}", nextAttemptAt: now,
    });
    assert.equal(b, null); // dedupe
    assert.equal(store.countOutbox("pending"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox: update lifecycle", () => {
  const { store, dir } = makeStore();
  try {
    const now = Date.now();
    store.enqueueNotification({
      id: "o3", dedupeKey: "k3", chatId: 100, threadId: 0,
      eventType: "task_failure", payloadJson: "{}", nextAttemptAt: now,
    });
    store.updateOutbox("o3", { status: "sent", sentAt: now, attemptCount: 1 });
    assert.equal(store.countOutbox("pending"), 0);
    assert.equal(store.countOutbox("sent"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

test("subscriptions: upsert + list + delete", () => {
  const { store, dir } = makeStore();
  try {
    store.upsertSubscription({
      taskId: "t1", chatId: 100, threadId: 0,
      notifyStarted: false, notifySuccess: true, notifyFailure: true,
    });
    store.upsertSubscription({
      taskId: "t1", chatId: 100, threadId: 0,
      notifyStarted: true, notifySuccess: true, notifyFailure: false,
    });
    const subs = store.listSubscriptionsForTask("t1");
    assert.equal(subs.length, 1);
    assert.equal(subs[0].notifyStarted, true);
    assert.equal(subs[0].notifyFailure, false);
    assert.equal(store.deleteSubscription("t1", 100, 0), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Lease
// ---------------------------------------------------------------------------

test("lease: only one owner; renewal; release", () => {
  const { store, dir } = makeStore();
  try {
    assert.equal(store.tryAcquireLease("telegram-bot", "ownerA", 15000), true);
    assert.equal(store.tryAcquireLease("telegram-bot", "ownerB", 15000), false);
    assert.equal(store.renewLease("telegram-bot", "ownerA", 15000), true);
    assert.equal(store.renewLease("telegram-bot", "ownerB", 15000), false);
    store.releaseLease("telegram-bot", "ownerA");
    assert.equal(store.tryAcquireLease("telegram-bot", "ownerB", 15000), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease: expires and can be re-acquired after expiry", async () => {
  const { store, dir } = makeStore();
  try {
    store.tryAcquireLease("telegram-bot", "ownerA", 1); // 1ms
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.tryAcquireLease("telegram-bot", "ownerB", 15000), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
