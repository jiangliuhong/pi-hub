/**
 * Telegram attachment file handling.
 *
 * Two modes (open-source Bot API Server design §5.2, §6):
 *
 *   - non-local: build an HTTPS download URL against the configured apiRoot.
 *     Nothing here hard-codes `api.telegram.org`.
 *
 *   - local (`--local`): `getFile` returns an absolute path on the Bot API
 *     Server. Pi Hub may read it only when it can access the shared dir.
 *     All reads are guarded by: absolute path, existence, containment inside
 *     the configured `localFileRoot` (after symlink resolution), and a size
 *     cap. This is the only place that resolves these paths.
 *
 * Pure URL helpers are exported for unit tests; the local-mode reader is
 * server-only (uses fs + realpath).
 */

import { existsSync, realpathSync, statSync } from "fs";

import { TelegramErrorCode, TelegramError } from "./errors";
import { buildTelegramFileUrl, normalizeLocalFileRoot } from "./telegram-config";

/** Re-exported so transport code imports file URLs from one place. */
export { buildTelegramFileUrl };

/** Default max attachment size (design doc §16.1: 25 MB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface LocalFileReadResult {
  /** Resolved absolute path that is safe to stream. */
  path: string;
  size: number;
}

/**
 * Resolves a `getFile`-style `file_path` for local mode into a path that is
 * guaranteed to live inside `localFileRoot` after symlink resolution and to be
 * under `maxBytes`. Throws `TELEGRAM_LOCAL_FILE_*` on any violation.
 *
 * Returns the realpath (not the original) so downstream consumers can't be
 * tricked by a symlink that pointed outside the root.
 */
export function resolveLocalFile(
  filePath: string,
  localFileRoot: string,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
): LocalFileReadResult {
  const root = normalizeLocalFileRoot(localFileRoot);
  if (!root) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT,
      "localFileRoot is not configured",
    );
  }
  if (!filePath || !filePath.startsWith("/")) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE,
      "local file path must be absolute",
    );
  }

  // First ensure the requested path is *lexically* contained (cheap guard),
  // then re-check after resolving symlinks (the real boundary, §16).
  const rootWithSlash = root.endsWith("/") ? root : root + "/";
  if (filePath !== root && !filePath.startsWith(rootWithSlash)) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT,
      "file path is outside the allowed local file root",
    );
  }

  let real: string;
  try {
    real = realpathSync(filePath);
  } catch {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE,
      `local file is not accessible: ${filePath}`,
    );
  }

  // realpathSync on the root itself too, in case the root is itself a symlink.
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // fall back to the configured (normalized) root
  }
  const realRootWithSlashResolved = realRoot.endsWith("/") ? realRoot : realRoot + "/";
  if (real !== realRoot && !real.startsWith(realRootWithSlashResolved)) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_OUTSIDE_ROOT,
      "file path escapes the allowed local file root after symlink resolution",
    );
  }

  let size: number;
  try {
    size = statSync(real).size;
  } catch {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE,
      `local file is not readable: ${filePath}`,
    );
  }
  if (size > maxBytes) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_FILE_TOO_LARGE,
      `local file exceeds the ${maxBytes}-byte limit`,
    );
  }
  return { path: real, size };
}

/** True when the path is lexically contained under root (pre-check only). */
export function isWithinRoot(filePath: string, root: string): boolean {
  if (!root) return false;
  const r = root.endsWith("/") ? root : root + "/";
  return filePath === root || filePath.startsWith(r);
}

/** Convenience: does a local file path look like a Bot API Server local path? */
export function looksLikeLocalPath(filePath: string): boolean {
  return typeof filePath === "string" && filePath.startsWith("/");
}

/** True when the original `file_path` should be fetched over HTTP. */
export function shouldFetchOverHttp(filePath: string): boolean {
  // Bot API Server (non-local) and official cloud both return relative paths
  // like "photos/file_1.jpg". A leading slash means an absolute local path,
  // which only happens under `--local`.
  return !looksLikeLocalPath(filePath);
}

/** Builds the http(s) download URL for a relative file_path. */
export function buildHttpFileUrl(
  apiRoot: string,
  token: string,
  filePath: string,
): string {
  return buildTelegramFileUrl(apiRoot, token, filePath);
}

/** Guard helper for callers that only ever expect an HTTP path. */
export function assertFileExists(path: string): void {
  if (!existsSync(path)) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_LOCAL_FILE_UNAVAILABLE,
      `file does not exist: ${path}`,
    );
  }
}
