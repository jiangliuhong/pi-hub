import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isolatedServerEnv } from "../e2e/isolated-env.mjs";

test("E2E server environment isolates Hub state, custom sessions and transport credentials", () => {
  const inherited = {
    PATH: "test-path",
    PI_CODING_AGENT_DIR: "real-agent",
    PI_CODING_AGENT_SESSION_DIR: "real-sessions",
    PI_HUB_HOME: "real-hub",
    PI_HUB_PASSWORD: "hub-secret",
    PI_WEB_PASSWORD: "web-secret",
    PI_HUB_TELEGRAM_BOT_TOKEN: "bot-secret",
  };
  const env = isolatedServerEnv("fixture-agent", inherited);
  assert.equal(env.PI_CODING_AGENT_DIR, "fixture-agent");
  assert.equal(env.PI_HUB_HOME, join("fixture-agent", "hub"));
  for (const key of ["PI_CODING_AGENT_SESSION_DIR", "PI_HUB_PASSWORD", "PI_WEB_PASSWORD", "PI_HUB_TELEGRAM_BOT_TOKEN"]) {
    assert.equal(env[key], "", key);
  }
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(inherited.PI_HUB_HOME, "real-hub", "do not mutate the parent environment");
});

for (const script of ["run.mjs", "terminal.mjs"]) {
  test(`${script} uses the isolated environment when spawning its server`, () => {
    const source = readFileSync(new URL(`../e2e/${script}`, import.meta.url), "utf8");
    assert.match(source, /import \{ isolatedServerEnv \} from "\.\/isolated-env\.mjs"/);
    assert.match(source, /env: (?:\{ \.\.\.)?isolatedServerEnv\(agentDir\)/);
  });
}
