import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { SqliteTelegramStore } = await jiti.import("./sqlite-telegram-store.ts");
const { readTelePiConfig, previewTelePiImport, applyTelePiImport } = await jiti.import(
  "./telegram-telepi-import.ts",
);

function writeConfig(text) {
  const dir = mkdtempSync(join(tmpdir(), "pihub-telepi-"));
  const file = join(dir, "config.env");
  writeFileSync(file, text, "utf8");
  return { file, dir };
}

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pihub-telepi-db-"));
  return { store: SqliteTelegramStore.open(join(dir, "app.db")), dir };
}

test("readTelePiConfig: returns present:false when the file is missing", () => {
  const cfg = readTelePiConfig("/nonexistent/telepi/config.env");
  assert.equal(cfg.present, false);
  assert.equal(cfg.botToken, null);
  assert.deepEqual(cfg.allowedUserIds, []);
});

test("readTelePiConfig: parses token, users, workspace, verbosity, quotes, comments", () => {
  const { file } = writeConfig([
    "# TelePi config",
    'TELEGRAM_BOT_TOKEN="123456789:AAH-xY_testtoken_for_unit_testing_only"',
    "TELEGRAM_ALLOWED_USER_IDS=111, 222 333",
    "TELEPI_WORKSPACE=/home/me/repo",
    "TOOL_VERBOSITY=errors-only",
    "",
    "# ignored=comment",
  ].join("\n"));
  const cfg = readTelePiConfig(file);
  assert.equal(cfg.present, true);
  assert.equal(cfg.botToken, "123456789:AAH-xY_testtoken_for_unit_testing_only");
  assert.deepEqual(cfg.allowedUserIds, [111, 222, 333]);
  assert.equal(cfg.workspace, "/home/me/repo");
  assert.equal(cfg.toolVerbosity, "errors-only");
});

test("readTelePiConfig: unknown verbosity maps to null", () => {
  const { file } = writeConfig("TOOL_VERBOSITY=bogus\n");
  assert.equal(readTelePiConfig(file).toolVerbosity, null);
});

test("preview: env-managed token is flagged, not overwritten", () => {
  const cfg = readTelePiConfig("/nonexistent"); // present:false, no token
  const preview = previewTelePiImport(cfg, { existingUserCount: 0, tokenManagedByEnv: true });
  assert.equal(preview.tokenManagedByEnv, true);
  assert.equal(preview.present, false);
});

test("preview: first import grants owner role to the first user", () => {
  const { file } = writeConfig("TELEGRAM_ALLOWED_USER_IDS=10,20\n");
  const cfg = readTelePiConfig(file);
  const preview = previewTelePiImport(cfg, { existingUserCount: 0, tokenManagedByEnv: false });
  assert.equal(preview.userRole, "owner");
});

test("preview: subsequent import grants operator role", () => {
  const { file } = writeConfig("TELEGRAM_ALLOWED_USER_IDS=10,20\n");
  const cfg = readTelePiConfig(file);
  const preview = previewTelePiImport(cfg, { existingUserCount: 3, tokenManagedByEnv: false });
  assert.equal(preview.userRole, "operator");
});

test("apply: imports users + settings, skips absent token", () => {
  const { store, dir } = makeStore();
  try {
    const cfg = {
      present: true,
      botToken: null,
      allowedUserIds: [10, 20],
      workspace: "/repo",
      toolVerbosity: "summary",
    };
    const res = applyTelePiImport(store, cfg, { existingUserCount: 0 });
    assert.equal(res.importedUsers, 2);
    assert.equal(res.setWorkspace, true);
    assert.equal(res.setVerbosity, true);
    assert.equal(res.setToken, false);
    assert.equal(res.tokenSkipped, "absent");
    const users = store.listUsers();
    assert.equal(users.length, 2);
    assert.equal(users[0].role, "owner"); // first user, empty whitelist
    assert.equal(users[1].role, "operator");
    const settings = store.getSettings();
    assert.equal(settings.defaultWorkspace, "/repo");
    assert.equal(settings.toolVerbosity, "summary");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply: is idempotent (re-importing doesn't duplicate users)", () => {
  const { store, dir } = makeStore();
  try {
    const cfg = { present: true, botToken: null, allowedUserIds: [10], workspace: "/repo", toolVerbosity: null };
    applyTelePiImport(store, cfg, { existingUserCount: 0 });
    // second import — userCount is now 1, so role becomes operator but no dup
    applyTelePiImport(store, cfg, { existingUserCount: store.userCount() });
    assert.equal(store.listUsers().length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
