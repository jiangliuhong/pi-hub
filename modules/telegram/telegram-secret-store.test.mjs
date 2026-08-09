import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

function withHubHome(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pihub-home-"));
    const prev = process.env.PI_HUB_HOME;
    process.env.PI_HUB_HOME = dir;
    try {
      await fn(dir);
    } finally {
      process.env.PI_HUB_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "secret-store: env var wins and is read-only",
  withHubHome(async () => {
    const { resolveToken, saveLocalToken, isTokenManagedByEnv } =
      await jiti.import("./telegram-secret-store.ts");
    process.env.PI_HUB_TELEGRAM_BOT_TOKEN = "111:env-token";
    try {
      assert.equal(resolveToken().source, "environment");
      assert.equal(resolveToken().token, "111:env-token");
      assert.equal(isTokenManagedByEnv(), true);
      assert.throws(() => saveLocalToken("222:local"), /TELEGRAM_TOKEN_MANAGED_BY_ENV/);
    } finally {
      delete process.env.PI_HUB_TELEGRAM_BOT_TOKEN;
    }
  }),
);

test(
  "secret-store: local file with 0600 permissions",
  withHubHome(async () => {
    const { saveLocalToken, resolveToken, clearLocalToken, getSecretsPath } =
      await jiti.import("./telegram-secret-store.ts");
    saveLocalToken("222:local-token");
    const path = getSecretsPath();
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, "secrets.json must be 0600");
    assert.equal(resolveToken().source, "local");
    assert.equal(resolveToken().token, "222:local-token");

    clearLocalToken();
    assert.equal(resolveToken().source, null);
    // Raw file must not contain the token after clear.
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes("222:local-token"));
  }),
);

test(
  "secret-store: empty secrets.json yields no token",
  withHubHome(async () => {
    const { resolveToken } = await jiti.import("./telegram-secret-store.ts");
    assert.equal(resolveToken().source, null);
    assert.equal(resolveToken().token, "");
  }),
);

test(
  "secret-store: saveLocalToken rejects empty",
  withHubHome(async () => {
    const { saveLocalToken } = await jiti.import("./telegram-secret-store.ts");
    assert.throws(() => saveLocalToken("   "), /VALIDATION_ERROR/);
  }),
);
