/**
 * TelegramRuntime — process-wide singleton owning the Bot lifecycle.
 *
 * Phase-1 responsibilities (design doc §7, §28 阶段一):
 *   - idempotent startup (globalThis guard `__piHubTelegramRuntime`, §7.2)
 *   - DB open + migration + transient-state recovery (§12.4)
 *   - leader lease acquisition + renewal (§7.3) on `telegram-bot`
 *   - token resolution + getMe validation + long polling (§7.5)
 *   - 409 conflict detection → `error`/`TELEGRAM_TOKEN_IN_USE` (§7.6)
 *   - graceful stop (§7.7)
 *   - status reporting for /api/integrations/telegram/status
 *
 * The update handler is pluggable (`UpdateHandler`) so a test/fake can drive
 * the lifecycle without a live Bot. Real command routing lives in
 * `telegram-dispatcher.ts`, wired in `startTelegramRuntime()`.
 */

import { randomUUID } from "crypto";

import { classifyGrammyError } from "./telegram-bot-client";
import { TelegramError, TelegramErrorCode } from "./errors";
import { getDbPath, getDbPathDisplay, ensureHubHome } from "./telegram-paths";
import { resolveToken, isTokenManagedByEnv, type TelegramTokenSource } from "./telegram-secret-store";
import {
  DEFAULT_TELEGRAM_API_ROOT,
  maskToken,
  normalizeApiRoot,
} from "./telegram-config";
import { SqliteTelegramStore } from "./sqlite-telegram-store";
import type { TelegramStore } from "./telegram-store";
import { OutboxWorker } from "./telegram-outbox";
import type { TelegramTransport } from "./telegram-transport";
import type { TaskService } from "@/modules/scheduler";
import type {
  TelegramRuntimeInfo,
  TelegramRuntimeStatus,
  TelegramSettings,
} from "./types";

const LEASE_NAME = "telegram-bot";
const LEASE_MS = 15_000; // lease validity
const LEASE_RENEW_MS = 5_000; // renewal cadence

// Auto-recovery backoff for transient errors (409 conflict, network, TLS).
// Mirrors the outbox formula: base * 2^attempt, capped at MAX.
const RECOVERY_BASE_BACKOFF_MS = 4_000; // first retry ~4s after failure
const RECOVERY_MAX_BACKOFF_MS = 5 * 60_000; // cap at 5 minutes

// Error codes worth auto-retrying. Config errors (invalid/missing token,
// env-managed, validation) are excluded — retrying them is pointless.
const RECOVERABLE_ERROR_CODES = new Set<string>([
  TelegramErrorCode.TELEGRAM_TOKEN_IN_USE, // 409 conflict (core case)
  TelegramErrorCode.TELEGRAM_API_ROOT_UNREACHABLE, // transient network
  TelegramErrorCode.TELEGRAM_TLS_ERROR, // transient TLS
  TelegramErrorCode.TELEGRAM_SEND_FAILED, // fallback send/network failure
]);

export interface UpdateHandler {
  /** Called for each Telegram update; must never throw. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleUpdate(ctx: any): void | Promise<void>;
  /** Called once after the bot identity is confirmed (register menus, etc.). */
  onReady?(deps: RuntimeDeps): Promise<void>;
}

/** Factory that builds an UpdateHandler once the store exists (avoids the
 *  store/handler chicken-and-egg — the store is created inside start()). */
export type UpdateHandlerFactory = (store: TelegramStore) => UpdateHandler;

/** Builder for the OutboxWorker's transport getter — handed a live transport
 *  bound to the current leader's bot, or null when not leader. */
export type TransportGetter = () => TelegramTransport | null;

export interface RuntimeDeps {
  store: TelegramStore;
  settings: TelegramSettings;
  tokenSource: TelegramTokenSource;
  apiRoot: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: any;
}

interface RuntimeInternals {
  store: SqliteTelegramStore;
  ownerId: string;
  tokenSource: TelegramTokenSource;
  token: string;
  settings: TelegramSettings;
  handler: UpdateHandler | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: any | null;
  transport: TelegramTransport | null;
  outbox: OutboxWorker | null;
  leaseTimer: ReturnType<typeof setInterval> | null;
  leader: boolean;
  startedAt: number | null;
  lastUpdateAt: number | null;
  lastSuccessfulSendAt: number | null;
  status: TelegramRuntimeStatus;
  error: string | null;
  errorCode: string | null;
  errorAt: number | null;
  stopping: boolean;
  /** Whether bot.start() has resolved (it normally never does). */
  polling: boolean;
  // Auto-recovery bookkeeping. recoveryAttempt=0 means not in a recovery cycle.
  recoveryAttempt: number;
  nextRecoveryAt: number | null;
  /** Token that was last successfully applied — used to detect external changes. */
  lastAppliedToken: string;
}

declare global {
  var __piHubTelegramRuntime: TelegramRuntime | undefined;
}

export class TelegramRuntime {
  private inner: RuntimeInternals | null = null;

  get started(): boolean {
    return this.inner !== null;
  }

  /**
   * Starts the runtime. Idempotent within a process. Does NOT throw on
   * Telegram/network errors — those are captured into `status` so the Web UI
   * can show a clear error while the server keeps running (§7.6).
   */
  async start(options?: {
    store?: SqliteTelegramStore;
    handler?: UpdateHandler;
    /** Lazily builds the handler once the store is open (preferred over `handler`). */
    handlerFactory?: UpdateHandlerFactory;
    /** Test hook: skip the actual long-poll loop. */
    skipPolling?: boolean;
  }): Promise<void> {
    if (this.inner) return;

    ensureHubHome();
    const store = options?.store ?? SqliteTelegramStore.open(getDbPath());

    // Recover transient conversation states left by a crashed process (§12.4).
    const recovered = store.resetTransientStates(Date.now());
    if (recovered > 0) {
      console.warn(
        `[pi-hub:telegram] reset ${recovered} transient conversation(s) to idle`,
      );
    }

    const settings = store.getSettings();
    const resolved = resolveToken();
    const handler = options?.handlerFactory
      ? options.handlerFactory(store)
      : options?.handler ?? null;

    const inner: RuntimeInternals = {
      store,
      ownerId: randomUUID(),
      tokenSource: resolved.source,
      token: resolved.token,
      settings,
      handler,
      bot: null,
      transport: null,
      outbox: null,
      leaseTimer: null,
      leader: false,
      startedAt: null,
      lastUpdateAt: null,
      lastSuccessfulSendAt: null,
      status: "starting",
      error: null,
      errorCode: null,
      errorAt: null,
      stopping: false,
      polling: false,
      recoveryAttempt: 0,
      nextRecoveryAt: null,
      lastAppliedToken: resolved.token,
    };
    this.inner = inner;

    inner.leaseTimer = setInterval(() => this.renewLease(), LEASE_RENEW_MS);

    // Attempt to bring the bot up. Failures are recorded into status.
    if (!settings.enabled) {
      // Token may be configured but the integration switch is off — this is
      // the #1 silent "bot doesn't respond" cause. Surface it explicitly so it
      // can be told apart from a real error (errorCode stays null since this
      // is a user choice, not a fault).
      this.setRuntimeStatus("disabled", null, null);
      console.info(
        `[pi-hub:telegram] disabled: integration switch is off${
          resolved.token ? " (token is configured)" : " (no token configured)"
        }`,
      );
    } else if (!resolved.token) {
      this.setRuntimeStatus(
        "disabled",
        TelegramErrorCode.TELEGRAM_TOKEN_MISSING,
        "No bot token configured",
      );
    } else {
      await this.tryStartPolling(options?.skipPolling === true);
    }

    console.info(
      `[pi-hub:telegram] started (status=${inner.status}, leader=${inner.leader}, db=${getDbPathDisplay()})`,
    );
  }

  /** Stops polling + lease; safe to call multiple times (§7.7). */
  stop(): void {
    const inner = this.inner;
    if (!inner) return;
    inner.stopping = true;
    this.setRuntimeStatus("stopping", null, null);
    if (inner.outbox) inner.outbox.stop();
    inner.outbox = null;
    if (inner.leaseTimer) clearInterval(inner.leaseTimer);
    inner.leaseTimer = null;

    // Stop the bot gracefully. bot.start() returns a never-resolving promise;
    // bot.stop() makes it reject with ` bot.stop()` so we await with a guard.
    if (inner.bot && typeof inner.bot.stop === "function") {
      try {
        inner.bot.stop();
      } catch {
        // ignore
      }
    }
    inner.bot = null;
    inner.transport = null;
    inner.polling = false;

    try {
      inner.store.releaseLease(LEASE_NAME, inner.ownerId);
    } catch {
      // ignore
    }
    try {
      inner.store.close();
    } catch {
      // ignore
    }
    inner.leader = false;
    this.setRuntimeStatus("disabled", null, null);
    this.inner = null;
    console.info("[pi-hub:telegram] stopped");
  }

  /**
   * Reloads settings from the store, then restarts polling if needed. Used by
   * the config/token/test API routes after a change (§14.2, §7.6 "重新启动").
   */
  async restart(): Promise<void> {
    const inner = this.inner;
    if (!inner) return;
    const settings = inner.store.getSettings();
    const resolved = resolveToken();
    inner.settings = settings;
    inner.tokenSource = resolved.source;
    inner.token = resolved.token;

    // Stop existing polling without releasing the runtime singleton.
    if (inner.bot && typeof inner.bot.stop === "function") {
      try {
        inner.bot.stop();
      } catch {
        // ignore
      }
    }
    inner.bot = null;
    inner.transport = null;
    if (inner.outbox) inner.outbox.stop();
    inner.outbox = null;
    inner.polling = false;

    // restart() is driven by explicit user action (token/config change) —
    // treat it as a fresh attempt and clear any pending recovery backoff so
    // the new configuration isn't penalised for prior transient failures.
    inner.recoveryAttempt = 0;
    inner.nextRecoveryAt = null;

    if (!settings.enabled) {
      this.setRuntimeStatus("disabled", null, null);
      console.info(
        `[pi-hub:telegram] disabled: integration switch is off${
          resolved.token ? " (token is configured)" : " (no token configured)"
        }`,
      );
      return;
    }
    if (!resolved.token) {
      this.setRuntimeStatus(
        "disabled",
        TelegramErrorCode.TELEGRAM_TOKEN_MISSING,
        "No bot token configured",
      );
      return;
    }
    await this.tryStartPolling(false);
  }

  /** Status snapshot for /api/integrations/telegram/status (§21.1). */
  getStatus(): { runtime: TelegramRuntimeInfo; settings: TelegramSettings | null } {
    const inner = this.inner;
    if (!inner) {
      return {
        runtime: emptyRuntimeInfo(),
        settings: null,
      };
    }
    const pendingOutbox = inner.store.countOutbox("pending");
    const activeConversations = inner.store.conversationCount();
    return {
      runtime: {
        status: inner.status,
        leader: inner.leader,
        botId: inner.settings.botId,
        botUsername: inner.settings.botUsername,
        startedAt: inner.startedAt,
        lastUpdateAt: inner.lastUpdateAt,
        lastSuccessfulSendAt: inner.lastSuccessfulSendAt,
        pendingOutbox,
        activeConversations,
        error: inner.error,
        errorCode: inner.errorCode,
        errorAt: inner.errorAt,
        recoveryAttempt: inner.recoveryAttempt,
        nextRecoveryAt: inner.nextRecoveryAt,
      },
      settings: inner.settings,
    };
  }

  getStore(): TelegramStore | null {
    return this.inner?.store ?? null;
  }

  getSettings(): TelegramSettings | null {
    return this.inner?.settings ?? null;
  }

  isTokenManagedByEnv(): boolean {
    return isTokenManagedByEnv();
  }

  getTokenSource(): TelegramTokenSource {
    return this.inner?.tokenSource ?? resolveToken().source;
  }

  // ---- internal ------------------------------------------------------------

  private renewLease(): void {
    const inner = this.inner;
    if (!inner || inner.stopping) return;
    const wasLeader = inner.leader;
    inner.leader =
      inner.store.renewLease(LEASE_NAME, inner.ownerId, LEASE_MS) ||
      inner.store.tryAcquireLease(LEASE_NAME, inner.ownerId, LEASE_MS);
    if (wasLeader && !inner.leader) {
      console.warn("[pi-hub:telegram] lost leader lease");
      if (inner.outbox) inner.outbox.stop();
      inner.outbox = null;
      inner.transport = null;
      if (inner.bot && typeof inner.bot.stop === "function") {
        try {
          inner.bot.stop();
        } catch {
          // ignore
        }
      }
      inner.polling = false;
      this.setRuntimeStatus("standby", null, null);
    } else if (!wasLeader && inner.leader) {
      // Promoted from standby to leader — start polling now. This happens when
      // the runtime started before the lease was available (e.g. another
      // process held it) and later acquired it via renewal.
      console.info("[pi-hub:telegram] acquired leader lease, starting polling");
      void this.tryStartPolling(false);
      return;
    }

    // (A) Detect external token changes (secrets.json rewritten by another
    // process, or env var changed before this process saw it). Triggers an
    // immediate restart so a bot switch takes effect within ~5s with no
    // manual action. Only meaningful for the leader — standby instances will
    // pick up the new token when they next win the lease.
    if (inner.leader) {
      const latest = resolveToken();
      if (
        latest.token !== inner.lastAppliedToken ||
        latest.source !== inner.tokenSource
      ) {
        console.info("[pi-hub:telegram] token changed externally, restarting");
        void this.restart();
        return;
      }
    }

    // (B) Auto-recover from transient errors (409 conflict, network, TLS).
    // Polling is already stopped when we land here (the bot.start() catch set
    // status=error), so retrying is safe. Clear nextRecoveryAt before firing
    // so the next tick can't re-enter while tryStartPolling is still in its
    // async prologue (before inner.polling flips to true); the catch paths
    // re-schedule via scheduleRecoveryIfRecoverable, markRunning clears it.
    if (
      inner.leader &&
      inner.status === "error" &&
      inner.errorCode &&
      RECOVERABLE_ERROR_CODES.has(inner.errorCode) &&
      inner.nextRecoveryAt !== null &&
      Date.now() >= inner.nextRecoveryAt &&
      !inner.polling
    ) {
      console.info(
        `[pi-hub:telegram] auto-recovery attempt ${inner.recoveryAttempt + 1} for ${inner.errorCode}`,
      );
      inner.nextRecoveryAt = null;
      void this.tryStartPolling(false);
    }
  }

  private setRuntimeStatus(
    status: TelegramRuntimeStatus,
    errorCode: string | null,
    error: string | null,
  ): void {
    const inner = this.inner;
    if (!inner) return;
    const changing = inner.status !== status || inner.errorCode !== errorCode;
    inner.status = status;
    inner.errorCode = errorCode;
    inner.error = error;
    inner.errorAt = error || errorCode ? Date.now() : null;
    if (status === "running" && !inner.startedAt) {
      inner.startedAt = Date.now();
    }
    if (changing && (error || errorCode)) {
      console.warn(`[pi-hub:telegram] status=${status} code=${errorCode} error=${error}`);
    }
  }

  /**
   * Called whenever polling successfully reaches the running state — clears any
   * pending recovery backoff and remembers the token that's now in effect so
   * external token changes can be detected.
   */
  private markRunning(inner: RuntimeInternals): void {
    inner.recoveryAttempt = 0;
    inner.nextRecoveryAt = null;
    inner.lastAppliedToken = inner.token;
  }

  /**
   * After a polling/getMe failure, schedules an auto-recovery retry if the
   * error code is transient (409 conflict, network, TLS). Non-recoverable
   * config errors (invalid token, validation, etc.) leave the runtime parked
   * in `error` for the user to fix.
   */
  private scheduleRecoveryIfRecoverable(
    inner: RuntimeInternals,
    errorCode: string,
  ): void {
    if (!RECOVERABLE_ERROR_CODES.has(errorCode)) {
      // Stop any pending recovery cycle if we land on a non-recoverable error.
      inner.recoveryAttempt = 0;
      inner.nextRecoveryAt = null;
      return;
    }
    inner.recoveryAttempt += 1;
    const backoff = Math.min(
      RECOVERY_BASE_BACKOFF_MS * 2 ** (inner.recoveryAttempt - 1),
      RECOVERY_MAX_BACKOFF_MS,
    );
    inner.nextRecoveryAt = Date.now() + backoff;
  }

  private async tryStartPolling(skipPolling: boolean): Promise<void> {
    const inner = this.inner;
    if (!inner) return;

    // Acquire lease first; only the leader polls (§7.3).
    const got = inner.store.tryAcquireLease(LEASE_NAME, inner.ownerId, LEASE_MS);
    inner.leader = got;
    if (!got) {
      this.setRuntimeStatus("standby", null, null);
      return;
    }

    const apiRoot = normalizeApiRoot(
      inner.settings.botApi.apiRoot || DEFAULT_TELEGRAM_API_ROOT,
    );

    // Build the bot lazily so we don't import Grammy into the module graph
    // until we actually need it (keeps the runtime importable in tests).
    const { createBot } = await import("./telegram-bot-client");
    let bot;
    try {
      bot = createBot({ token: inner.token, apiRoot });
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : TelegramErrorCode.VALIDATION_ERROR;
      this.setRuntimeStatus(
        "error",
        code,
        error instanceof Error ? error.message : String(error),
      );
      this.scheduleRecoveryIfRecoverable(inner, code);
      return;
    }
    inner.bot = bot;

    // Build the leader-bound transport so the outbox worker can send.
    const { TelegramTransport } = await import("./telegram-transport");
    inner.transport = new TelegramTransport({ api: bot.api, token: inner.token });

    // Start the notification outbox worker (only the leader sends, §18.3).
    if (!inner.outbox) {
      inner.outbox = new OutboxWorker({
        store: inner.store,
        getTransport: () => inner.transport,
        onTerminal: (e) => {
          if (e.reason === "invalid_token") {
            console.warn(
              `[pi-hub:telegram] outbox stopped (invalid token): ${e.eventType} ${e.dedupeKey}`,
            );
          }
        },
      });
      inner.outbox.start();
    }

    // Validate identity (getMe) before polling.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const me = (await (bot.api as any).getMe()) as {
        id: number;
        username?: string;
        first_name?: string;
      };
      inner.store.upsertSettings({
        botId: me.id,
        botUsername: me.username ?? null,
      });
      inner.settings = inner.store.getSettings();
      console.info(
        `[pi-hub:telegram] bot verified @${me.username} (id=${me.id}) via ${apiRoot}`,
      );
    } catch (error) {
      const classified = classify(error);
      this.setRuntimeStatus("error", classified.code, classified.message);
      this.scheduleRecoveryIfRecoverable(inner, classified.code);
      console.warn(
        `[pi-hub:telegram] getMe failed against ${apiRoot} (token=${maskToken(
          inner.token,
        )}): ${classified.message}`,
      );
      return;
    }

    // Wire the update handler.
    if (inner.handler) {
      bot.use(async (ctx) => {
        inner.lastUpdateAt = Date.now();
        try {
          await inner.handler!.handleUpdate(ctx);
        } catch (error) {
          console.warn(
            "[pi-hub:telegram] update handler error",
            error instanceof Error ? error.message : error,
          );
        }
      });
      try {
        await inner.handler.onReady?.({
          store: inner.store,
          settings: inner.settings,
          tokenSource: inner.tokenSource,
          apiRoot,
          bot,
        });
      } catch (error) {
        console.warn(
          "[pi-hub:telegram] onReady failed",
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (skipPolling) {
      this.setRuntimeStatus("running", null, null);
      this.markRunning(inner);
      return;
    }

    // Start long polling (never resolves unless stopped). drop_pending_updates
    // is honored (§7.5) — old queued commands won't fire on restart.
    this.setRuntimeStatus("running", null, null);
    this.markRunning(inner);
    bot
      .start({
        drop_pending_updates: inner.settings.dropPendingUpdates,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "channel_post",
        ],
      })
      .then(() => {
        inner.polling = false;
        if (!inner.stopping && inner.status === "running") {
          this.setRuntimeStatus("standby", null, null);
        }
      })
      .catch((error: unknown) => {
        inner.polling = false;
        if (inner.stopping) return; // expected during stop()
        const classified = classify(error);
        this.setRuntimeStatus("error", classified.code, classified.message);
        this.scheduleRecoveryIfRecoverable(inner, classified.code);
        console.warn(
          `[pi-hub:telegram] polling stopped: ${classified.message}`,
        );
      });
    inner.polling = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyRuntimeInfo(): TelegramRuntimeInfo {
  return {
    status: "disabled",
    leader: false,
    botId: null,
    botUsername: null,
    startedAt: null,
    lastUpdateAt: null,
    lastSuccessfulSendAt: null,
    pendingOutbox: 0,
    activeConversations: 0,
    error: null,
    errorCode: null,
    errorAt: null,
    recoveryAttempt: 0,
    nextRecoveryAt: null,
  };
}

/** Maps a thrown value (likely from Grammy) into our error model with the code. */
function classify(error: unknown): { code: string; message: string } {
  if (error instanceof TelegramError) {
    return { code: error.code, message: error.message };
  }
  // Defer to the bot-client classifier; token scrubbing happens there.
  const e = classifyGrammyError(error, "");
  return { code: e.code, message: e.message };
}

// ---- singleton accessors ----------------------------------------------------

/**
 * Starts (idempotently) and returns the process-wide Telegram runtime. The
 * first call opens the DB + (if enabled) begins polling; later calls return
 * the same instance. Telegram/network failures are captured into status, not
 * thrown, so the web server keeps running (§7.6). Re-entrant via
 * `globalThis.__piHubTelegramRuntime` (§7.2).
 */
export async function startTelegramRuntime(): Promise<TelegramRuntime> {
  if (!globalThis.__piHubTelegramRuntime || !globalThis.__piHubTelegramRuntime.started) {
    const runtime = new TelegramRuntime();
    try {
      // Build the dispatcher with closures bound to the runtime so it can read
      // the live store/settings/bot after start().
      const { createDispatcher } = await import("./telegram-dispatcher");
      const { TelegramConversationService } = await import("./telegram-conversation-service");
      const { TelegramPromptRunner } = await import("./telegram-prompt-runner");
      // Lazily resolve the scheduler runtime (optional — Telegram may start
      // before/after the scheduler). Avoids a static import cycle.
      let schedulerRuntime: null | { getTaskService?: () => unknown } = null;
      const resolveScheduler = (): TaskService | null => {
        try {
          if (!schedulerRuntime) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            schedulerRuntime = (require("@/modules/scheduler") as {
              getSchedulerRuntime?: () => { getTaskService?: () => unknown } | undefined;
            }).getSchedulerRuntime?.() ?? null;
          }
          const svc = schedulerRuntime?.getTaskService?.();
          return (svc ?? null) as TaskService | null;
        } catch {
          return null;
        }
      };
      const handlerFactory: UpdateHandlerFactory = (store) => {
        const conversationService = new TelegramConversationService(store);
        const runnerCache: { runner: InstanceType<typeof TelegramPromptRunner> | null } = { runner: null };
        return createDispatcher({
          store,
          settings: () => runtime.getSettings() ?? ({} as never),
          reply: async (chatId, threadId, text, opts) => {
            const bot = (runtime as unknown as { inner: RuntimeInternals | null }).inner?.bot;
            if (!bot) return;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (bot.api as any).sendMessage(chatId, text, {
                ...(threadId ? { message_thread_id: threadId } : {}),
                ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
                ...(opts?.inlineKeyboard
                  ? {
                      reply_markup: {
                        inline_keyboard: opts.inlineKeyboard.map((row) =>
                          row.map((c) => ({ text: c.text, callback_data: c.callbackData })),
                        ),
                      },
                    }
                  : {}),
              });
            } catch (error) {
              console.warn(
                "[pi-hub:telegram] reply failed",
                error instanceof Error ? error.message : error,
              );
            }
          },
          answerCallback: async (callbackQueryId, text, showAlert) => {
            const bot = (runtime as unknown as { inner: RuntimeInternals | null }).inner?.bot;
            if (!bot) return;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (bot.api as any).answerCallbackQuery(callbackQueryId, {
                ...(text ? { text } : {}),
                ...(showAlert ? { show_alert: true } : {}),
              });
            } catch {
              // ignore — best-effort acknowledgment
            }
          },
          resolveScheduler,
          listWorkspaces: async () => {
            try {
              const { listAllSessions } = await import("@/lib/session-reader");
              const sessions = await listAllSessions();
              // Dedup by projectRoot (worktrees fold back to the main repo),
              // keep the most-recently-modified per project, then sort by that.
              const byRoot = new Map<string, number>(); // projectRoot -> latest modified (ms)
              for (const s of sessions) {
                if (!s.projectRoot) continue;
                const modifiedMs = Date.parse(s.modified);
                if (Number.isNaN(modifiedMs)) continue;
                const prev = byRoot.get(s.projectRoot);
                if (prev === undefined || modifiedMs > prev) byRoot.set(s.projectRoot, modifiedMs);
              }
              return [...byRoot.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([root]) => ({
                  path: root,
                  name: root.split("/").filter(Boolean).pop() ?? root,
                }));
            } catch (error) {
              console.warn(
                "[pi-hub:telegram] listWorkspaces failed",
                error instanceof Error ? error.message : error,
              );
              return [];
            }
          },
          getRunner: () => {
            const inner = (runtime as unknown as { inner: RuntimeInternals | null }).inner;
            const transport = inner?.transport ?? null;
            if (!transport) return null;
            if (!runnerCache.runner) {
              runnerCache.runner = new TelegramPromptRunner({
                store,
                conversationService,
                transport,
                openSession: async (sessionId, sessionFile, cwd, options) => {
                  const { startRpcSession } = await import("@/lib/rpc-manager");
                  return startRpcSession(sessionId, sessionFile, cwd, options);
                },
                resolveWorkspace: async (chatId, threadId) => {
                  // Workspace is chosen per-conversation via /workspace. There is
                  // no global default fallback — users must explicitly select one.
                  const conv = store.getConversation(chatId, threadId ?? 0);
                  return conv?.workspace ?? null;
                },
              });
            }
            return runnerCache.runner;
          },
          listAllSessions: async () => {
            const { listAllSessions } = await import("@/lib/session-reader");
            return listAllSessions();
          },
          getSessionState: async (sessionId) => {
            const { getRpcSession } = await import("@/lib/rpc-manager");
            const wrapper = getRpcSession(sessionId);
            if (!wrapper?.isAlive()) return null;
            try {
              const state = (await wrapper.send({ type: "get_state" })) as {
                model?: { id: string; provider: string };
                thinkingLevel?: string;
                messageCount?: number;
                isCompacting?: boolean;
                autoCompactionEnabled?: boolean;
                contextUsage?: { percent: number; tokens: number; contextWindow: number } | null;
              };
              return {
                model: state.model ?? null,
                thinkingLevel: state.thinkingLevel ?? "off",
                messageCount: state.messageCount ?? 0,
                isCompacting: Boolean(state.isCompacting),
                autoCompactionEnabled: Boolean(state.autoCompactionEnabled),
                contextUsage: state.contextUsage ?? null,
              };
            } catch {
              return null;
            }
          },
          listModels: async (workspace) => {
            const { loadModelsWithCache } = await import("@/lib/models-cache");
            const data = await loadModelsWithCache(workspace, async () => {
              const { createAgentSessionServices, getAgentDir } = await import(
                "@earendil-works/pi-coding-agent"
              );
              const { resolveVisibleModels } = await import("@/lib/model-scope");
              const { projectTrustReloadOptions } = await import("@/lib/project-trust");
              const agentDir = getAgentDir();
              // Gate untrusted project extensions the same way /api/models does
              // (#236): enumerating models imports + runs a repo's .pi/extensions
              // factories, so honor project trust here too.
              const trustReloadOptions = projectTrustReloadOptions(workspace, agentDir);
              const services = await createAgentSessionServices({
                cwd: workspace,
                agentDir,
                ...(trustReloadOptions
                  ? { resourceLoaderReloadOptions: trustReloadOptions }
                  : {}),
              });
              const settings = services.settingsManager;
              const scope = await resolveVisibleModels(
                services.modelRuntime,
                settings.getEnabledModels(),
              );
              const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
              return {
                models: {},
                modelList: scope.visible
                  .map((m) => ({ id: m.id, name: m.name, provider: m.provider }))
                  .sort((a, b) =>
                    collator.compare(a.name || a.id, b.name || b.id)
                    || collator.compare(a.provider, b.provider)
                    || collator.compare(a.id, b.id),
                  ),
                defaultModel: null,
                thinkingLevels: {},
                thinkingLevelMaps: {},
                thinkingLevelPins: {},
              };
            });
            return data.modelList;
          },
          applyModelToActiveSession: async (sessionId, provider, modelId) => {
            const { getRpcSession } = await import("@/lib/rpc-manager");
            const wrapper = getRpcSession(sessionId);
            if (!wrapper?.isAlive()) return false;
            await wrapper.send({ type: "set_model", provider, modelId });
            return true;
          },
          botUsername: () => runtime.getSettings()?.botUsername ?? null,
        });
      };
      await runtime.start({ handlerFactory });
      globalThis.__piHubTelegramRuntime = runtime;
    } catch (error) {
      console.error(
        "[pi-hub:telegram] init failed — web server continues without Telegram",
        error,
      );
      const failed = new TelegramRuntime();
      await failed.start({ handlerFactory: () => noopHandler }).catch(() => {});
      globalThis.__piHubTelegramRuntime = failed;
    }
  }
  return globalThis.__piHubTelegramRuntime;
}

const noopHandler: UpdateHandler = { async handleUpdate() {} };

/** Returns the current runtime (may be a failed/stopped instance). */
export function getTelegramRuntime(): TelegramRuntime | undefined {
  return globalThis.__piHubTelegramRuntime;
}
