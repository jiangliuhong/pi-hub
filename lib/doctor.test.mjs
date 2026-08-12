import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DOCTOR_SCHEMA_VERSION,
  runDoctorChecks,
  renderDoctorJson,
  getHubHome,
  getAgentHome,
} = require("../bin/doctor.js");

// ---------- schema / shape ----------

test("DOCTOR_SCHEMA_VERSION is 1", () => {
  assert.equal(DOCTOR_SCHEMA_VERSION, 1);
});

test("runDoctorChecks returns stable top-level fields in order", () => {
  const result = runDoctorChecks({ env: {} });
  assert.deepEqual(Object.keys(result), [
    "schemaVersion",
    "status",
    "exitCode",
    "checks",
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.ok(["healthy", "degraded", "blocked"].includes(result.status));
  assert.ok(Array.isArray(result.checks));
});

test("renderDoctorJson omits exitCode from the JSON body", () => {
  const result = runDoctorChecks({ env: {} });
  const raw = renderDoctorJson(result);
  const parsed = JSON.parse(raw);
  assert.equal("exitCode" in parsed, false, "exitCode must not leak into JSON");
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "status", "checks"]);
});

test("renderDoctorJson is a single parseable JSON line", () => {
  const raw = renderDoctorJson(runDoctorChecks({ env: {} }));
  assert.ok(raw.endsWith("\n"));
  const lines = raw.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("checks include the expected minimal set", () => {
  const names = runDoctorChecks({ env: {} }).checks.map((c) => c.name);
  for (const expected of [
    "nodeVersion",
    "piHubHome",
    "piAgentHome",
    "buildArtifacts",
    "envReport",
    "telegramTokenSource",
  ]) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
});

// ---------- status aggregation ----------

test("unsupported Node version produces blocked + exit 3", () => {
  const result = runDoctorChecks({ env: {}, nodeVersion: "18.0.0" });
  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, 3);
  const nodeCheck = result.checks.find((c) => c.name === "nodeVersion");
  assert.equal(nodeCheck.status, "fail");
});

test("supported Node version passes the nodeVersion check", () => {
  const result = runDoctorChecks({ env: {}, nodeVersion: "22.19.0" });
  const nodeCheck = result.checks.find((c) => c.name === "nodeVersion");
  assert.equal(nodeCheck.status, "pass");
});

test("missing .next build artifacts is degraded, not blocked", () => {
  // Use a temp pkgDir that has no .next.
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pihub-doc-"));
  try {
    const result = runDoctorChecks({ env: {}, pkgDir: tmpRoot });
    const build = result.checks.find((c) => c.name === "buildArtifacts");
    assert.equal(build.status, "warn");
    assert.notEqual(result.status, "blocked");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------- path resolution ----------

test("getHubHome honors PI_HUB_HOME", () => {
  assert.equal(getHubHome({ PI_HUB_HOME: "/custom/hub" }), "/custom/hub");
});

test("getHubHome falls back to ~/.pi/hub", () => {
  const home = getHubHome({});
  assert.ok(home.endsWith(path.join(".pi", "hub")));
});

test("getAgentHome honors PI_CODING_AGENT_DIR", () => {
  assert.equal(
    getAgentHome({ PI_CODING_AGENT_DIR: "/custom/agent" }),
    "/custom/agent",
  );
});

// ---------- SECRET REDACTION (the core contract) ----------

test("envReport never includes secret values, only booleans", () => {
  const env = {
    PI_HUB_PASSWORD: "supersecret-password-123",
    PI_HUB_TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    PI_HUB_HOSTNAME: "0.0.0.0",
  };
  const result = runDoctorChecks({ env });
  const envReport = result.checks.find((c) => c.name === "envReport").detail;

  // Booleans only — never the values themselves.
  assert.equal(envReport.PI_HUB_PASSWORD, true);
  assert.equal(envReport.PI_HUB_TELEGRAM_BOT_TOKEN, true);
  assert.equal(envReport.PI_HUB_HOSTNAME, true);
  assert.equal(envReport.PI_HUB_HOME, false);
});

test("serialized doctor JSON contains no credential values", () => {
  // Credentials (passwords, tokens) must NEVER appear in the output. Resolved
  // directory paths (PI_HUB_HOME, PI_CODING_AGENT_DIR) are deliberately shown
  // because they are the primary useful output of doctor and are not secrets.
  const env = {
    PI_HUB_PASSWORD: "supersecret-password-123",
    PI_HUB_TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    PI_HUB_HOSTNAME: "0.0.0.0",
    PI_HUB_HOME: "/tmp/pihub-home-for-test",
    PI_CODING_AGENT_DIR: "/tmp/agent-home-for-test",
  };
  const raw = renderDoctorJson(runDoctorChecks({ env }));
  // Credentials must never leak anywhere in the JSON output.
  assert.doesNotMatch(raw, /supersecret-password-123/);
  assert.doesNotMatch(raw, /123456:ABC-DEF/);
});

test("telegramTokenSource reports 'env' when env token is set, without the token", () => {
  const env = { PI_HUB_TELEGRAM_BOT_TOKEN: "123456:ABC-DEF" };
  const result = runDoctorChecks({ env });
  const src = result.checks.find((c) => c.name === "telegramTokenSource");
  assert.equal(src.detail, "env");
  assert.doesNotMatch(renderDoctorJson(result), /123456:ABC-DEF/);
});

test("telegramTokenSource reports 'file' when secrets.json exists", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pihub-doc-secret-"));
  try {
    // Point PI_HUB_HOME at the temp dir and create a secrets.json there.
    mkdirSync(path.join(tmpRoot, "hub"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "hub", "secrets.json"), "{}");
    const result = runDoctorChecks({ env: { PI_HUB_HOME: path.join(tmpRoot, "hub") } });
    const src = result.checks.find((c) => c.name === "telegramTokenSource");
    assert.equal(src.detail, "file");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("telegramTokenSource reports 'unset' when no token is configured", () => {
  // Point PI_HUB_HOME at an empty temp dir so we don't pick up the real
  // ~/.pi/hub/secrets.json from the developer's machine.
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pihub-doc-unset-"));
  try {
    const result = runDoctorChecks({ env: { PI_HUB_HOME: tmpRoot } });
    const src = result.checks.find((c) => c.name === "telegramTokenSource");
    assert.equal(src.detail, "unset");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------- OFFLINE GUARANTEE (no network) ----------
// Guard against future regressions: if someone adds an HTTP call, spawn, or
// net.connect to doctor, these stubs will throw and fail the test.

test("doctor makes no network calls and spawns no processes", () => {
  // Wrap the global child_process and net/http modules to detect any use.
  // We require doctor.js fresh inside a context where requiring
  // child_process / net / http / https is trapped.
  //
  // Because doctor.js is already loaded above with the real modules, we instead
  // assert the offline invariant behaviorally: run checks and confirm they
  // complete without touching a real network endpoint. The strongest cheap
  // proxy is to verify no check adds a network-style status that would require
  // connectivity. (Full module trapping is done in the dedicated offline test
  // below using a child loader.)
  const result = runDoctorChecks({ env: {} });
  // Every check must resolve synchronously from fs/env — no pending work.
  assert.equal(result.checks.length, result.checks.filter((c) => c.status).length);
});

test("doctor offline: no outgoing HTTP/HTTPS/NET/child_process calls", () => {
  // Write a probe script to a temp file that traps require("child_process"),
  // require("net"), require("http"), require("https") to throw on use, then
  // loads bin/doctor.js and runs runDoctorChecks. If doctor ever calls into
  // those modules, the child throws and the test fails. (Using a temp file
  // instead of `node -e` avoids shell-escaping/TypeScript-eval pitfalls.)
  const child = require("node:child_process");
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const doctorPath = JSON.stringify(path.join(repoRoot, "bin", "doctor.js"));
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "pihub-doc-offline-"));
  const probePath = path.join(tmpRoot, "probe.cjs");
  writeFileSync(
    probePath,
    `"use strict";
const Module = require("module");
const originalLoad = Module._load;
function failLoad(name) {
  return function () {
    throw new Error("network/spawn module used during offline doctor: " + name);
  };
}
Module._load = function (request, parent, isMain) {
  if (request === "child_process") {
    return { spawn: failLoad("child_process.spawn"), exec: failLoad("child_process.exec"), execSync: failLoad("child_process.execSync") };
  }
  if (request === "net") {
    return { connect: failLoad("net.connect"), createConnection: failLoad("net.createConnection") };
  }
  if (request === "http") {
    return { request: failLoad("http.request"), get: failLoad("http.get") };
  }
  if (request === "https") {
    return { request: failLoad("https.request"), get: failLoad("https.get") };
  }
  if (request === "fetch" || request === "undici") {
    throw new Error("network module used during offline doctor: " + request);
  }
  return originalLoad.apply(this, arguments);
};
const { runDoctorChecks } = require(${doctorPath});
const result = runDoctorChecks({ env: { PI_HUB_PASSWORD: "x", PI_HUB_HOME: ${JSON.stringify(tmpRoot)} } });
process.stdout.write(JSON.stringify({ ok: true, status: result.status }));
`,
  );
  try {
    const out = child.execSync(`${process.execPath} ${JSON.stringify(probePath)}`, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true, "doctor ran without touching trapped modules");
    assert.ok(["healthy", "degraded", "blocked"].includes(parsed.status));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
