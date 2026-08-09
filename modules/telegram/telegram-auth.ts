/**
 * Telegram authorization helpers (design doc §9, §12.2).
 *
 * Pure checks against the store — no network. The dispatcher calls these in
 * order: user allowlist → chat permission → rate limit → command. Pairing is
 * a special pre-auth command (only /start, /help, /pair are allowed before a
 * user is whitelisted).
 */

import type { TelegramStore } from "./telegram-store";
import type { TelegramChat, TelegramUser } from "./types";

export const PRE_AUTH_COMMANDS = new Set(["start", "help", "pair"]);

/** Resolves the (chatId, threadId) context key. threadId 0 = chat root. */
export function conversationKey(chatId: number, threadId?: number): string {
  return `${chatId}::${threadId ?? 0}`;
}

export interface AuthResult {
  allowed: boolean;
  user: TelegramUser | null;
  chat: TelegramChat | null;
  /** Machine-readable reason when disallowed (maps to an error code). */
  denyCode: string | null;
}

/**
 * Authorizes an incoming update's user + chat.
 *   - Private chat required when `privateOnly` is set (default true).
 *   - User must be whitelisted (except for pre-auth commands, handled by caller).
 *   - Group/supergroup chat must be explicitly approved.
 */
export function authorize(args: {
  store: TelegramStore;
  userId: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  privateOnly: boolean;
}): AuthResult {
  const { store, userId, chatId, chatType, privateOnly } = args;

  if (chatType !== "private" && privateOnly) {
    return { allowed: false, user: null, chat: null, denyCode: "TELEGRAM_PRIVATE_ONLY" };
  }

  const user = store.getUser(userId);
  if (!user || !user.enabled) {
    return { allowed: false, user: null, chat: null, denyCode: "TELEGRAM_USER_NOT_ALLOWED" };
  }

  const chat = store.getChat(chatId);
  if (chatType !== "private") {
    if (!chat || !chat.enabled) {
      return { allowed: false, user, chat, denyCode: "TELEGRAM_CHAT_NOT_ALLOWED" };
    }
  }

  // Touch lastSeenAt (best-effort, non-blocking).
  try {
    store.updateUser(userId, { lastSeenAt: Date.now() });
  } catch {
    // ignore
  }

  return { allowed: true, user, chat: chat ?? null, denyCode: null };
}

// ---------------------------------------------------------------------------
// Rate limiting (in-process, per design §9.5)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  /** Max commands per user per minute. */
  userPerMinute: number;
  /** Max prompts per conversation per minute. */
  conversationPerMinute: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  userPerMinute: 30,
  conversationPerMinute: 5,
};

/**
 * Tiny in-process sliding-window rate limiter. Reset on process restart;
 * adequate for V1 single-process. Returns true when the action is allowed.
 */
export class RateLimiter {
  private userBuckets = new Map<number, RateBucket>();
  private convBuckets = new Map<string, RateBucket>();
  private readonly config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
  }

  checkUser(userId: number): boolean {
    return this.bump(this.userBuckets, userId, this.config.userPerMinute);
  }

  checkConversation(chatId: number, threadId: number): boolean {
    return this.bump(
      this.convBuckets,
      conversationKey(chatId, threadId),
      this.config.conversationPerMinute,
    );
  }

  private bump(map: Map<number | string, RateBucket>, key: number | string, max: number): boolean {
    const now = Date.now();
    const bucket = map.get(key);
    if (!bucket || bucket.resetAt <= now) {
      map.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (bucket.count >= max) return false;
    bucket.count += 1;
    return true;
  }
}
