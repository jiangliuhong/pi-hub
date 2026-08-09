/**
 * Shared DTO + access helpers for the Telegram API routes.
 *
 * Mirrors the scheduler's `lib/scheduler-dto.ts` / `scheduler-service-access.ts`
 * pattern: the domain layer uses its own types, the HTTP layer converts to
 * wire shapes here. Server-only (imports NextResponse).
 *
 * Token is NEVER serialized in any DTO (design doc §23.2, §21.1).
 */

import { NextResponse } from "next/server";

import {
  getTelegramRuntime,
  TelegramError,
  type TelegramSettings,
  type TelegramRuntimeInfo,
  type TelegramUser,
  type TelegramConversation,
  type TelegramStore,
} from "@/modules/telegram";

// ---------------------------------------------------------------------------
// Domain → wire DTOs
// ---------------------------------------------------------------------------

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export interface BotApiConfigDto {
  mode: "official" | "self-hosted";
  apiRoot: string;
  localMode: boolean;
  localFileRoot: string | null;
}

export interface TelegramConfigDto {
  enabled: boolean;
  privateOnly: boolean;
  defaultLocale: string;
  defaultWorkspace: string | null;
  toolVerbosity: TelegramSettings["toolVerbosity"];
  dropPendingUpdates: boolean;
  publicUrl: string | null;
  botApi: BotApiConfigDto;
  botId: number | null;
  botUsername: string | null;
  updatedAt: string;
}

export function configToDto(s: TelegramSettings): TelegramConfigDto {
  return {
    enabled: s.enabled,
    privateOnly: s.privateOnly,
    defaultLocale: s.defaultLocale,
    defaultWorkspace: s.defaultWorkspace,
    toolVerbosity: s.toolVerbosity,
    dropPendingUpdates: s.dropPendingUpdates,
    publicUrl: s.publicUrl,
    botApi: {
      mode: s.botApi.mode,
      apiRoot: s.botApi.apiRoot,
      localMode: s.botApi.localMode,
      localFileRoot: s.botApi.localFileRoot,
    },
    botId: s.botId,
    botUsername: s.botUsername,
    updatedAt: iso(s.updatedAt) ?? new Date(0).toISOString(),
  };
}

export interface TelegramStatusDto {
  configured: boolean;
  enabled: boolean;
  tokenSource: "environment" | "local" | null;
  tokenManagedByEnv: boolean;
  runtime: {
    status: TelegramRuntimeInfo["status"];
    leader: boolean;
    botId: number | null;
    botUsername: string | null;
    startedAt: string | null;
    lastUpdateAt: string | null;
    lastSuccessfulSendAt: string | null;
    pendingOutbox: number;
    activeConversations: number;
    error: string | null;
    errorCode: string | null;
    errorAt: string | null;
    recoveryAttempt: number;
    nextRecoveryAt: string | null;
  };
  userCount: number;
  conversationCount: number;
}

export function statusToDto(args: {
  tokenSource: "environment" | "local" | null;
  tokenManagedByEnv: boolean;
  runtime: { runtime: TelegramRuntimeInfo; settings: TelegramSettings | null };
  userCount: number;
  conversationCount: number;
}): TelegramStatusDto {
  const { tokenSource, tokenManagedByEnv, runtime, userCount, conversationCount } = args;
  const r = runtime.runtime;
  const settings = runtime.settings;
  return {
    configured: Boolean(tokenSource),
    enabled: Boolean(settings?.enabled),
    tokenSource,
    tokenManagedByEnv,
    runtime: {
      status: r.status,
      leader: r.leader,
      botId: r.botId,
      botUsername: r.botUsername,
      startedAt: iso(r.startedAt),
      lastUpdateAt: iso(r.lastUpdateAt),
      lastSuccessfulSendAt: iso(r.lastSuccessfulSendAt),
      pendingOutbox: r.pendingOutbox,
      activeConversations: r.activeConversations,
      error: r.error,
      errorCode: r.errorCode,
      errorAt: iso(r.errorAt),
      recoveryAttempt: r.recoveryAttempt,
      nextRecoveryAt: iso(r.nextRecoveryAt),
    },
    userCount,
    conversationCount,
  };
}

export interface TelegramUserDto {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
  role: TelegramUser["role"];
  enabled: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
}

export function userToDto(u: TelegramUser): TelegramUserDto {
  return {
    telegramUserId: u.telegramUserId,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    enabled: u.enabled,
    pairedAt: iso(u.pairedAt) ?? "",
    lastSeenAt: iso(u.lastSeenAt),
  };
}

export interface TelegramConversationDto {
  chatId: number;
  threadId: number;
  ownerUserId: number | null;
  activeSessionId: string | null;
  workspace: string | null;
  locale: string;
  state: TelegramConversation["state"];
  updatedAt: string;
}

export function conversationToDto(c: TelegramConversation): TelegramConversationDto {
  return {
    chatId: c.chatId,
    threadId: c.threadId,
    ownerUserId: c.ownerUserId,
    activeSessionId: c.activeSessionId,
    workspace: c.workspace,
    locale: c.locale,
    state: c.state,
    updatedAt: iso(c.updatedAt) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export function telegramErrorResponse(error: unknown): NextResponse {
  if (error instanceof TelegramError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  return NextResponse.json({ error: String(error) }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Service access helper (mirrors scheduler-service-access.ts)
// ---------------------------------------------------------------------------

export type StoreOrError =
  | { ok: true; store: TelegramStore }
  | { ok: false; response: NextResponse };

/**
 * Returns the live Telegram store or a ready-made 503 response when the
 * runtime hasn't started. Routes stay usable even when Telegram is disabled
 * or failed to start (UI shows a clear error instead of a 500).
 */
export function getStoreOrError(): StoreOrError {
  const runtime = getTelegramRuntime();
  const store = runtime?.getStore();
  if (!runtime || !store) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Telegram module not started",
          code: "TELEGRAM_UNAVAILABLE",
        },
        { status: 503 },
      ),
    };
  }
  return { ok: true, store };
}
