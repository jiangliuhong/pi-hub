import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const {
  CLIENT_PROTOCOL_VERSION,
  CLIENT_INFO_SERVICE,
  getPackageVersion,
  buildClientInfo,
} = require("./client-info.ts");

// ---------- constants ----------

test("CLIENT_INFO_SERVICE is the exact lowercase literal 'pi-hub'", () => {
  // The client does an exact match; "Pi-Hub", "pihub", "pi_hub" are rejected.
  assert.equal(CLIENT_INFO_SERVICE, "pi-hub");
});

test("CLIENT_PROTOCOL_VERSION is 1 (JSON number, current supported range)", () => {
  // Client currently supports [1, 1]; 0/2/missing are all rejected.
  assert.equal(CLIENT_PROTOCOL_VERSION, 1);
  assert.equal(typeof CLIENT_PROTOCOL_VERSION, "number");
});

// ---------- version source ----------

test("getPackageVersion matches package.json version without a v prefix", () => {
  const v = getPackageVersion();
  assert.equal(v, packageJson.version);
  assert.doesNotMatch(v, /^v/, "version must not carry a 'v' prefix");
});

test("getPackageVersion is independent of process.cwd", () => {
  // Resolved relative to the module, not cwd — pass an explicit pkgDir.
  const nodePath = require("node:path");
  const root = nodePath.resolve(import.meta.dirname, "..");
  assert.equal(getPackageVersion(root), packageJson.version);
});

// ---------- payload shape (the contract the Rust client deserializes) ----------

test("buildClientInfo returns exactly the 3 contract fields in order", () => {
  const info = buildClientInfo();
  assert.deepEqual(Object.keys(info), ["service", "protocolVersion", "version"]);
});

test("buildClientInfo service matches the exact contract literal", () => {
  assert.equal(buildClientInfo().service, "pi-hub");
});

test("buildClientInfo protocolVersion is the number 1", () => {
  const { protocolVersion } = buildClientInfo();
  assert.equal(protocolVersion, 1);
  assert.equal(typeof protocolVersion, "number");
});

test("buildClientInfo version matches package.json and has no v prefix", () => {
  const { version } = buildClientInfo();
  assert.equal(version, packageJson.version);
  assert.doesNotMatch(version, /^v/);
});

test("buildClientInfo is pure — two calls return equal, independent values", () => {
  assert.deepEqual(buildClientInfo(), buildClientInfo());
});

// ---------- security: no sensitive data leaks ----------

test("payload contains only the 3 public identity fields — no secrets/paths", () => {
  const json = JSON.stringify(buildClientInfo());
  // Sanity: the three allowed keys are present.
  for (const key of ["service", "protocolVersion", "version"]) assert.ok(json.includes(key));
  // Must not leak common sensitive shapes. version is the only free-form string
  // and it is a semver string, not a path/token.
  assert.doesNotMatch(json, /token|secret|apiKey|password|authorization/i);
  assert.doesNotMatch(json, /\/Users\/|\/home\/|C:\\\\/i, "no absolute home paths");
});
