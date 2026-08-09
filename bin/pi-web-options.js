"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * Read an environment variable with pi-hub/pi-web fallback.
 *
 * pi-hub is a fork of pi-web. To preserve backward compatibility for users
 * migrating from upstream (or sharing shell configs), every public
 * `PI_HUB_*` variable falls back to its legacy `PI_WEB_*` equivalent.
 * `PI_HUB_*` always wins when both are set.
 */
function getEnv(env, name) {
  return env[`PI_HUB_${name}`] ?? env[`PI_WEB_${name}`];
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  return {
    port: cliArgs.port ?? env.PORT ?? "30142",
    hostname: cliArgs.hostname ?? getEnv(env, "HOSTNAME") ?? "127.0.0.1",
    openBrowser: !cliArgs["no-open"] && !isEnabled(getEnv(env, "NO_OPEN")),
  };
}

module.exports = { parseLaunchOptions, getEnv };
