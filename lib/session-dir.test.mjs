import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getConfiguredSessionDir } = await jiti.import("./session-dir.ts");

test("prefers PI_CODING_AGENT_SESSION_DIR and expands a leading tilde", () => {
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = "~/custom-pi-sessions";
  try {
    assert.equal(getConfiguredSessionDir(), join(homedir(), "custom-pi-sessions"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  }
});

test("reads sessionDir from Pi settings when the environment is unset", () => {
  const agentDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-hub-session-dir-"));
  const cwd = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pi-hub-session-cwd-"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/configured-pi-sessions" }));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    assert.equal(getConfiguredSessionDir(cwd), join(homedir(), "configured-pi-sessions"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
  }
});
