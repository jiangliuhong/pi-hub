import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// npm 12+ refuses to fetch lockfile entries whose resolved URL points at a
// non-registry host (EALLOWREMOTE), so a mirror URL slipping into
// package-lock.json breaks `npm ci` in the publish workflow while older npm
// versions still pass. Keep every resolved URL on the official registry.
const ALLOWED_REGISTRIES = ["https://registry.npmjs.org/"];

test("package-lock.json resolves every package from an allowed registry", () => {
  const raw = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  const resolved = [...raw.matchAll(/"resolved":\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(resolved.length > 0, "package-lock.json contains no resolved URLs");

  const offenders = resolved.filter(
    (url) => !ALLOWED_REGISTRIES.some((registry) => url.startsWith(registry)),
  );
  assert.deepEqual(
    offenders,
    [],
    `Lockfile entries must point at ${ALLOWED_REGISTRIES.join(" or ")}. ` +
      "Rewrite the following URLs to the official registry (mirror tarballs are " +
      "byte-identical, so the integrity hash stays valid); otherwise npm >= 12 " +
      `fails with EALLOWREMOTE during publish:\n${offenders.join("\n")}`,
  );
});
