import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pi-web-options.js");

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: "30142",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PI_HUB_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PI_HUB_NO_OPEN: value }).openBrowser, false);
  }
});

test("supports truthy PI_WEB_NO_OPEN values (legacy fallback)", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false PI_HUB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PI_HUB_NO_OPEN: value }).openBrowser, true);
  }
});

test("PI_HUB_NO_OPEN wins over PI_WEB_NO_OPEN when both are set", () => {
  // PI_HUB_NO_OPEN unset → falls back to PI_WEB_NO_OPEN=1 → disabled
  assert.equal(
    parseLaunchOptions([], { PI_WEB_NO_OPEN: "1" }).openBrowser,
    false,
  );
  // PI_HUB_NO_OPEN explicitly false overrides PI_WEB_NO_OPEN=1
  assert.equal(
    parseLaunchOptions([], { PI_HUB_NO_OPEN: "0", PI_WEB_NO_OPEN: "1" }).openBrowser,
    true,
  );
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
    },
  );
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a non-negative integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PORT: "30141&whoami" }),
    /Port must be a non-negative integer/,
  );
});

test("supports PI_HUB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { PI_HUB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("supports legacy PI_WEB_HOSTNAME fallback", () => {
  assert.equal(
    parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
});

test("PI_HUB_HOSTNAME wins over PI_WEB_HOSTNAME when both are set", () => {
  assert.equal(
    parseLaunchOptions(
      [],
      { PI_HUB_HOSTNAME: "10.0.0.1", PI_WEB_HOSTNAME: "0.0.0.0" },
    ).hostname,
    "10.0.0.1",
  );
});
