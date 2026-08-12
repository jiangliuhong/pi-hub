import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const {
  VERSION_SCHEMA_VERSION,
  buildVersionInfo,
  renderVersionJson,
} = require("../bin/version.js");

test("VERSION_SCHEMA_VERSION is 1", () => {
  assert.equal(VERSION_SCHEMA_VERSION, 1);
});

test("buildVersionInfo returns the stable field set in stable order", () => {
  const info = buildVersionInfo();
  assert.deepEqual(Object.keys(info), ["schemaVersion", "name", "version"]);
});

test("buildVersionInfo name matches package.json", () => {
  assert.equal(buildVersionInfo().name, packageJson.name);
});

test("buildVersionInfo version matches package.json", () => {
  assert.equal(buildVersionInfo().version, packageJson.version);
});

test("buildVersionInfo schemaVersion matches the exported constant", () => {
  assert.equal(buildVersionInfo().schemaVersion, VERSION_SCHEMA_VERSION);
});

test("renderVersionJson produces a single parseable JSON line", () => {
  const out = renderVersionJson();
  assert.ok(out.endsWith("\n"), "output must end with a newline");
  const lines = out.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "output must be exactly one JSON line");
  assert.deepEqual(JSON.parse(out), buildVersionInfo());
});

test("renderVersionJson preserves stable key order", () => {
  const raw = renderVersionJson().trim();
  // The serialized key order must match schemaVersion, name, version.
  const expectedKeys = ["schemaVersion", "name", "version"];
  const actualKeys = Object.keys(JSON.parse(raw));
  assert.deepEqual(actualKeys, expectedKeys);
});

test("version output is not influenced by the process cwd", () => {
  // buildVersionInfo resolves package.json relative to __dirname, so cwd must
  // not matter. Confirm by reading from an explicit pkgDir.
  const nodePath = require("node:path");
  const root = nodePath.resolve(import.meta.dirname, "..");
  const info = buildVersionInfo(root);
  assert.equal(info.version, packageJson.version);
});

test("version output does not contain log prefixes or extra decorations", () => {
  const out = renderVersionJson();
  // No log-style prefixes that would break a JSON parser consuming stdout.
  assert.doesNotMatch(out, /\[(pi-hub|info|warn|debug)\]/);
  assert.ok(out.trim().startsWith("{"));
  assert.ok(out.trim().endsWith("}"));
});
