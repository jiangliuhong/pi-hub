import { NextResponse } from "next/server";

import { resolveSessionPath, readSessionHeader, getSessionEntries } from "@/lib/session-reader";
import { resolveProject } from "@/lib/worktree";
import { getTelegramRuntime, notifyManualRun } from "@/modules/telegram";
import type { ManualRunNotifyInput } from "@/modules/telegram";

/**
 * Manual-run completion notification (Web chat → Telegram).
 *
 * Invoked by the web client when a user-driven Agent run finishes and the
 * user enabled the "notify via Telegram" toggle. The server enriches the
 * request with session metadata (name, cwd, last assistant text) and enqueues
 * a notification card into the Telegram outbox — it never sends directly.
 *
 * Always returns 200 so a flaky/unconfigured Telegram integration can never
 * surface an error in the chat UI; the result body reports whether anything
 * was actually enqueued.
 */

export const dynamic = "force-dynamic";

const MAX_RESULT_EXCERPT = 4000;

interface NotifyRunBody {
  sessionId?: unknown;
  status?: unknown;
  prompt?: unknown;
  errorMessage?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}

export async function POST(req: Request) {
  let body: NotifyRunBody;
  try {
    body = (await req.json()) as NotifyRunBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const status: "success" | "failed" =
    body.status === "failed" ? "failed" : "success";

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "sessionId is required" }, { status: 400 });
  }

  // Resolve the Telegram runtime/store. If Telegram is off or not yet started,
  // treat it as a successful no-op so the chat UI never errors.
  const runtime = getTelegramRuntime();
  const store = runtime?.getStore();
  if (!runtime || !store) {
    return NextResponse.json({
      ok: true,
      notified: false,
      reason: "telegram_not_configured",
    });
  }

  // Enrich with session metadata (best-effort; missing file is non-fatal).
  let sessionName: string | null = null;
  let cwd: string | null = null;
  let resultExcerpt: string | null = null;
  let promptExcerpt: string | null = null;
  try {
    const filePath = await resolveSessionPath(sessionId);
    if (filePath) {
      const header = readSessionHeader(filePath);
      if (header) {
        cwd = header.cwd ?? null;
      }
      const enriched = extractSessionMetadata(filePath);
      if (enriched.name) sessionName = enriched.name;
      if (enriched.resultExcerpt) resultExcerpt = enriched.resultExcerpt;
    }
  } catch (error) {
    console.warn(
      "[pi-hub:telegram] notify-run session enrich failed",
      error instanceof Error ? error.message : error,
    );
  }

  if (typeof body.prompt === "string" && body.prompt.trim()) {
    promptExcerpt = body.prompt.trim();
  }

  // Worktree-aware scoping: only resolve the project root when strict
  // workspace scoping is active (allowAll off). Resolving folds worktree
  // sessions back to the main repo so they match a chat bound to the project
  // root — consistent with how the rest of the app groups sessions.
  let sessionProjectRoot: string | null = null;
  if (store.getSettings().allowAllWorkspaceNotifications === false && cwd) {
    try {
      sessionProjectRoot = (await resolveProject(cwd)).projectRoot;
    } catch (error) {
      console.warn(
        "[pi-hub:telegram] notify-run projectRoot resolve failed",
        error instanceof Error ? error.message : error,
      );
      sessionProjectRoot = cwd; // graceful fallback to the raw cwd
    }
  }

  const input: ManualRunNotifyInput = {
    sessionId,
    status,
    sessionName,
    cwd,
    sessionProjectRoot,
    prompt: promptExcerpt,
    resultExcerpt,
    errorMessage:
      status === "failed"
        ? typeof body.errorMessage === "string" && body.errorMessage.trim()
          ? body.errorMessage.trim()
          : "Agent 运行未完成"
        : null,
    startedAt: typeof body.startedAt === "number" ? body.startedAt : null,
    finishedAt: typeof body.finishedAt === "number"
      ? body.finishedAt
      : Date.now(),
    publicUrl: runtime.getSettings()?.publicUrl ?? null,
  };

  try {
    const result = notifyManualRun(store, input);
    return NextResponse.json({ ok: true, notified: result.notified, skipped: result.skipped });
  } catch (error) {
    console.warn(
      "[pi-hub:telegram] notify-run enqueue failed",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ ok: true, notified: false, reason: "enqueue_failed" });
  }
}

/**
 * Reads the session file and returns (a) the most recent session name (from a
 * `session_info` entry) and (b) the last assistant text block (≤
 * MAX_RESULT_EXCERPT chars). Reads the raw entries (no context build) so it
 * stays cheap. Returns empty fields when nothing is found or the file cannot
 * be parsed.
 */
function extractSessionMetadata(filePath: string): {
  name: string | null;
  resultExcerpt: string | null;
} {
  let entries: ReturnType<typeof getSessionEntries>;
  try {
    entries = getSessionEntries(filePath);
  } catch {
    return { name: null, resultExcerpt: null };
  }
  let name: string | null = null;
  // Walk newest-first so the most recent session_info name and the latest
  // assistant text win.
  let resultExcerpt: string | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === "session_info" && !name) {
      const entryName = (entry as { name?: string }).name;
      if (typeof entryName === "string" && entryName.trim()) name = entryName.trim();
      continue;
    }
    if (entry.type !== "message" || resultExcerpt) continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: string }).text;
        if (typeof text === "string" && text.trim()) texts.push(text);
      }
    }
    if (texts.length > 0) {
      const joined = texts.join("\n");
      resultExcerpt =
        joined.length > MAX_RESULT_EXCERPT ? `${joined.slice(0, MAX_RESULT_EXCERPT)}…` : joined;
    }
  }
  return { name, resultExcerpt };
}
