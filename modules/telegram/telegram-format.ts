/**
 * Shared rendering helpers for Telegram notifications.
 *
 * Both the scheduled-task notifier and the manual-run notifier render
 * Telegram HTML messages with the same escaping/time/duration conventions.
 * Centralizing them keeps the two producers consistent and avoids drift.
 */

import type { TelegramStore } from "./telegram-store";

export interface ChatTarget {
  chatId: number;
  threadId: number;
}

/** Escapes Telegram HTML special characters in arbitrary text. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Formats epoch ms as a compact UTC timestamp. */
export function fmtTime(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return String(epochMs);
  }
}

/** Formats a millisecond duration as a localized "X 时 Y 分 Z 秒" string. */
export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/**
 * Default delivery targets for a notification with no explicit per-task
 * subscription: every enabled owner/operator user that has a private-chat
 * (threadId 0) conversation. Mirrors the fallback rule in
 * `TelegramTaskNotifier`.
 *
 * Workspace scoping: by default a chat only receives a notification when its
 * bound workspace matches the session's directory. Pass `allowAllWorkspaces`
 * (or enable the `allowAllWorkspaceNotifications` setting) to bypass the
 * check. Scoping is skipped whenever the session cwd or the conversation's
 * workspace is unknown, so legacy conversations with no workspace still get
 * notified.
 */
export interface ResolveTargetsOptions {
  /** The session/task directory to scope against; null/empty = never scope. */
  sessionCwd?: string | null;
  /** When true, ignore the workspace match entirely. */
  allowAllWorkspaces?: boolean;
}

export function resolveOwnerChatTargets(
  store: TelegramStore,
  options: ResolveTargetsOptions = {},
): ChatTarget[] {
  const settings = store.getSettings();
  const allowAll = options.allowAllWorkspaces ?? settings.allowAllWorkspaceNotifications;
  const sessionCwd = options.sessionCwd ?? null;

  const targets: ChatTarget[] = [];
  const seen = new Set<string>();

  const users = store.listUsers().filter(
    (u) => u.enabled && (u.role === "owner" || u.role === "operator"),
  );
  const conversations = store.listConversations();
  for (const conv of conversations) {
    if (conv.threadId !== 0) continue; // private chat root only
    const key = `${conv.chatId}:${conv.threadId}`;
    if (seen.has(key)) continue;
    if (conv.ownerUserId !== null && !users.some((u) => u.telegramUserId === conv.ownerUserId)) {
      continue;
    }
    if (!workspaceAllows(conv.workspace, sessionCwd, allowAll)) continue;
    seen.add(key);
    targets.push({ chatId: conv.chatId, threadId: conv.threadId });
  }
  return targets;
}

/**
 * True when a conversation bound to `convWorkspace` may receive a notification
 * for a session in `sessionCwd`. Scoping only applies when both paths are
 * known and non-empty; otherwise the chat qualifies (preserves the legacy
 * "deliver to every owner chat" behavior for conversations/sessions without a
 * workspace). `allowAll` disables scoping entirely.
 */
export function workspaceAllows(
  convWorkspace: string | null | undefined,
  sessionCwd: string | null | undefined,
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  const conv = normalizePath(convWorkspace);
  const cwd = normalizePath(sessionCwd);
  if (!conv || !cwd) return true; // can't scope when either side is unknown
  return conv === cwd;
}

/** Trims + strips trailing slashes so equivalent paths compare equal. */
function normalizePath(p: string | null | undefined): string {
  if (!p) return "";
  return p.trim().replace(/\/+$/, "");
}
