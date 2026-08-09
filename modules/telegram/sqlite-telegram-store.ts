/**
 * SQLite-backed implementation of `TelegramStore` using Node's built-in
 * `node:sqlite` (no native npm dependency). All persistence lives in the same
 * `~/.pi/hub/app.db` as the scheduler (AGENTS.local.md §8). The Bot Token is
 * deliberately NOT stored here — it lives in the secret store.
 *
 * Booleans are stored as 0/1 INTEGERs. The lease helpers mirror the scheduler
 * store's approach (manual BEGIN/COMMIT, owner-id equality check) so the two
 * lease implementations behave the same.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  DatabaseSync as DatabaseSyncType,
} from "node:sqlite";

import { migrateTelegram } from "./telegram-schema-migrations";
import { DEFAULT_TELEGRAM_SETTINGS } from "./telegram-config";
import type {
  CreateActionInput,
  CreateOutboxInput,
  CreatePairingCodeInput,
  LeaseInfo,
  OutboxUpdate,
  SettingsUpdate,
  TelegramStore,
  UpsertChatInput,
  UpsertConversationInput,
  UpsertUserInput,
  ConversationUpdate,
} from "./telegram-store";
import type {
  OutboxEventType,
  OutboxStatus,
  TelegramAction,
  TelegramActionType,
  TelegramChat,
  TelegramChatType,
  TelegramConversation,
  TelegramNotificationOutboxEntry,
  TelegramPairingCode,
  TelegramRole,
  TelegramRuntimeLease,
  TelegramSettings,
  TelegramTaskSubscription,
  TelegramUser,
  ToolVerbosity,
} from "./types";

type Db = DatabaseSyncType;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface SettingsRow {
  id: number;
  enabled: number;
  private_only: number;
  default_locale: string;
  default_workspace: string | null;
  tool_verbosity: ToolVerbosity;
  drop_pending_updates: number;
  allow_all_workspace_notifications: number;
  public_url: string | null;
  bot_id: number | null;
  bot_username: string | null;
  updated_at: number;
  bot_api_mode: "official" | "self-hosted";
  api_root: string;
  local_mode: number;
  local_file_root: string | null;
}

interface UserRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string | null;
  role: TelegramRole;
  enabled: number;
  paired_at: number;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ChatRow {
  chat_id: number;
  chat_type: TelegramChatType;
  title: string | null;
  enabled: number;
  approved_by: number | null;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  chat_id: number;
  thread_id: number;
  owner_user_id: number | null;
  active_session_id: string | null;
  active_session_path: string | null;
  workspace: string | null;
  locale: string;
  tool_verbosity: ToolVerbosity | null;
  last_prompt: string | null;
  model_provider: string | null;
  model_id: string | null;
  state: TelegramConversation["state"];
  created_at: number;
  updated_at: number;
}

interface PairingRow {
  id: string;
  code_hash: string;
  role: TelegramRole;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
  created_at: number;
}

interface ActionRow {
  token: string;
  action_type: TelegramActionType;
  payload_json: string;
  user_id: number | null;
  chat_id: number;
  thread_id: number;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

interface OutboxRow {
  id: string;
  dedupe_key: string;
  chat_id: number;
  thread_id: number;
  event_type: OutboxEventType;
  payload_json: string;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  sent_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface SubscriptionRow {
  task_id: string;
  chat_id: number;
  thread_id: number;
  notify_started: number;
  notify_success: number;
  notify_failure: number;
  created_at: number;
  updated_at: number;
}

interface LeaseRow {
  lease_name: string;
  owner_id: string;
  lease_until: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Row → domain mapping
// ---------------------------------------------------------------------------

function rowToSettings(r: SettingsRow): TelegramSettings {
  return {
    enabled: r.enabled === 1,
    privateOnly: r.private_only === 1,
    defaultLocale: r.default_locale,
    defaultWorkspace: r.default_workspace,
    toolVerbosity: r.tool_verbosity,
    dropPendingUpdates: r.drop_pending_updates === 1,
    allowAllWorkspaceNotifications: r.allow_all_workspace_notifications === 1,
    publicUrl: r.public_url,
    botApi: {
      mode: r.bot_api_mode,
      apiRoot: r.api_root,
      localMode: r.local_mode === 1,
      localFileRoot: r.local_file_root,
    },
    botId: r.bot_id,
    botUsername: r.bot_username,
    updatedAt: r.updated_at,
  };
}

function rowToUser(r: UserRow): TelegramUser {
  return {
    telegramUserId: r.telegram_user_id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    enabled: r.enabled === 1,
    pairedAt: r.paired_at,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToChat(r: ChatRow): TelegramChat {
  return {
    chatId: r.chat_id,
    chatType: r.chat_type,
    title: r.title,
    enabled: r.enabled === 1,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToConversation(r: ConversationRow): TelegramConversation {
  return {
    chatId: r.chat_id,
    threadId: r.thread_id,
    ownerUserId: r.owner_user_id,
    activeSessionId: r.active_session_id,
    activeSessionPath: r.active_session_path,
    workspace: r.workspace,
    locale: r.locale,
    toolVerbosity: r.tool_verbosity,
    lastPrompt: r.last_prompt,
    modelProvider: r.model_provider,
    modelId: r.model_id,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToPairing(r: PairingRow): TelegramPairingCode {
  return {
    id: r.id,
    codeHash: r.code_hash,
    role: r.role,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    usedBy: r.used_by,
    createdAt: r.created_at,
  };
}

function rowToAction(r: ActionRow): TelegramAction {
  return {
    token: r.token,
    actionType: r.action_type,
    payloadJson: r.payload_json,
    userId: r.user_id,
    chatId: r.chat_id,
    threadId: r.thread_id,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    createdAt: r.created_at,
  };
}

function rowToOutbox(r: OutboxRow): TelegramNotificationOutboxEntry {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    chatId: r.chat_id,
    threadId: r.thread_id,
    eventType: r.event_type,
    payloadJson: r.payload_json,
    status: r.status,
    attemptCount: r.attempt_count,
    nextAttemptAt: r.next_attempt_at,
    sentAt: r.sent_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToSubscription(r: SubscriptionRow): TelegramTaskSubscription {
  return {
    taskId: r.task_id,
    chatId: r.chat_id,
    threadId: r.thread_id,
    notifyStarted: r.notify_started === 1,
    notifySuccess: r.notify_success === 1,
    notifyFailure: r.notify_failure === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteTelegramStore implements TelegramStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Opens the database at `path`, applies PRAGMAs + migrations, returns a store. */
  static open(path: string): SqliteTelegramStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");
    try {
      migrateTelegram(db);
      ensureSettingsRow(db);
    } catch (error) {
      db.close?.();
      throw error;
    }
    return new SqliteTelegramStore(db);
  }

  close(): void {
    this.db.close?.();
  }

  // ---- settings ------------------------------------------------------------

  getSettings(): TelegramSettings {
    const row = this.db
      .prepare("SELECT * FROM telegram_settings WHERE id = 1")
      .get() as SettingsRow | undefined;
    return row ? rowToSettings(row) : { ...DEFAULT_TELEGRAM_SETTINGS, updatedAt: 0 };
  }

  upsertSettings(patch: SettingsUpdate): TelegramSettings {
    const current = this.getSettings();
    const next: TelegramSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.privateOnly !== undefined ? { privateOnly: patch.privateOnly } : {}),
      ...(patch.defaultLocale !== undefined ? { defaultLocale: patch.defaultLocale } : {}),
      ...(patch.defaultWorkspace !== undefined ? { defaultWorkspace: patch.defaultWorkspace } : {}),
      ...(patch.toolVerbosity !== undefined ? { toolVerbosity: patch.toolVerbosity } : {}),
      ...(patch.dropPendingUpdates !== undefined ? { dropPendingUpdates: patch.dropPendingUpdates } : {}),
      ...(patch.allowAllWorkspaceNotifications !== undefined
        ? { allowAllWorkspaceNotifications: patch.allowAllWorkspaceNotifications }
        : {}),
      ...(patch.publicUrl !== undefined ? { publicUrl: patch.publicUrl } : {}),
      ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
      ...(patch.botUsername !== undefined ? { botUsername: patch.botUsername } : {}),
      updatedAt: Date.now(),
      botApi: {
        mode: patch.botApiMode ?? current.botApi.mode,
        apiRoot: patch.apiRoot ?? current.botApi.apiRoot,
        localMode: patch.localMode ?? current.botApi.localMode,
        localFileRoot:
          patch.localFileRoot !== undefined ? patch.localFileRoot : current.botApi.localFileRoot,
      },
    };
    this.db
      .prepare(
        `UPDATE telegram_settings SET
          enabled = @enabled,
          private_only = @private_only,
          default_locale = @default_locale,
          default_workspace = @default_workspace,
          tool_verbosity = @tool_verbosity,
          drop_pending_updates = @drop_pending_updates,
          allow_all_workspace_notifications = @allow_all_workspace_notifications,
          public_url = @public_url,
          bot_id = @bot_id,
          bot_username = @bot_username,
          updated_at = @updated_at,
          bot_api_mode = @bot_api_mode,
          api_root = @api_root,
          local_mode = @local_mode,
          local_file_root = @local_file_root
        WHERE id = 1`,
      )
      .run({
        enabled: next.enabled ? 1 : 0,
        private_only: next.privateOnly ? 1 : 0,
        default_locale: next.defaultLocale,
        default_workspace: next.defaultWorkspace,
        tool_verbosity: next.toolVerbosity,
        drop_pending_updates: next.dropPendingUpdates ? 1 : 0,
        allow_all_workspace_notifications: next.allowAllWorkspaceNotifications ? 1 : 0,
        public_url: next.publicUrl,
        bot_id: next.botId,
        bot_username: next.botUsername,
        updated_at: next.updatedAt,
        bot_api_mode: next.botApi.mode,
        api_root: next.botApi.apiRoot,
        local_mode: next.botApi.localMode ? 1 : 0,
        local_file_root: next.botApi.localFileRoot,
      });
    return next;
  }

  // ---- users ---------------------------------------------------------------

  getUser(telegramUserId: number): TelegramUser | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_users WHERE telegram_user_id = ?")
      .get(telegramUserId) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  listUsers(): TelegramUser[] {
    const rows = this.db
      .prepare("SELECT * FROM telegram_users ORDER BY paired_at ASC")
      .all() as unknown as UserRow[];
    return rows.map(rowToUser);
  }

  upsertUser(input: UpsertUserInput): TelegramUser {
    const now = Date.now();
    const existing = this.getUser(input.telegramUserId);
    this.db
      .prepare(
        `INSERT INTO telegram_users (
          telegram_user_id, username, display_name, role, enabled,
          paired_at, last_seen_at, created_at, updated_at
        ) VALUES (
          @id, @username, @display_name, @role, @enabled,
          @paired_at, @last_seen_at, @created_at, @updated_at
        )
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          username = COALESCE(@username, username),
          display_name = COALESCE(@display_name, display_name),
          role = @role,
          enabled = @enabled,
          updated_at = @updated_at`,
      )
      .run({
        id: input.telegramUserId,
        username: input.username ?? null,
        display_name: input.displayName ?? null,
        role: input.role,
        enabled: input.enabled === false ? 0 : 1,
        paired_at: existing?.pairedAt ?? now,
        last_seen_at: existing?.lastSeenAt ?? null,
        created_at: existing?.createdAt ?? now,
        updated_at: now,
      });
    return this.getUser(input.telegramUserId)!;
  }

  updateUser(telegramUserId: number, patch: Partial<TelegramUser>): TelegramUser | null {
    const current = this.getUser(telegramUserId);
    if (!current) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE telegram_users SET
          username = @username,
          display_name = @display_name,
          role = @role,
          enabled = @enabled,
          last_seen_at = @last_seen_at,
          updated_at = @updated_at
        WHERE telegram_user_id = @id`,
      )
      .run({
        id: telegramUserId,
        username: patch.username !== undefined ? patch.username : current.username,
        display_name:
          patch.displayName !== undefined ? patch.displayName : current.displayName,
        role: patch.role ?? current.role,
        enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled ? 1 : 0,
        last_seen_at: patch.lastSeenAt !== undefined ? patch.lastSeenAt : current.lastSeenAt,
        updated_at: now,
      });
    return this.getUser(telegramUserId);
  }

  deleteUser(telegramUserId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM telegram_users WHERE telegram_user_id = ?")
      .run(telegramUserId);
    return result.changes > 0;
  }

  userCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM telegram_users")
      .get() as { n: number };
    return row.n;
  }

  // ---- chats ---------------------------------------------------------------

  getChat(chatId: number): TelegramChat | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_chats WHERE chat_id = ?")
      .get(chatId) as ChatRow | undefined;
    return row ? rowToChat(row) : null;
  }

  upsertChat(input: UpsertChatInput): TelegramChat {
    const now = Date.now();
    const existing = this.getChat(input.chatId);
    this.db
      .prepare(
        `INSERT INTO telegram_chats (
          chat_id, chat_type, title, enabled, approved_by, created_at, updated_at
        ) VALUES (
          @chat_id, @chat_type, @title, @enabled, @approved_by, @created_at, @updated_at
        )
        ON CONFLICT(chat_id) DO UPDATE SET
          chat_type = @chat_type,
          title = COALESCE(@title, title),
          enabled = @enabled,
          approved_by = COALESCE(@approved_by, approved_by),
          updated_at = @updated_at`,
      )
      .run({
        chat_id: input.chatId,
        chat_type: input.chatType,
        title: input.title ?? null,
        enabled: input.enabled === false ? 0 : 1,
        approved_by: input.approvedBy ?? null,
        created_at: existing?.createdAt ?? now,
        updated_at: now,
      });
    return this.getChat(input.chatId)!;
  }

  deleteChat(chatId: number): boolean {
    const result = this.db
      .prepare("DELETE FROM telegram_chats WHERE chat_id = ?")
      .run(chatId);
    return result.changes > 0;
  }

  // ---- conversations -------------------------------------------------------

  getConversation(chatId: number, threadId: number): TelegramConversation | null {
    const row = this.db
      .prepare(
        "SELECT * FROM telegram_conversations WHERE chat_id = ? AND thread_id = ?",
      )
      .get(chatId, threadId) as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  listConversations(): TelegramConversation[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM telegram_conversations ORDER BY updated_at DESC LIMIT 500",
      )
      .all() as unknown as ConversationRow[];
    return rows.map(rowToConversation);
  }

  upsertConversation(input: UpsertConversationInput): TelegramConversation {
    const now = Date.now();
    const existing = this.getConversation(input.chatId, input.threadId);
    this.db
      .prepare(
        `INSERT INTO telegram_conversations (
          chat_id, thread_id, owner_user_id,
          active_session_id, active_session_path, workspace,
          locale, tool_verbosity, last_prompt, state,
          model_provider, model_id,
          created_at, updated_at
        ) VALUES (
          @chat_id, @thread_id, @owner_user_id,
          @active_session_id, @active_session_path, @workspace,
          @locale, @tool_verbosity, @last_prompt, @state,
          @model_provider, @model_id,
          @created_at, @updated_at
        )
        ON CONFLICT(chat_id, thread_id) DO UPDATE SET
          owner_user_id = COALESCE(@owner_user_id, owner_user_id),
          locale = COALESCE(@locale, locale),
          workspace = COALESCE(@workspace, workspace),
          tool_verbosity = COALESCE(@tool_verbosity, tool_verbosity),
          model_provider = COALESCE(@model_provider, model_provider),
          model_id = COALESCE(@model_id, model_id),
          updated_at = @updated_at`,
      )
      .run({
        chat_id: input.chatId,
        thread_id: input.threadId,
        owner_user_id: input.ownerUserId ?? null,
        active_session_id: existing?.activeSessionId ?? null,
        active_session_path: existing?.activeSessionPath ?? null,
        workspace: input.workspace ?? existing?.workspace ?? null,
        locale: input.locale ?? existing?.locale ?? "zh-CN",
        tool_verbosity: input.toolVerbosity ?? existing?.toolVerbosity ?? null,
        last_prompt: existing?.lastPrompt ?? null,
        state: existing?.state ?? "idle",
        model_provider: input.modelProvider ?? existing?.modelProvider ?? null,
        model_id: input.modelId ?? existing?.modelId ?? null,
        created_at: existing?.createdAt ?? now,
        updated_at: now,
      });
    return this.getConversation(input.chatId, input.threadId)!;
  }

  updateConversation(
    chatId: number,
    threadId: number,
    patch: ConversationUpdate,
  ): TelegramConversation | null {
    const current = this.getConversation(chatId, threadId);
    if (!current) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE telegram_conversations SET
          active_session_id = @active_session_id,
          active_session_path = @active_session_path,
          workspace = @workspace,
          locale = @locale,
          tool_verbosity = @tool_verbosity,
          last_prompt = @last_prompt,
          state = @state,
          owner_user_id = @owner_user_id,
          model_provider = @model_provider,
          model_id = @model_id,
          updated_at = @updated_at
        WHERE chat_id = @chat_id AND thread_id = @thread_id`,
      )
      .run({
        chat_id: chatId,
        thread_id: threadId,
        active_session_id:
          patch.activeSessionId !== undefined ? patch.activeSessionId : current.activeSessionId,
        active_session_path:
          patch.activeSessionPath !== undefined ? patch.activeSessionPath : current.activeSessionPath,
        workspace: patch.workspace !== undefined ? patch.workspace : current.workspace,
        locale: patch.locale ?? current.locale,
        tool_verbosity: patch.toolVerbosity !== undefined ? patch.toolVerbosity : current.toolVerbosity,
        last_prompt: patch.lastPrompt !== undefined ? patch.lastPrompt : current.lastPrompt,
        state: patch.state ?? current.state,
        owner_user_id: patch.ownerUserId !== undefined ? patch.ownerUserId : current.ownerUserId,
        model_provider: patch.modelProvider !== undefined ? patch.modelProvider : current.modelProvider,
        model_id: patch.modelId !== undefined ? patch.modelId : current.modelId,
        updated_at: now,
      });
    return this.getConversation(chatId, threadId);
  }

  deleteConversation(chatId: number, threadId: number): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM telegram_conversations WHERE chat_id = ? AND thread_id = ?",
      )
      .run(chatId, threadId);
    return result.changes > 0;
  }

  conversationCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM telegram_conversations")
      .get() as { n: number };
    return row.n;
  }

  resetTransientStates(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE telegram_conversations
         SET state = 'idle', updated_at = @now
         WHERE state IN ('running', 'switching', 'transcribing')`,
      )
      .run({ now });
    return Number(result.changes);
  }

  // ---- pairing -------------------------------------------------------------

  createPairingCode(input: CreatePairingCodeInput): TelegramPairingCode {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO telegram_pairing_codes (
          id, code_hash, role, expires_at, used_at, used_by, created_at
        ) VALUES (@id, @code_hash, @role, @expires_at, NULL, NULL, @created_at)`,
      )
      .run({
        id: input.id,
        code_hash: input.codeHash,
        role: input.role,
        expires_at: input.expiresAt,
        created_at: now,
      });
    return rowToPairing(
      this.db
        .prepare("SELECT * FROM telegram_pairing_codes WHERE id = ?")
        .get(input.id) as unknown as PairingRow,
    );
  }

  listUnusedPairingCodes(now: number): TelegramPairingCode[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM telegram_pairing_codes WHERE used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC",
      )
      .all(now) as unknown as PairingRow[];
    return rows.map(rowToPairing);
  }

  consumePairingCode(
    codeHash: string,
    usedBy: number,
    now: number,
  ): TelegramPairingCode | null {
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM telegram_pairing_codes
           WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?`,
        )
        .get(codeHash, now) as PairingRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db
        .prepare(
          `UPDATE telegram_pairing_codes SET used_at = ?, used_by = ? WHERE id = ?`,
        )
        .run(now, usedBy, row.id);
      this.db.exec("COMMIT");
      return rowToPairing(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  purgeExpiredPairingCodes(now: number): number {
    const result = this.db
      .prepare("DELETE FROM telegram_pairing_codes WHERE expires_at < ?")
      .run(now);
    return Number(result.changes);
  }

  // ---- actions -------------------------------------------------------------

  createAction(input: CreateActionInput): TelegramAction {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO telegram_actions (
          token, action_type, payload_json, user_id, chat_id, thread_id,
          expires_at, used_at, created_at
        ) VALUES (@token, @action_type, @payload_json, @user_id, @chat_id, @thread_id,
                  @expires_at, NULL, @created_at)`,
      )
      .run({
        token: input.token,
        action_type: input.actionType,
        payload_json: input.payloadJson,
        user_id: input.userId,
        chat_id: input.chatId,
        thread_id: input.threadId,
        expires_at: input.expiresAt,
        created_at: now,
      });
    return this.getAction(input.token)!;
  }

  getAction(token: string): TelegramAction | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_actions WHERE token = ?")
      .get(token) as ActionRow | undefined;
    return row ? rowToAction(row) : null;
  }

  consumeAction(token: string, now: number): TelegramAction | null {
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM telegram_actions
           WHERE token = ? AND used_at IS NULL AND expires_at >= ?`,
        )
        .get(token, now) as ActionRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db
        .prepare("UPDATE telegram_actions SET used_at = ? WHERE token = ?")
        .run(now, token);
      this.db.exec("COMMIT");
      return rowToAction(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  purgeExpiredActions(now: number): number {
    const result = this.db
      .prepare("DELETE FROM telegram_actions WHERE expires_at < ?")
      .run(now);
    return Number(result.changes);
  }

  // ---- outbox --------------------------------------------------------------

  enqueueNotification(
    input: CreateOutboxInput,
  ): TelegramNotificationOutboxEntry | null {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO telegram_notification_outbox (
            id, dedupe_key, chat_id, thread_id, event_type, payload_json,
            status, attempt_count, next_attempt_at, sent_at, last_error,
            created_at, updated_at
          ) VALUES (
            @id, @dedupe_key, @chat_id, @thread_id, @event_type, @payload_json,
            'pending', 0, @next_attempt_at, NULL, NULL, @created_at, @updated_at
          )`,
        )
        .run({
          id: input.id,
          dedupe_key: input.dedupeKey,
          chat_id: input.chatId,
          thread_id: input.threadId,
          event_type: input.eventType,
          payload_json: input.payloadJson,
          next_attempt_at: input.nextAttemptAt,
          created_at: now,
          updated_at: now,
        });
      return rowToOutbox(
        this.db
          .prepare("SELECT * FROM telegram_notification_outbox WHERE id = ?")
          .get(input.id) as unknown as OutboxRow,
      );
    } catch {
      // UNIQUE(dedupe_key) → already enqueued; this is expected (idempotent).
      return null;
    }
  }

  listOutbox(status: OutboxStatus, limit: number): TelegramNotificationOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM telegram_notification_outbox
         WHERE status = ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
      )
      .all(status, limit) as unknown as OutboxRow[];
    return rows.map(rowToOutbox);
  }

  updateOutbox(id: string, patch: OutboxUpdate): void {
    const current = this.db
      .prepare("SELECT * FROM telegram_notification_outbox WHERE id = ?")
      .get(id) as OutboxRow | undefined;
    if (!current) return;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE telegram_notification_outbox SET
          status = @status,
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          sent_at = @sent_at,
          last_error = @last_error,
          updated_at = @updated_at
        WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status ?? current.status,
        attempt_count:
          patch.attemptCount !== undefined ? patch.attemptCount : current.attempt_count,
        next_attempt_at: patch.nextAttemptAt ?? current.next_attempt_at,
        sent_at: patch.sentAt !== undefined ? patch.sentAt : current.sent_at,
        last_error: patch.lastError !== undefined ? patch.lastError : current.last_error,
        updated_at: now,
      });
  }

  countOutbox(status: OutboxStatus): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM telegram_notification_outbox WHERE status = ?",
      )
      .get(status) as { n: number };
    return row.n;
  }

  // ---- subscriptions -------------------------------------------------------

  listSubscriptionsForTask(taskId: string): TelegramTaskSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM telegram_task_subscriptions WHERE task_id = ?")
      .all(taskId) as unknown as SubscriptionRow[];
    return rows.map(rowToSubscription);
  }

  upsertSubscription(
    input: Omit<TelegramTaskSubscription, "createdAt" | "updatedAt">,
  ): TelegramTaskSubscription {
    const now = Date.now();
    const existing = this.db
      .prepare(
        "SELECT created_at FROM telegram_task_subscriptions WHERE task_id = ? AND chat_id = ? AND thread_id = ?",
      )
      .get(input.taskId, input.chatId, input.threadId) as
      | { created_at: number }
      | undefined;
    this.db
      .prepare(
        `INSERT INTO telegram_task_subscriptions (
          task_id, chat_id, thread_id, notify_started, notify_success, notify_failure,
          created_at, updated_at
        ) VALUES (
          @task_id, @chat_id, @thread_id, @notify_started, @notify_success, @notify_failure,
          @created_at, @updated_at
        )
        ON CONFLICT(task_id, chat_id, thread_id) DO UPDATE SET
          notify_started = @notify_started,
          notify_success = @notify_success,
          notify_failure = @notify_failure,
          updated_at = @updated_at`,
      )
      .run({
        task_id: input.taskId,
        chat_id: input.chatId,
        thread_id: input.threadId,
        notify_started: input.notifyStarted ? 1 : 0,
        notify_success: input.notifySuccess ? 1 : 0,
        notify_failure: input.notifyFailure ? 1 : 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
    return rowToSubscription(
      this.db
        .prepare(
          "SELECT * FROM telegram_task_subscriptions WHERE task_id = ? AND chat_id = ? AND thread_id = ?",
        )
        .get(input.taskId, input.chatId, input.threadId) as unknown as SubscriptionRow,
    );
  }

  deleteSubscription(taskId: string, chatId: number, threadId: number): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM telegram_task_subscriptions WHERE task_id = ? AND chat_id = ? AND thread_id = ?",
      )
      .run(taskId, chatId, threadId);
    return result.changes > 0;
  }

  // ---- runtime lease -------------------------------------------------------

  tryAcquireLease(name: string, ownerId: string, leaseMs: number): boolean {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const existing = this.db
        .prepare("SELECT * FROM telegram_runtime_leases WHERE lease_name = ?")
        .get(name) as LeaseRow | undefined;
      const free =
        !existing || existing.lease_until < now || existing.owner_id === ownerId;
      if (!free) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO telegram_runtime_leases (lease_name, owner_id, lease_until, updated_at)
           VALUES (@name, @owner, @until, @now)
           ON CONFLICT(lease_name) DO UPDATE SET
             owner_id = @owner,
             lease_until = @until,
             updated_at = @now`,
        )
        .run({ name, owner: ownerId, until: now + leaseMs, now });
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(name: string, ownerId: string, leaseMs: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE telegram_runtime_leases SET lease_until = @until, updated_at = @now
         WHERE lease_name = @name AND owner_id = @owner`,
      )
      .run({ name, owner: ownerId, until: now + leaseMs, now });
    return result.changes > 0;
  }

  releaseLease(name: string, ownerId: string): void {
    this.db
      .prepare(
        "DELETE FROM telegram_runtime_leases WHERE lease_name = ? AND owner_id = ?",
      )
      .run(name, ownerId);
  }

  getLease(name: string): LeaseInfo | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_runtime_leases WHERE lease_name = ?")
      .get(name) as LeaseRow | undefined;
    return row
      ? { ownerId: row.owner_id, leaseUntil: row.lease_until }
      : null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Inserts the singleton settings row if missing (id locked to 1). */
function ensureSettingsRow(db: Db): void {
  db.exec("BEGIN");
  try {
    const row = db
      .prepare("SELECT id FROM telegram_settings WHERE id = 1")
      .get() as { id: number } | undefined;
    if (!row) {
      db.prepare(
        `INSERT INTO telegram_settings (id, updated_at) VALUES (1, ?)`,
      ).run(Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Cast helper for tests that inspect raw rows. */
export function rowToRuntimeLease(r: LeaseRow): TelegramRuntimeLease {
  return {
    leaseName: r.lease_name,
    ownerId: r.owner_id,
    leaseUntil: r.lease_until,
    updatedAt: r.updated_at,
  };
}
