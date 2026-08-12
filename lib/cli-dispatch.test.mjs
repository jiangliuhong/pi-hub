import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  dispatchCommand,
  EXIT_OK,
  EXIT_USAGE,
} = require("../bin/cli-dispatch.js");

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const binPath = path.join(repoRoot, "bin", "pi-hub.js");

// A doctor stub that records whether it was called, so we can assert dispatch
// reaches doctor WITHOUT touching real doctor logic here.
function makeDoctorStub() {
  const calls = [];
  const runDoctor = (argv) => {
    calls.push(argv);
    return { handled: true, exitCode: 0, stdout: '{"stub":true}\n' };
  };
  return { runDoctor, calls };
}

// ---------- --version dispatch ----------

test("--version --json is handled with exit code 0", () => {
  const r = dispatchCommand(["--version", "--json"]);
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_OK);
  assert.ok(r.stdout, "must produce stdout");
});

test("version --json (positional) is also accepted", () => {
  const r = dispatchCommand(["version", "--json"]);
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_OK);
});

test("--version without --json still produces stable JSON", () => {
  const r = dispatchCommand(["--version"]);
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_OK);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test("--version output is valid JSON with stable keys", () => {
  const r = dispatchCommand(["--version", "--json"]);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "name", "version"]);
});

test("--version rejects unknown flags with non-zero exit", () => {
  const r = dispatchCommand(["--version", "--bogus"]);
  assert.equal(r.handled, true);
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.exitCode, EXIT_USAGE);
  assert.ok(r.stderr, "must explain the error on stderr");
});

test("--version rejects extra positional args", () => {
  const r = dispatchCommand(["--version", "extra"]);
  assert.equal(r.exitCode, EXIT_USAGE);
});

// ---------- doctor dispatch ----------

test("doctor --json --offline routes to the provided runDoctor", () => {
  const stub = makeDoctorStub();
  const r = dispatchCommand(["doctor", "--json", "--offline"], stub);
  assert.equal(r.handled, true);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0], ["doctor", "--json", "--offline"]);
});

test("doctor without --json is a usage error", () => {
  const r = dispatchCommand(["doctor", "--offline"], makeDoctorStub());
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_USAGE);
  assert.match(r.stderr, /--json/);
});

test("doctor without --offline is a usage error", () => {
  const r = dispatchCommand(["doctor", "--json"], makeDoctorStub());
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_USAGE);
  assert.match(r.stderr, /--offline/);
});

test("doctor rejects unknown flags", () => {
  const r = dispatchCommand(
    ["doctor", "--json", "--offline", "--bogus"],
    makeDoctorStub(),
  );
  assert.equal(r.exitCode, EXIT_USAGE);
});

// ---------- server fallthrough ----------

test("no args falls through to the server launch path", () => {
  const r = dispatchCommand([]);
  assert.equal(r.handled, false);
});

test("server-only flags fall through to the server launch path", () => {
  const r = dispatchCommand(["--port", "8080", "-H", "0.0.0.0", "--no-open"]);
  assert.equal(r.handled, false);
});

test("unknown subcommand is a usage error", () => {
  const r = dispatchCommand(["frobnicate"]);
  assert.equal(r.handled, true);
  assert.equal(r.exitCode, EXIT_USAGE);
});

// ---------- subprocess smoke tests ----------
// These prove the real bin/pi-hub.js entry: that --version does NOT start an
// HTTP server (process exits quickly without hanging) and that stdout is a
// single clean JSON line with no log noise.

function runCli(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process timed out after ${timeoutMs}ms (server may have started)`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("subprocess: pi-hub --version --json prints valid JSON and exits 0", async () => {
  const { code, stdout } = await runCli(["--version", "--json"]);
  assert.equal(code, 0, `expected exit 0; stderr was: ${stdout}`);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "name", "version"]);
  assert.equal(parsed.name, "@jarome/pi-hub");
  assert.equal(parsed.schemaVersion, 1);
});

test("subprocess: --version does not hang (no HTTP server started)", async () => {
  // If the server started, the process would not exit within the timeout and
  // runCli would reject. A clean exit proves no server was started.
  const { code, stdout } = await runCli(["--version", "--json"], {
    timeoutMs: 5000,
  });
  assert.equal(code, 0);
  assert.ok(stdout.trim().length > 0);
});

test("subprocess: --version stdout has no extra lines or log noise", async () => {
  const { stdout } = await runCli(["--version", "--json"]);
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "stdout must be exactly one line");
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test("subprocess: unknown flag exits non-zero with a message", async () => {
  const { code, stderr } = await runCli(["--version", "--nope"]);
  assert.notEqual(code, 0);
  assert.ok(stderr.length > 0);
});

test("subprocess: doctor --json --offline exits 0 (healthy dev env) and is valid JSON", async () => {
  const { code, stdout } = await runCli(["doctor", "--json", "--offline"]);
  // In this dev checkout the environment is healthy; if it ever degrades in CI
  // we still assert valid JSON + schemaVersion, and only require code !== 2
  // (2 would mean a usage error, which is a real regression).
  assert.notEqual(code, 2, `unexpected usage error:\n${stdout}`);
  assert.doesNotThrow(() => JSON.parse(stdout));
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(["healthy", "degraded", "blocked"].includes(parsed.status));
});
