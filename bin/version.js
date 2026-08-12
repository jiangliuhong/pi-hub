"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

// schemaVersion is independent for `--version --json`. Bump it only when the
// stable field set or semantics change in a backward-incompatible way. Adding
// new fields without removing/renaming existing ones is backward-compatible and
// does NOT require a bump. See docs/pi-hub/pi-hub-cli-contract-v1.md.
const VERSION_SCHEMA_VERSION = 1;

/**
 * Build the stable version info object from the current package's package.json.
 *
 * Resolves package.json relative to this file (via `pkgDir`), never relative to
 * the process cwd, so the reported version always reflects the installed
 * @jarome/pi-hub package regardless of where the CLI is invoked from.
 *
 * @param {string} [pkgDir] - absolute path to the package root (contains package.json)
 * @returns {{ schemaVersion: number, name: string, version: string }}
 */
function buildVersionInfo(pkgDir = path.join(__dirname, "..")) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require(path.join(pkgDir, "package.json"));
  return {
    schemaVersion: VERSION_SCHEMA_VERSION,
    name: pkg.name,
    version: pkg.version,
  };
}

/**
 * Render the version info as a single line of JSON terminated by a newline.
 *
 * Uses JSON.stringify so the key order matches the object literal above
 * (schemaVersion, name, version) and stays stable across Node versions.
 *
 * @param {{ schemaVersion: number, name: string, version: string }} [info]
 * @returns {string}
 */
function renderVersionJson(info = buildVersionInfo()) {
  return `${JSON.stringify(info)}\n`;
}

module.exports = {
  VERSION_SCHEMA_VERSION,
  buildVersionInfo,
  renderVersionJson,
};
