/**
 * Pi Hub Telegram domain types.
 *
 * These describe the persistence + business layer for Telegram integration
 * (design doc §11 SQLite data model, plus the open-source Bot API Server
 * fields from §7 of telegram-open-source-bot-api-server-design.zh-CN.md).
 *
 * Token is NEVER persisted in these structures — it lives in the secret
 * store (env var or `~/.pi/hub/secrets.json`, 0600).
 */

// ---------------------------------------------------------------------------
// Bot API endpoint (open-source Bot API Server design)
// ---------------------------------------------------------------------------

export type BotApiMode = "official" | "self-hosted";

export interface TelegramBotApiConfig {
  mode: BotApiMode;
  /** Service root, e.g. "https://api.telegram.org" or "https://tg-api.example.com". */
  apiRoot: string;
  /** Whether the self-hosted server runs with `--local`. */
  localMode: boolean;
  /** Required when localMode is true; the Bot API data dir Pi Hub may read. */
  localFileRoot: string | null;
}

// ---------------------------------------------------------------------------
// Top-level telegram_settings row (single-row, id = 1)
// ---------------------------------------------------------------------------

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

export interface TelegramSettings {
  enabled: boolean;
  privateOnly: boolean;
  defaultLocale: string;
  defaultWorkspace: string | null;
  toolVerbosity: ToolVerbosity;
  dropPendingUpdates: boolean;
  /**
   * When true, completion notifications are delivered to every enabled
   * owner/operator chat regardless of whether the conversation's workspace
   * matches the session's directory. When false (default), the default
   * delivery path only notifies chats whose workspace matches the session
   * cwd (explicit task subscriptions are never workspace-scoped).
   */
  allowAllWorkspaceNotifications: boolean;
  publicUrl: string | null;
  botApi: TelegramBotApiConfig;
  /** Bot identity (from getMe); null until validated. */
  botId: number | null;
  botUsername: string | null;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Users (whitelist + roles)
// ---------------------------------------------------------------------------

export type TelegramRole = "owner" | "operator" | "viewer";

export interface TelegramUser {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
  role: TelegramRole;
  enabled: boolean;
  pairedAt: number;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramChat {
  chatId: number;
  chatType: TelegramChatType;
  title: string | null;
  enabled: boolean;
  approvedBy: number | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Conversations (chat + topic)
// ---------------------------------------------------------------------------

export type ConversationState =
  | "idle"
  | "running"
  | "switching"
  | "transcribing"
  | "detached";

export interface TelegramConversation {
  chatId: number;
  /** `0` = chat root context (private chat or group without topics). */
  threadId: number;
  ownerUserId: number | null;

  activeSessionId: string | null;
  activeSessionPath: string | null;
  workspace: string | null;

  locale: string;
  toolVerbosity: ToolVerbosity | null;
  lastPrompt: string | null;

  /** Per-conversation model pin (set via /model). null = follow pi defaults. */
  modelProvider: string | null;
  /** Per-conversation model id (set via /model). null = follow pi defaults. */
  modelId: string | null;

  state: ConversationState;

  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

export interface TelegramPairingCode {
  id: string;
  /** bcrypt/scrypt-like hash of the 6-digit code; the plaintext is never stored. */
  codeHash: string;
  role: TelegramRole;
  expiresAt: number;
  usedAt: number | null;
  usedBy: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Callback actions (short token → payload; inline keyboards)
// ---------------------------------------------------------------------------

export type TelegramActionType =
  | "abort"
  | "retry"
  | "session_switch"
  | "task_run"
  | "task_open"
  | "model_switch"
  | "session_open"
  | "workspace_switch"
  | "confirm"
  | "cancel"
  | "view_detail";

export interface TelegramAction {
  token: string;
  actionType: TelegramActionType;
  payloadJson: string;
  userId: number | null;
  chatId: number;
  threadId: number;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Notification outbox (design doc §11.7)
// ---------------------------------------------------------------------------

export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxEventType =
  | "task_started"
  | "task_success"
  | "task_failure"
  | "task_deferred"
  | "test"
  | "runtime_warning";

export interface TelegramNotificationOutboxEntry {
  id: string;
  dedupeKey: string;
  chatId: number;
  threadId: number;
  eventType: OutboxEventType;
  payloadJson: string;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: number;
  sentAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Task subscriptions (design doc §11.8)
// ---------------------------------------------------------------------------

export interface TelegramTaskSubscription {
  taskId: string;
  chatId: number;
  threadId: number;
  notifyStarted: boolean;
  notifySuccess: boolean;
  notifyFailure: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Runtime lease (design doc §11.9)
// ---------------------------------------------------------------------------

export interface TelegramRuntimeLease {
  leaseName: string;
  ownerId: string;
  leaseUntil: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Runtime status (returned by /api/integrations/telegram/status)
// ---------------------------------------------------------------------------

export type TelegramRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "standby"
  | "stopping"
  | "error";

export type TelegramTokenSource = "environment" | "local" | null;

export interface TelegramRuntimeInfo {
  status: TelegramRuntimeStatus;
  leader: boolean;
  botId: number | null;
  botUsername: string | null;
  startedAt: number | null;
  lastUpdateAt: number | null;
  lastSuccessfulSendAt: number | null;
  pendingOutbox: number;
  activeConversations: number;
  error: string | null;
  errorCode: string | null;
  errorAt: number | null;
  /** Current auto-recovery attempt count (0 = not recovering). */
  recoveryAttempt: number;
  /** Next scheduled auto-recovery retry timestamp, or null if none pending. */
  nextRecoveryAt: number | null;
}
