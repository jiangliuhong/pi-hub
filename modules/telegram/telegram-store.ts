/**
 * Telegram persistence port.
 *
 * `SqliteTelegramStore` is the V1 implementation; the interface keeps the
 * domain decoupled from `node:sqlite` so a future in-memory fake can drive
 * tests. Mirrors the scheduler's `TaskStore` split.
 */

import type {
  OutboxEventType,
  OutboxStatus,
  TelegramAction,
  TelegramActionType,
  TelegramChat,
  TelegramConversation,
  TelegramNotificationOutboxEntry,
  TelegramPairingCode,
  TelegramRole,
  TelegramRuntimeLease,
  TelegramSettings,
  TelegramTaskSubscription,
  TelegramUser,
} from "./types";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsUpdate {
  enabled?: boolean;
  privateOnly?: boolean;
  defaultLocale?: string;
  defaultWorkspace?: string | null;
  toolVerbosity?: TelegramSettings["toolVerbosity"];
  dropPendingUpdates?: boolean;
  allowAllWorkspaceNotifications?: boolean;
  publicUrl?: string | null;
  botApiMode?: TelegramSettings["botApi"]["mode"];
  apiRoot?: string;
  localMode?: boolean;
  localFileRoot?: string | null;
  botId?: number | null;
  botUsername?: string | null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface UpsertUserInput {
  telegramUserId: number;
  username?: string | null;
  displayName?: string | null;
  role: TelegramRole;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export interface UpsertChatInput {
  chatId: number;
  chatType: TelegramChat["chatType"];
  title?: string | null;
  enabled?: boolean;
  approvedBy?: number | null;
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface UpsertConversationInput {
  chatId: number;
  threadId: number;
  ownerUserId?: number | null;
  locale?: string;
  workspace?: string | null;
  toolVerbosity?: TelegramConversation["toolVerbosity"] | null;
  modelProvider?: string | null;
  modelId?: string | null;
}

export interface ConversationUpdate {
  activeSessionId?: string | null;
  activeSessionPath?: string | null;
  workspace?: string | null;
  locale?: string;
  toolVerbosity?: TelegramConversation["toolVerbosity"] | null;
  lastPrompt?: string | null;
  state?: TelegramConversation["state"];
  ownerUserId?: number | null;
  modelProvider?: string | null;
  modelId?: string | null;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface CreatePairingCodeInput {
  id: string;
  codeHash: string;
  role: TelegramRole;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CreateActionInput {
  token: string;
  actionType: TelegramActionType;
  payloadJson: string;
  userId: number | null;
  chatId: number;
  threadId: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface CreateOutboxInput {
  id: string;
  dedupeKey: string;
  chatId: number;
  threadId: number;
  eventType: OutboxEventType;
  payloadJson: string;
  nextAttemptAt: number;
}

export interface OutboxUpdate {
  status?: OutboxStatus;
  attemptCount?: number;
  nextAttemptAt?: number;
  sentAt?: number | null;
  lastError?: string | null;
}

export interface LeaseInfo {
  ownerId: string;
  leaseUntil: number;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface TelegramStore {
  // lifecycle
  close(): void;

  // settings
  getSettings(): TelegramSettings;
  upsertSettings(patch: SettingsUpdate): TelegramSettings;

  // users
  getUser(telegramUserId: number): TelegramUser | null;
  listUsers(): TelegramUser[];
  upsertUser(input: UpsertUserInput): TelegramUser;
  updateUser(
    telegramUserId: number,
    patch: Partial<Pick<TelegramUser, "role" | "enabled" | "displayName" | "username" | "lastSeenAt">>,
  ): TelegramUser | null;
  deleteUser(telegramUserId: number): boolean;
  userCount(): number;

  // chats
  getChat(chatId: number): TelegramChat | null;
  upsertChat(input: UpsertChatInput): TelegramChat;
  deleteChat(chatId: number): boolean;

  // conversations
  getConversation(chatId: number, threadId: number): TelegramConversation | null;
  listConversations(): TelegramConversation[];
  upsertConversation(input: UpsertConversationInput): TelegramConversation;
  updateConversation(
    chatId: number,
    threadId: number,
    patch: ConversationUpdate,
  ): TelegramConversation | null;
  deleteConversation(chatId: number, threadId: number): boolean;
  conversationCount(): number;
  /** Recovers conversations left in a transient state by a crashed process. */
  resetTransientStates(now: number): number;

  // pairing
  createPairingCode(input: CreatePairingCodeInput): TelegramPairingCode;
  /** Lists unused, unexpired pairing codes (for constant-time verification scan). */
  listUnusedPairingCodes(now: number): TelegramPairingCode[];
  /** Finds an unused, unexpired code by hash and atomically marks it used. */
  consumePairingCode(
    codeHash: string,
    usedBy: number,
    now: number,
  ): TelegramPairingCode | null;
  purgeExpiredPairingCodes(now: number): number;

  // actions
  createAction(input: CreateActionInput): TelegramAction;
  getAction(token: string): TelegramAction | null;
  consumeAction(token: string, now: number): TelegramAction | null;
  purgeExpiredActions(now: number): number;

  // outbox
  enqueueNotification(input: CreateOutboxInput): TelegramNotificationOutboxEntry | null;
  listOutbox(status: OutboxStatus, limit: number): TelegramNotificationOutboxEntry[];
  updateOutbox(id: string, patch: OutboxUpdate): void;
  countOutbox(status: OutboxStatus): number;

  // task subscriptions
  listSubscriptionsForTask(taskId: string): TelegramTaskSubscription[];
  upsertSubscription(input: Omit<TelegramTaskSubscription, "createdAt" | "updatedAt">): TelegramTaskSubscription;
  deleteSubscription(taskId: string, chatId: number, threadId: number): boolean;

  // runtime lease
  tryAcquireLease(name: string, ownerId: string, leaseMs: number): boolean;
  renewLease(name: string, ownerId: string, leaseMs: number): boolean;
  releaseLease(name: string, ownerId: string): void;
  getLease(name: string): LeaseInfo | null;
}
