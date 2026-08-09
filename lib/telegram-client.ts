/**
 * Frontend fetch helper for the Pi Hub Telegram integration API.
 *
 * Mirrors `lib/scheduler-client.ts`: thin typed wrappers over
 * `/api/integrations/telegram/*`. The Bot Token is NEVER returned by any of
 * these endpoints (design doc §21, §23.2) — only its *source*.
 */

export type TokenSource = "environment" | "local" | null;
export type TelegramRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "standby"
  | "stopping"
  | "error";
export type BotApiMode = "official" | "self-hosted";

export interface BotApiConfigDto {
  mode: BotApiMode;
  apiRoot: string;
  localMode: boolean;
  localFileRoot: string | null;
}

export interface TelegramConfigDto {
  enabled: boolean;
  privateOnly: boolean;
  defaultLocale: string;
  defaultWorkspace: string | null;
  toolVerbosity: "all" | "summary" | "errors-only" | "none";
  dropPendingUpdates: boolean;
  allowAllWorkspaceNotifications: boolean;
  publicUrl: string | null;
  botApi: BotApiConfigDto;
  botId: number | null;
  botUsername: string | null;
  updatedAt: string;
}

export interface TelegramStatusDto {
  configured: boolean;
  enabled: boolean;
  tokenSource: TokenSource;
  tokenManagedByEnv: boolean;
  runtime: {
    status: TelegramRuntimeStatus;
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

export interface TelegramUserDto {
  telegramUserId: number;
  username: string | null;
  displayName: string | null;
  role: "owner" | "operator" | "viewer";
  enabled: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
}

export interface TelegramConversationDto {
  chatId: number;
  threadId: number;
  ownerUserId: number | null;
  activeSessionId: string | null;
  workspace: string | null;
  locale: string;
  state: string;
  updatedAt: string;
}

export interface PairingCodeResult {
  code: string;
  role: "owner" | "operator" | "viewer";
  expiresAt: string;
  isFirstUser: boolean;
}

export interface TestResult {
  ok: boolean;
  bot: { id: number; username: string; firstName: string };
  apiRoot: string;
  mode: string;
  localMode: boolean;
  localFileOk?: boolean;
}

async function asJson(res: Response): Promise<never> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // keep null
  }
  let message = `request failed (${res.status})`;
  if (body && typeof body === "object" && "error" in body) {
    const errorField = (body as { error: unknown }).error;
    if (typeof errorField === "string" && errorField.length > 0) {
      message = errorField;
    } else {
      message = String(errorField);
    }
  }
  const err = new Error(message) as Error & { code?: string; status?: number };
  err.code =
    body && typeof body === "object" && "code" in body
      ? String((body as { code: unknown }).code)
      : undefined;
  err.status = res.status;
  throw err;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return asJson(res);
  return (await res.json()) as T;
}

async function sendJson<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) return asJson(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getTelegramStatus = () => getJson<TelegramStatusDto>("/api/integrations/telegram/status");
export const getTelegramConfig = () => getJson<TelegramConfigDto>("/api/integrations/telegram/config");
export const updateTelegramConfig = (patch: Partial<TelegramConfigDto>) =>
  sendJson<TelegramConfigDto>("PUT", "/api/integrations/telegram/config", patch);
export const saveTelegramToken = (token: string) =>
  sendJson<{ ok: true }>("PUT", "/api/integrations/telegram/token", { token });
export const deleteTelegramToken = () =>
  sendJson<{ ok: true }>("DELETE", "/api/integrations/telegram/token");
export const testTelegramConnection = (body: { apiRoot?: string; localMode?: boolean; localFileRoot?: string }) =>
  sendJson<TestResult>("POST", "/api/integrations/telegram/test", body);
export const restartTelegramRuntime = () =>
  sendJson<{ ok: true }>("POST", "/api/integrations/telegram/restart");
export const issuePairingCode = (body: { role?: "owner" | "operator" | "viewer"; expiresInSeconds?: number }) =>
  sendJson<PairingCodeResult>("POST", "/api/integrations/telegram/pairing-codes", body);
export const listTelegramUsers = () =>
  getJson<{ items: TelegramUserDto[] }>("/api/integrations/telegram/users");
export const updateTelegramUser = (
  id: number,
  patch: Partial<Pick<TelegramUserDto, "role" | "enabled" | "displayName">>,
) => sendJson<TelegramUserDto>("PATCH", `/api/integrations/telegram/users/${id}`, patch);
export const deleteTelegramUser = (id: number) =>
  sendJson<{ ok: true; deleted: boolean }>("DELETE", `/api/integrations/telegram/users/${id}`);
export const listTelegramConversations = () =>
  getJson<{ items: TelegramConversationDto[] }>("/api/integrations/telegram/conversations");
export const deleteTelegramConversation = (id: string) =>
  sendJson<{ ok: true; deleted: boolean }>("DELETE", `/api/integrations/telegram/conversations/${id}`);
export const migrateBotApiServer = (toApiRoot: string) =>
  sendJson<{ ok: true; from: string; to: string; bot: { id: number; username: string } }>(
    "POST",
    "/api/integrations/telegram/migrate-bot-api-server",
    { toApiRoot },
  );

/**
 * Fire-and-forget a Telegram notification for a completed Web (manual) Agent
 * run. The server enriches it with session metadata and enqueues into the
 * outbox. Never throws on the caller — returns a promise the chat layer can
 * ignore. Returns `{ notified: 0 }` when Telegram is not configured.
 */
export const notifyTelegramManualRun = (
  body: { sessionId: string; status: "success" | "failed"; prompt?: string; errorMessage?: string; startedAt?: number; finishedAt?: number },
) =>
  sendJson<{ ok: boolean; notified: number; reason?: string; skipped?: boolean }>(
    "POST",
    "/api/integrations/telegram/notify-run",
    body,
  );
