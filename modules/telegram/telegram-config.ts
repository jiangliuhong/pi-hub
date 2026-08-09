/**
 * Telegram configuration helpers.
 *
 * Pure functions: defaults, apiRoot normalization/validation, local-file-root
 * validation, and token-source resolution. Zero external deps so they can be
 * unit-tested without a database or network (open-source Bot API Server
 * design §3, §5, §16; telegram-integration-design §10).
 *
 * Bot Token is NEVER handled here beyond masking — see `telegram-secret-store`.
 */

import { TelegramErrorCode, TelegramError } from "./errors";
import type { BotApiMode, TelegramBotApiConfig, TelegramSettings } from "./types";

export const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";
export const DEFAULT_TELEGRAM_FILE_ROOT_SUFFIX = "/file";

export const DEFAULT_TELEGRAM_SETTINGS: Omit<TelegramSettings, "updatedAt"> = {
  enabled: false,
  privateOnly: true,
  defaultLocale: "zh-CN",
  defaultWorkspace: null,
  toolVerbosity: "summary",
  dropPendingUpdates: true,
  allowAllWorkspaceNotifications: true,
  publicUrl: null,
  botApi: {
    mode: "official",
    apiRoot: DEFAULT_TELEGRAM_API_ROOT,
    localMode: false,
    localFileRoot: null,
  },
  botId: null,
  botUsername: null,
};

/** Environment variable that, when set, supplies the Bot Token. */
export const TELEGRAM_BOT_TOKEN_ENV = "PI_HUB_TELEGRAM_BOT_TOKEN";

// ---------------------------------------------------------------------------
// apiRoot normalization & validation
// ---------------------------------------------------------------------------

/**
 * Telegram Bot Tokens look like `123456789:AA...` — digits, colon, then an
 * alphanumeric segment. Used to reject apiRoots that accidentally contain a
 * token (open-source Bot API Server design §3.3, §16).
 */
const TOKEN_LIKE = /\d{6,}:[A-Za-z0-9_-]{20,}/;

/**
 * Normalizes a user-supplied apiRoot:
 *   - trims surrounding whitespace;
 *   - strips trailing slashes;
 *   - lowercases the scheme/host (keeps path case).
 *
 * Returns the normalized string or throws `TELEGRAM_API_ROOT_INVALID` when:
 *   - the value is empty;
 *   - the scheme is not http/https;
 *   - the URL embeds userinfo (user:pass@);
 *   - the path looks like it already contains a bot token.
 */
export function normalizeApiRoot(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot is empty",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot is not a valid URL",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot must use http or https",
    );
  }
  if (parsed.username || parsed.password) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot must not contain credentials",
    );
  }
  if (parsed.hash) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot must not contain a fragment",
    );
  }
  // Rebuild without a trailing slash and without search params (query in a
  // bot api root is almost always a mistake and would break Grammy path joins).
  const root = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(
    /\/+$/,
    "",
  )}`;
  if (TOKEN_LIKE.test(root)) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "apiRoot must not contain a bot token",
    );
  }
  return root;
}

/** True when the configured apiRoot points at the official Telegram cloud. */
export function isOfficialApiRoot(apiRoot: string): boolean {
  return normalizeApiRoot(apiRoot) === DEFAULT_TELEGRAM_API_ROOT;
}

/**
 * Builds the file-download root for non-local mode. Telegram serves files at
 * `<apiRoot>/file/bot<token>/<file_path>`. We only return the prefix up to
 * (and excluding) the token so callers can append it themselves without
 * leaking the token into reusable strings (open-source Bot API Server §5.2).
 */
export function buildFileApiRoot(apiRoot: string): string {
  const root = normalizeApiRoot(apiRoot);
  return `${root}${DEFAULT_TELEGRAM_FILE_ROOT_SUFFIX}`;
}

/**
 * Builds a complete non-local file-download URL. Token is interpolated by the
 * caller; this helper exists so transport code has one canonical builder and
 * nothing hard-codes `api.telegram.org` (open-source Bot API Server §5.2).
 */
export function buildTelegramFileUrl(
  apiRoot: string,
  token: string,
  filePath: string,
): string {
  if (!token) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_TOKEN_MISSING,
      "token is required to build a file URL",
    );
  }
  const root = normalizeApiRoot(apiRoot);
  const cleanPath = filePath.replace(/^\/+/, "");
  return `${root}${DEFAULT_TELEGRAM_FILE_ROOT_SUFFIX}/bot${token}/${cleanPath}`;
}

// ---------------------------------------------------------------------------
// Bot API config coercion
// ---------------------------------------------------------------------------

/** Normalizes a partial botApi patch into a complete, valid config. */
export function coerceBotApiConfig(
  patch: Partial<TelegramBotApiConfig> | null | undefined,
  current: TelegramBotApiConfig,
): TelegramBotApiConfig {
  const incomingMode: BotApiMode =
    patch?.mode === "self-hosted" || patch?.mode === "official"
      ? patch.mode
      : current.mode;

  const mode: BotApiMode = incomingMode;
  // When switching back to official, always reset apiRoot to the default so a
  // stale self-hosted value can't survive (open-source Bot API Server §3.2).
  const apiRoot =
    mode === "official"
      ? DEFAULT_TELEGRAM_API_ROOT
      : patch?.apiRoot != null
        ? normalizeApiRoot(patch.apiRoot)
        : current.apiRoot;

  // Local mode is a self-hosted-only feature; official mode forces it off.
  let localMode: boolean;
  if (mode === "official") {
    localMode = false;
  } else {
    localMode =
      patch?.localMode === true || patch?.localMode === false
        ? patch.localMode
        : current.localMode;
  }

  // localFileRoot only meaningful in self-hosted + local mode.
  let localFileRoot = current.localFileRoot;
  if (patch?.localFileRoot !== undefined) {
    localFileRoot = patch.localFileRoot ? patch.localFileRoot.trim() || null : null;
  }
  if (mode !== "self-hosted" || !localMode) {
    localFileRoot = null;
  }

  return { mode, apiRoot, localMode, localFileRoot };
}

// ---------------------------------------------------------------------------
// Local-mode file-root validation
// ---------------------------------------------------------------------------

/**
 * Validates a local file root for `--local` Bot API Server mode. Must be an
 * absolute path. Returns the trimmed value or null when disabled.
 * Path-traversal / symlink resolution happens at read time in telegram-files.
 */
export function normalizeLocalFileRoot(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "localFileRoot must be an absolute path",
    );
  }
  // Reject obvious traversal fragments; real traversal is caught at read time.
  if (/(^|\/)\.\.(\/|$)/.test(trimmed)) {
    throw new TelegramError(
      TelegramErrorCode.TELEGRAM_API_ROOT_INVALID,
      "localFileRoot must not contain '..'",
    );
  }
  return trimmed.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Token masking (logging)
// ---------------------------------------------------------------------------

/**
 * Returns a redacted representation of a bot token for logs. Always masks the
 * secret segment; keeps only enough of the numeric id to disambiguate
 * (design doc §23.2, §25 — never log the token).
 */
export function maskToken(token: string): string {
  if (!token) return "<empty>";
  const idx = token.indexOf(":");
  if (idx <= 0) return "<redacted>";
  const idPart = token.slice(0, idx);
  const shown = idPart.length > 4 ? idPart.slice(0, 4) : idPart;
  return `${shown}…<redacted>`;
}

/**
 * Scrubs a token out of an arbitrary string (e.g. an API error message that
 * leaked it). Replaces all occurrences of the literal token with `<token>`.
 */
export function scrubToken(value: string, token: string): string {
  if (!token || !value) return value;
  return value.split(token).join("<token>");
}
