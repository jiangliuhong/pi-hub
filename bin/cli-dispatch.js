"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { renderVersionJson } = require("./version");

// Exit codes (documented in docs/pi-hub/pi-hub-cli-contract-v1.md):
//   0  success (version printed; doctor healthy)
//   2  argument/usage error (unknown flag, missing required flag, bad combo)
//   3  doctor: blocked (runtime or required paths missing — cannot run)
//   4  doctor: degraded (usable but some checks warn)
// Note: 1 is intentionally avoided so usage errors are distinguishable from
// runtime crashes / uncaught exceptions.
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_DOCTOR_BLOCKED = 3;
const EXIT_DOCTOR_DEGRADED = 4;

// Server flags that consume the NEXT argv token as their value (e.g.
// `--port 8080`, `-H 0.0.0.0`). The value is NOT itself a flag, so the
// positional-subcommand detector must skip it. Kept in sync with the
// server-launch parser in bin/pi-web-options.js.
const SERVER_VALUE_FLAGS = new Set(["--port", "-p", "--hostname", "-H"]);

/**
 * Decide whether the given argv should be handled by a non-server command
 * (version / doctor) or fall through to the legacy server launch.
 *
 * Returns a descriptor:
 *   { handled: true,  exitCode, stdout?, stderr? }  — caller writes output and exits
 *   { handled: false }                               — caller proceeds to server launch
 *
 * `doctorRun` is injected so tests can stub the doctor side without importing
 * network-touching code; production wiring is done in bin/pi-hub.js.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{ runDoctor: (argv: string[]) => { exitCode: number, stdout?: string, stderr?: string } }} [deps]
 * @returns {{ handled: boolean, exitCode?: number, stdout?: string, stderr?: string }}
 */
function dispatchCommand(
  argv,
  deps = {},
) {
  const tokens = Array.isArray(argv) ? argv : [];

  // Walk tokens and collect the true positional(s), skipping values consumed
  // by value-taking server flags (--port/-p, --hostname/-H). Without this,
  // `pi-hub -H 0.0.0.0` would misread `0.0.0.0` as a positional subcommand.
  const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (SERVER_VALUE_FLAGS.has(token)) {
      i += 1; // skip the value token consumed by this flag
      continue;
    }
    if (!String(token).startsWith("-")) {
      positionals.push(token);
    }
  }
  const subcommand = positionals.length > 0 ? positionals[0] : null;

  if (subcommand === "version" || tokens.includes("--version")) {
    return handleVersion(tokens);
  }
  if (subcommand === "doctor") {
    const runDoctor = deps.runDoctor;
    if (typeof runDoctor !== "function") {
      // Production wiring requires the caller to pass runDoctor; if missing,
      // treat as a usage error rather than silently no-oping.
      return {
        handled: true,
        exitCode: EXIT_USAGE,
        stderr: "doctor dispatcher is not wired up.\n",
      };
    }
    return handleDoctor(tokens, runDoctor);
  }

  // Unknown positional subcommand → usage error.
  if (subcommand !== null) {
    return {
      handled: true,
      exitCode: EXIT_USAGE,
      stderr: `Unknown command or argument: ${subcommand}\nRun "pi-hub --version" or "pi-hub doctor --json --offline".\n`,
    };
  }

  // No subcommand. Fall through to the server launch path. Unknown bare flags
  // are not rejected here — the legacy lenient parser (strict: false) governs
  // server-launch args to stay backward-compatible with Next.js passthrough
  // flags.
  return { handled: false };
}

/**
 * `pi-hub --version [--json]`.
 *
 * Strict: only `--version` and `--json` are accepted. Any other token is a
 * usage error. `--json` is accepted (and currently the only stable machine-
 * readable form); plain `--version` without `--json` also prints the same JSON
 * line so consumers can rely on a single stable shape. (If a human-readable
 * form is added later it will be opt-in and will not change --json output.)
 */
function handleVersion(tokens) {
  for (const token of tokens) {
    if (token === "--version" || token === "--json" || token === "version") {
      continue;
    }
    return {
      handled: true,
      exitCode: EXIT_USAGE,
      stderr: `Unexpected argument for --version: ${token}\nAllowed: pi-hub --version --json\n`,
    };
  }
  return {
    handled: true,
    exitCode: EXIT_OK,
    stdout: renderVersionJson(),
  };
}

/**
 * `pi-hub doctor --json --offline`.
 *
 * Strict: only `doctor`, `--json`, `--offline` accepted. Both `--json` and
 * `--offline` are required so the contract guarantees a stable, network-free
 * machine-readable result.
 */
function handleDoctor(tokens, runDoctor) {
  const set = new Set(tokens);
  for (const token of tokens) {
    if (
      token === "doctor" ||
      token === "--json" ||
      token === "--offline"
    ) {
      continue;
    }
    return {
      handled: true,
      exitCode: EXIT_USAGE,
      stderr: `Unexpected argument for doctor: ${token}\nAllowed: doctor --json --offline\n`,
    };
  }
  if (!set.has("--json") || !set.has("--offline")) {
    const missing = [];
    if (!set.has("--json")) missing.push("--json");
    if (!set.has("--offline")) missing.push("--offline");
    return {
      handled: true,
      exitCode: EXIT_USAGE,
      stderr: `doctor requires: ${missing.join(", ")}\nUsage: pi-hub doctor --json --offline\n`,
    };
  }
  return runDoctor(tokens);
}

module.exports = {
  EXIT_OK,
  EXIT_USAGE,
  EXIT_DOCTOR_BLOCKED,
  EXIT_DOCTOR_DEGRADED,
  dispatchCommand,
};
