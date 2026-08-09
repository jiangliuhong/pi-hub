/**
 * Application-layer run metadata for a prompt.
 *
 * Pi SDK's own `source: "rpc"` field describes *how* the command was
 * delivered (in-process RPC), not *who* initiated it. That distinction
 * matters here: the same shared AgentSession can be driven by the Web UI,
 * a Telegram private chat, the scheduler, or another API caller, and the
 * completion-notification routing depends on the business source, not the
 * transport.
 *
 * `PromptRunMeta` carries that business source plus a stable run id so that:
 *  - terminal events (`prompt_done` / `prompt_error`) can be correlated back
 *    to the originating caller;
 *  - the Web → Telegram completion path only fires for Web-owned runs;
 *  - the notification outbox can dedupe on a stable key instead of wall-clock
 *    time.
 *
 * Producers attach this to the `prompt` command as `runMeta`; the RPC manager
 * echoes `runId` + `runSource` back on the synthesized terminal events.
 */

export type PromptRunSource = "web" | "telegram" | "scheduler" | "api";

export interface PromptRunMeta {
  /** Stable identifier for this single prompt invocation. */
  runId: string;
  /** Business surface that initiated the run. */
  source: PromptRunSource;
}

/**
 * Reads a `runMeta` value from an arbitrary command object and validates its
 * shape. Returns `null` for anything malformed or absent so callers can treat
 * unknown/legacy runs uniformly (allowed to refresh state, never allowed to
 * trigger external completion notifications).
 */
export function readRunMeta(command: unknown): PromptRunMeta | null {
  if (!command || typeof command !== "object") return null;
  const meta = (command as { runMeta?: unknown }).runMeta;
  if (!meta || typeof meta !== "object") return null;
  const { runId, source } = meta as { runId?: unknown; source?: unknown };
  if (typeof runId !== "string" || !runId) return null;
  if (
    source !== "web"
    && source !== "telegram"
    && source !== "scheduler"
    && source !== "api"
  ) {
    return null;
  }
  return { runId, source };
}
