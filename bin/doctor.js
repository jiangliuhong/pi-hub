"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isNodeVersionSupported } = require("./node-version");

// schemaVersion is independent for `doctor --json`. See
// docs/pi-hub/pi-hub-cli-contract-v1.md.
const DOCTOR_SCHEMA_VERSION = 1;

// Env var names reported as boolean "set/unset" only — NEVER their values, to
// avoid leaking credentials or host configuration through doctor output.
const REPORTED_ENV_VARS = [
  "PI_HUB_HOME",
  "PI_HUB_HOSTNAME",
  "PI_HUB_PASSWORD",
  "PI_HUB_TELEGRAM_BOT_TOKEN",
  "PI_CODING_AGENT_DIR",
];

// Same exit codes as bin/cli-dispatch.js (duplicated rather than cross-required
// to keep doctor.js self-contained and avoid import-order surprises in tests).
const EXIT_OK = 0;
const EXIT_DOCTOR_BLOCKED = 3;
const EXIT_DOCTOR_DEGRADED = 4;

/**
 * Resolve the Pi Hub home directory.
 * Mirrors modules/scheduler/paths.ts -> getHubHome():
 *   process.env.PI_HUB_HOME || ~/.pi/hub
 */
function getHubHome(env) {
  return env.PI_HUB_HOME || path.join(os.homedir(), ".pi", "hub");
}

/**
 * Resolve the Pi agent home directory.
 * Mirrors the SDK's getAgentDir(): PI_CODING_AGENT_DIR override, else ~/.pi/agent.
 * (PI_HUB_HOME / PI_WEB_* do NOT affect the pi agent dir.)
 */
function getAgentHome(env) {
  return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/**
 * Test whether a path is writable. Returns true if the path exists and is a
 * writable directory, or if its parent is writable (i.e. it could be created).
 */
function isWritable(candidatePath) {
  try {
    const stat = fs.statSync(candidatePath);
    if (stat.isDirectory()) {
      fs.accessSync(candidatePath, fs.constants.W_OK);
      return true;
    }
    // It's a file. For our purposes (home dir), a file here is unexpected.
    return false;
  } catch {
    // Doesn't exist — check whether the nearest existing ancestor is writable.
    let dir = path.dirname(candidatePath);
    while (true) {
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory()) {
          fs.accessSync(dir, fs.constants.W_OK);
          return true;
        }
        return false;
      } catch {
        if (dir === path.dirname(dir)) return false; // reached root
        dir = path.dirname(dir);
      }
    }
  }
}

/**
 * Resolve the Telegram bot token source WITHOUT ever returning the token.
 * Mirrors modules/telegram/telegram-secret-store.ts resolveTokenSource().
 *   - env   → PI_HUB_TELEGRAM_BOT_TOKEN (or legacy PI_WEB_TELEGRAM_BOT_TOKEN) is set
 *   - file  → a secrets.json file exists at the hub home
 *   - unset → neither
 */
function resolveTelegramTokenSource(env, hubHome) {
  const fromEnv = Boolean(
    env.PI_HUB_TELEGRAM_BOT_TOKEN || env.PI_WEB_TELEGRAM_BOT_TOKEN,
  );
  if (fromEnv) return "env";
  try {
    if (fs.existsSync(path.join(hubHome, "secrets.json"))) return "file";
  } catch {
    // ignore fs errors — treat as unset
  }
  return "unset";
}

/**
 * Run all offline health checks and return a stable, serializable result.
 *
 * Pure with respect to side effects: it only reads the filesystem and env, and
 * never touches the network, spawns processes, opens ports, or reads secrets'
 * contents. Safe to unit-test by passing a fake `env` and pointing pkgDir at a
 * temp dir.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.nodeVersion=process.versions.node]
 * @param {string} [opts.pkgDir] - absolute path to the package root (for .next check)
 * @returns {{ schemaVersion: number, status: string, exitCode: number, checks: Array<{name:string,status:string,detail?:string}> }}
 */
function runDoctorChecks(opts = {}) {
  const env = opts.env || process.env;
  const nodeVersion = opts.nodeVersion || process.versions.node;
  const pkgDir = opts.pkgDir || path.join(__dirname, "..");

  const checks = [];

  // 1. Node version — BLOCKING if unsupported.
  checks.push({
    name: "nodeVersion",
    status: isNodeVersionSupported(nodeVersion) ? "pass" : "fail",
    detail: nodeVersion,
  });

  // 2. Pi Hub home — existence/writability. Not blocking if missing (first run
  //    may not have created it yet), but unwritable parent is blocking.
  const hubHome = getHubHome(env);
  const hubHomeExists = (() => {
    try {
      return fs.existsSync(hubHome);
    } catch {
      return false;
    }
  })();
  const hubHomeWritable = isWritable(hubHome);
  checks.push({
    name: "piHubHome",
    status: hubHomeWritable ? "pass" : "fail",
    detail: hubHomeExists
      ? `${hubHome} (writable: ${hubHomeWritable})`
      : `${hubHome} (absent; parent writable: ${hubHomeWritable})`,
  });

  // 3. Pi agent home — degraded if absent (pi may not be configured yet).
  const agentHome = getAgentHome(env);
  const agentHomeExists = (() => {
    try {
      return fs.existsSync(agentHome);
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "piAgentHome",
    status: agentHomeExists ? "pass" : "warn",
    detail: `${agentHome} (exists: ${agentHomeExists})`,
  });

  // 4. Build artifacts — degraded if absent (dev checkout without a build).
  const nextDir = path.join(pkgDir, ".next");
  const hasNext = (() => {
    try {
      return fs.existsSync(nextDir);
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "buildArtifacts",
    status: hasNext ? "pass" : "warn",
    detail: `${nextDir} (exists: ${hasNext})`,
  });

  // 5. Env var report — booleans only, never values.
  const envReport = {};
  for (const name of REPORTED_ENV_VARS) {
    envReport[name] = Boolean(env[name]);
  }
  checks.push({
    name: "envReport",
    status: "pass",
    detail: envReport,
  });

  // 6. Telegram token source — source string only, never the token.
  const telegramSource = resolveTelegramTokenSource(env, hubHome);
  checks.push({
    name: "telegramTokenSource",
    status: telegramSource === "unset" ? "warn" : "pass",
    detail: telegramSource,
  });

  // Aggregate status.
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  let status;
  let exitCode;
  if (hasFail) {
    status = "blocked";
    exitCode = EXIT_DOCTOR_BLOCKED;
  } else if (hasWarn) {
    status = "degraded";
    exitCode = EXIT_DOCTOR_DEGRADED;
  } else {
    status = "healthy";
    exitCode = EXIT_OK;
  }

  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    status,
    exitCode,
    checks,
  };
}

/**
 * Render the doctor result as a single stable-ordered JSON line + newline.
 * The exitCode is NOT part of the JSON (it's conveyed via process exit); it's
 * returned separately by runDoctorChecks.
 */
function renderDoctorJson(result) {
  const { exitCode: _ignoredExitCode, ...jsonBody } = result;
  void _ignoredExitCode;
  // Stable field order: schemaVersion, status, checks.
  const ordered = {
    schemaVersion: jsonBody.schemaVersion,
    status: jsonBody.status,
    checks: jsonBody.checks,
  };
  return `${JSON.stringify(ordered)}\n`;
}

module.exports = {
  DOCTOR_SCHEMA_VERSION,
  EXIT_OK,
  EXIT_DOCTOR_BLOCKED,
  EXIT_DOCTOR_DEGRADED,
  getHubHome,
  getAgentHome,
  runDoctorChecks,
  renderDoctorJson,
};
