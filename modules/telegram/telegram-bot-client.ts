/**
 * Grammy Bot client factory.
 *
 * Isolates all Grammy imports here so the rest of the Telegram module never
 * touches the Telegram SDK directly (AGENTS.local.md §1 — keep upstream /
 * third-party deps confined to one adapter). The client uses the configured
 * `apiRoot` so both the official cloud and a self-hosted Bot API Server work
 * with the same code path (open-source Bot API Server design §4).
 *
 * Business commands and handlers are registered by `telegram-runtime` /
 * `telegram-dispatcher`, not here. This module only builds a configured
 * `Bot` plus a raw `Api` for connection tests.
 */

import { Bot, Api, type Transformer } from "grammy";
import { TelegramError, TelegramErrorCode } from "./errors";
import type { TelegramErrorCodeValue } from "./errors";

/** Grammy HTTP client options shared by Bot + standalone Api. */
export interface BotClientOptions {
  token: string;
  apiRoot: string;
  /** Optional request timeout in ms (default 30s per design §13.3). */
  timeoutMs?: number;
  /** Optional request handler override (tests). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Validates a token has the expected `<digits>:<secret>` shape. */
export function isValidBotTokenShape(token: string): boolean {
  return /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test((token ?? "").trim());
}

/**
 * Detects the `deleteWebhook` 400 returned by self-hosted / relay Bot API
 * servers that do not manage webhook delivery state.
 */
function isUnsupportedDeleteWebhookResponse(res: {
  ok: boolean;
  error_code?: number;
  description?: string;
}): boolean {
  return (
    res.ok === false &&
    res.error_code === 400 &&
    /deleteWebhook is not supported|webhook delivery state/i.test(res.description ?? "")
  );
}

/**
 * Grammy API transformer that tolerates Bot API servers which reject
 * `deleteWebhook` (400 "method deleteWebhook is not supported: webhook
 * delivery state requires downstream support").
 *
 * Grammy calls `deleteWebhook` unconditionally inside `bot.start()` before
 * long polling, so without this shim such servers never reach the polling
 * loop and startup aborts with `TELEGRAM_API_ROOT_RESPONSE_INVALID`.
 *
 * The server hands the `{ ok: false }` envelope to the transformer chain
 * *before* Grammy would convert it into a thrown error (grammy
 * `ApiClient.callApi`), so we can rewrite that specific envelope to
 * success. On servers that fully implement `deleteWebhook` (official cloud
 * + a proper `tdlib/telegram-bot-api`) the genuine `{ ok: true }` envelope
 * passes through unchanged, so any real webhook is still cleared.
 */
function tolerateUnsupportedDeleteWebhook(): Transformer {
  return async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === "deleteWebhook" && isUnsupportedDeleteWebhookResponse(res)) {
      return { ok: true, result: true } as never;
    }
    return res;
  };
}

/**
 * Builds a configured Grammy Bot. The apiRoot is normalized by the caller
 * (`normalizeApiRoot`); we only pass it through to Grammy.
 */
export function createBot(options: BotClientOptions): Bot {
  const { token, apiRoot, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!token) {
    throw makeError(TelegramErrorCode.TELEGRAM_TOKEN_MISSING, "bot token is missing");
  }
  const bot = new Bot(token, {
    client: {
      apiRoot,
      timeoutSeconds: Math.ceil(timeoutMs / 1000),
      ...(options.client ?? {}),
    },
  });
  // Tolerate self-hosted/relay servers that reject deleteWebhook (see above).
  bot.api.config.use(tolerateUnsupportedDeleteWebhook());
  return bot;
}

/**
 * Builds a standalone Grammy Api (no long-polling loop) for one-shot calls
 * such as connection tests (`getMe`) and migration (`logOut`). Reuses the
 * same apiRoot so requests always hit the configured endpoint.
 */
export function createApi(options: BotClientOptions): Api {
  const { token, apiRoot, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!token) {
    throw makeError(TelegramErrorCode.TELEGRAM_TOKEN_MISSING, "bot token is missing");
  }
  return new Api(token, {
    apiRoot,
    timeoutSeconds: Math.ceil(timeoutMs / 1000),
    ...(options.client ?? {}),
  });
}

/** Minimal Bot identity returned by `getMe`. */
export interface BotIdentity {
  id: number;
  username: string;
  firstName: string;
  canJoinGroups?: boolean;
  canReadAllGroupMessages?: boolean;
  supportsInlineQueries?: boolean;
}

/** Normalizes Grammy's `getMe` result into the identity we persist. */
export function toBotIdentity(raw: {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}): BotIdentity {
  return {
    id: raw.id,
    username: raw.username ?? "",
    firstName: raw.first_name ?? "",
    canJoinGroups: raw.can_join_groups,
    canReadAllGroupMessages: raw.can_read_all_group_messages,
    supportsInlineQueries: raw.supports_inline_queries,
  };
}

// ---------------------------------------------------------------------------
// Error classification — Grammy throws `GrammyError` / `HttpError`; we map
// the important ones to our error model so callers (routes, runtime) get a
// stable code. Token strings inside messages are scrubbed by the caller.
// ---------------------------------------------------------------------------

function makeError(
  code: TelegramErrorCodeValue,
  message: string,
): TelegramError {
  return new TelegramError(code, message);
}

/** Telegram HTTP error shape (Grammy passes through `error_code` / `description`). */
interface TelegramHttpLike extends Error {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * Classifies an error thrown by Grammy into a `TelegramError`. Handles:
 *   - 401/404 → invalid token / auth failed
 *   - 409     → token in use (another long-polling or webhook consumer)
 *   - 429     → rate limited (preserves retry_after)
 *   - TLS/connection → unreachable / tls
 *   - otherwise      → send failed / response invalid
 */
export function classifyGrammyError(
  error: unknown,
  token: string,
): TelegramError {
  const message = scrub(error instanceof Error ? error.message : String(error), token);
  // GrammyHttpError / GrammyError both carry `error_code`.
  const http = error as TelegramHttpLike;
  const code = http?.error_code;
  const description = http?.description ?? message;

  if (code === 401 || code === 404 || /unauthori[sz]ed/i.test(description)) {
    return makeError(TelegramErrorCode.TELEGRAM_TOKEN_INVALID, scrub(description, token));
  }
  if (code === 409 || /terminated by other getUpdates request|conflict/i.test(description)) {
    return makeError(
      TelegramErrorCode.TELEGRAM_TOKEN_IN_USE,
      "Bot token is already in use by another getUpdates/webhook consumer (409).",
    );
  }
  if (code === 429) {
    const retryAfter = http.parameters?.retry_after;
    return makeError(
      TelegramErrorCode.TELEGRAM_RATE_LIMITED,
      `Rate limited by Telegram${retryAfter ? ` (retry after ${retryAfter}s)` : ""}.`,
    );
  }
  if (/certificate|self-signed|tls|ssl/i.test(message)) {
    return makeError(TelegramErrorCode.TELEGRAM_TLS_ERROR, scrub(message, token));
  }
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|getaddrinfo/i.test(
      message,
    )
  ) {
    return makeError(TelegramErrorCode.TELEGRAM_API_ROOT_UNREACHABLE, scrub(message, token));
  }
  if (code && code >= 400 && code < 500) {
    return makeError(TelegramErrorCode.TELEGRAM_API_ROOT_RESPONSE_INVALID, scrub(message, token));
  }
  return makeError(TelegramErrorCode.TELEGRAM_SEND_FAILED, scrub(message, token));
}

/** Scrubs the token from a string (defensive — errors sometimes echo it). */
function scrub(value: string, token: string): string {
  if (!token || !value) return value;
  return value.split(token).join("<token>");
}
