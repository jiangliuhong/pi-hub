/**
 * SQLite schema migrations for the Pi Hub Telegram module.
 *
 * Tables live in the SAME database as the scheduler (`~/.pi/hub/app.db`,
 * AGENTS.local.md §8). The scheduler's `schema_migrations` registry uses
 * plain INTEGER keys, so the Telegram module keeps its OWN registry
 * (`telegram_schema_migrations`) to stay independent and avoid touching the
 * scheduler's migration list (AGENTS.local.md §1, §17).
 */

import type { DatabaseSync } from "node:sqlite";

interface TelegramMigration {
  version: number;
  up: string;
}

const MIGRATIONS: TelegramMigration[] = [
  {
    version: 1,
    up: `
      -- Single-row settings (id locked to 1). Token is NOT here.
      CREATE TABLE IF NOT EXISTS telegram_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        private_only INTEGER NOT NULL DEFAULT 1,
        default_locale TEXT NOT NULL DEFAULT 'zh-CN',
        default_workspace TEXT,
        tool_verbosity TEXT NOT NULL DEFAULT 'summary'
          CHECK (tool_verbosity IN ('all', 'summary', 'errors-only', 'none')),
        drop_pending_updates INTEGER NOT NULL DEFAULT 1,
        public_url TEXT,
        bot_id INTEGER,
        bot_username TEXT,
        updated_at INTEGER NOT NULL,

        -- Open-source Bot API Server (design §7)
        bot_api_mode TEXT NOT NULL DEFAULT 'official'
          CHECK (bot_api_mode IN ('official', 'self-hosted')),
        api_root TEXT NOT NULL DEFAULT 'https://api.telegram.org',
        local_mode INTEGER NOT NULL DEFAULT 0,
        local_file_root TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telegram_users (
        telegram_user_id INTEGER PRIMARY KEY,
        username TEXT,
        display_name TEXT,
        role TEXT NOT NULL
          CHECK (role IN ('owner', 'operator', 'viewer')),
        enabled INTEGER NOT NULL DEFAULT 1,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telegram_chats (
        chat_id INTEGER PRIMARY KEY,
        chat_type TEXT NOT NULL
          CHECK (chat_type IN ('private', 'group', 'supergroup', 'channel')),
        title TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        approved_by INTEGER REFERENCES telegram_users(telegram_user_id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telegram_conversations (
        chat_id INTEGER NOT NULL REFERENCES telegram_chats(chat_id) ON DELETE CASCADE,
        thread_id INTEGER NOT NULL DEFAULT 0,
        owner_user_id INTEGER REFERENCES telegram_users(telegram_user_id),

        active_session_id TEXT,
        active_session_path TEXT,
        workspace TEXT,

        locale TEXT NOT NULL DEFAULT 'zh-CN',
        tool_verbosity TEXT,
        last_prompt TEXT,

        state TEXT NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle', 'running', 'switching', 'transcribing', 'detached')),

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,

        PRIMARY KEY (chat_id, thread_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_telegram_conversations_owner
      ON telegram_conversations(owner_user_id);

      CREATE TABLE IF NOT EXISTS telegram_pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL
          CHECK (role IN ('owner', 'operator', 'viewer')),
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_telegram_pairing_codes_expires
      ON telegram_pairing_codes(expires_at);

      CREATE TABLE IF NOT EXISTS telegram_actions (
        token TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        user_id INTEGER,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_telegram_actions_expires
      ON telegram_actions(expires_at);

      CREATE INDEX IF NOT EXISTS idx_telegram_actions_chat
      ON telegram_actions(chat_id, thread_id);

      CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        sent_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_telegram_outbox_pending
      ON telegram_notification_outbox(status, next_attempt_at);

      CREATE TABLE IF NOT EXISTS telegram_task_subscriptions (
        task_id TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0,
        notify_started INTEGER NOT NULL DEFAULT 0,
        notify_success INTEGER NOT NULL DEFAULT 1,
        notify_failure INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, chat_id, thread_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS telegram_runtime_leases (
        lease_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    // /model command: per-conversation model pin (§13.3). Nullable; null means
    // "follow pi defaults" (no override). Applied on session open/resume.
    version: 2,
    up: `
      ALTER TABLE telegram_conversations ADD COLUMN model_provider TEXT;
      ALTER TABLE telegram_conversations ADD COLUMN model_id TEXT;
    `,
  },
  {
    version: 3,
    up: `
      -- Workspace toggle for completion notifications (telegram manual-run +
      -- scheduled-task default delivery). Defaults to 1 (allow all): preserve
      -- the original "deliver to every owner/operator chat" behavior and avoid
      -- any workspace-consistency check out of the box. Set to 0 to enable
      -- strict (exact-directory) workspace scoping.
      ALTER TABLE telegram_settings
        ADD COLUMN allow_all_workspace_notifications INTEGER NOT NULL DEFAULT 1;
    `,
  },
];

/**
 * Applies all pending Telegram migrations. Idempotent for already-applied
 * versions. Each migration is a manual BEGIN/COMMIT transaction (node:sqlite
 * on this Node has no `.transaction()` helper, matching the scheduler). Uses
 * a dedicated `telegram_schema_migrations` registry so the scheduler's
 * `migrate()` and registry are never touched.
 */
export function migrateTelegram(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM telegram_schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const now = Date.now();
  let lastApplied = -1;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      lastApplied = migration.version;
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.up);
      db
        .prepare(
          "INSERT INTO telegram_schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(migration.version, now);
      db.exec("COMMIT");
      lastApplied = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return lastApplied;
}
