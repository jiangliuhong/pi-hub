import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Protocol version for the cross-repo `/api/client-info` contract consumed by
 * `pi-hub-desktop` (Tauri client) for local port probing. The client currently
 * supports exactly `[CLIENT_PROTOCOL_MIN, CLIENT_PROTOCOL_MAX] = [1, 1]`; the
 * field is a JSON number (not a string). Bump only when the stable identity
 * field set changes in a backward-incompatible way.
 *
 * See AGENTS.md §5.5 「跨仓库契约」.
 */
export const CLIENT_PROTOCOL_VERSION = 1;

/**
 * Stable service identity string. The client does an exact (case- and
 * separator-sensitive) match against this literal, so it must stay lowercase
 * with a hyphen.
 */
export const CLIENT_INFO_SERVICE = "pi-hub";

/**
 * Resolve the installed @jarome/pi-hub version from package.json. Resolved
 * relative to this file (never process.cwd.) so the reported version always
 * reflects the installed package regardless of where the server runs from —
 * matching the behavior of `bin/version.js` `buildVersionInfo()`.
 */
export function getPackageVersion(
  pkgDir: string = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
): string {
  const pkg = require(path.join(pkgDir, "package.json"));
  return pkg.version as string;
}

/**
 * Build the stable `/api/client-info` identity payload. Field names and order
 * are part of the cross-repo contract (the Rust client deserializes with
 * `#[serde(rename = "protocolVersion")]` and a strict `service` match).
 *
 * Intentionally contains only public identity fields — never credentials,
 * paths, env vars, or session info.
 */
export function buildClientInfo(
  pkgDir?: string,
): {
  service: string;
  protocolVersion: number;
  version: string;
} {
  return {
    service: CLIENT_INFO_SERVICE,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    version: getPackageVersion(pkgDir),
  };
}
