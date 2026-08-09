/**
 * TelegramConversationService — maps a (chat, topic) to a Pi session and owns
 * its busy/idle state (design §12, §13, §15.1).
 *
 * Each Telegram context key (chatId + threadId) binds to at most one active Pi
 * session. This service is a thin DB mapper: it creates/reads the conversation
 * row, records the active session id + file path once the prompt runner has
 * opened a Pi session, and flips the `state` between idle/running so a restart
 * recovers cleanly (§12.4 — `resetTransientStates` covers crashes).
 *
 * It deliberately does NOT open Pi sessions itself — that lives in
 * `lib/rpc-manager` and the prompt runner needs the wrapper to subscribe +
 * send. Keeping this module store-only makes it fully unit-testable.
 */

import type { TelegramStore } from "./telegram-store";
import type { TelegramConversation, ToolVerbosity } from "./types";

export interface EnsureConversationInput {
  chatId: number;
  threadId: number;
  userId: number;
  /** Chat type, used to create the chat row if missing (FK target). */
  chatType: "private" | "group" | "supergroup" | "channel";
  /** Working directory for new sessions. */
  workspace: string;
  locale?: string;
  toolVerbosity?: ToolVerbosity;
}

export class TelegramConversationService {
  constructor(private readonly store: TelegramStore) {}

  /** Returns the existing conversation binding, or null. */
  get(chatId: number, threadId: number): TelegramConversation | null {
    return this.store.getConversation(chatId, threadId);
  }

  /**
   * Ensures a conversation row exists (creating the chat row if needed) and
   * returns it. Does NOT open a Pi session — call `setActiveSession` after the
   * prompt runner creates/resumes one. Throws if the conversation is busy.
   */
  ensure(input: EnsureConversationInput): TelegramConversation {
    const conv = this.store.getConversation(input.chatId, input.threadId);
    if (conv) {
      if (conv.state !== "idle" && conv.state !== "detached") {
        throw new ConversationBusyError(input.chatId, input.threadId, conv.state);
      }
      return conv;
    }
    if (!this.store.getChat(input.chatId)) {
      this.store.upsertChat({
        chatId: input.chatId,
        chatType: input.chatType,
        approvedBy: input.userId,
      });
    }
    return this.store.upsertConversation({
      chatId: input.chatId,
      threadId: input.threadId,
      ownerUserId: input.userId,
      locale: input.locale,
      workspace: input.workspace,
      ...(input.toolVerbosity ? { toolVerbosity: input.toolVerbosity } : {}),
    });
  }

  /** Records the Pi session once the prompt runner has opened it. */
  setActiveSession(
    chatId: number,
    threadId: number,
    sessionId: string,
    sessionFile: string,
  ): void {
    this.store.updateConversation(chatId, threadId, {
      activeSessionId: sessionId,
      activeSessionPath: sessionFile,
      state: "running",
    });
  }

  /** Resumes an existing conversation's session (marks running). */
  markRunning(chatId: number, threadId: number): void {
    this.store.updateConversation(chatId, threadId, { state: "running" });
  }

  /** Marks the conversation idle after a run completes (§15.1). */
  markIdle(chatId: number, threadId: number): void {
    this.store.updateConversation(chatId, threadId, { state: "idle" });
  }

  /** Records the last prompt text (for /retry, §14.1). */
  recordPrompt(chatId: number, threadId: number, prompt: string): void {
    this.store.updateConversation(chatId, threadId, { lastPrompt: prompt });
  }

  /** Rebinds a conversation to a different existing session (§13.2 /sessions). */
  rebind(chatId: number, threadId: number, sessionId: string, sessionFile: string): void {
    this.store.updateConversation(chatId, threadId, {
      activeSessionId: sessionId,
      activeSessionPath: sessionFile,
      state: "idle",
    });
  }
}

/** Thrown when a conversation is already mid-run. */
export class ConversationBusyError extends Error {
  constructor(
    readonly chatId: number,
    readonly threadId: number,
    readonly state: string,
  ) {
    super(`conversation ${chatId}:${threadId} is busy (${state})`);
    this.name = "ConversationBusyError";
  }
}

/** Suggested session label (§13.1): `[TG] {name} · {stamp}`. */
export function sessionLabel(displayName: string, now = new Date()): string {
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `[TG] ${displayName} · ${stamp}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
