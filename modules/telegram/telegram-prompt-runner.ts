/**
 * TelegramPromptRunner — drives a Pi session from a Telegram prompt
 * (design §15.1, §8.3, §8.4).
 *
 * Flow per prompt:
 *   1. resolve a workspace + ensure the conversation row;
 *   2. open/resume the Pi session via the shared `startRpcSession`;
 *   3. acquire the session run lock from the AgentExecutionCoordinator
 *      (§8.3) — a busy session replies with the current owner (§15.6);
 *   4. subscribe to events BEFORE sending the prompt (§8.3), then send;
 *   5. stream assistant text + tool status through the renderer (§15.2);
 *   6. resolve on `prompt_done` / `prompt_error` — NOT the first `agent_end`
 *      (§8.4: retries/compaction/extensions may continue the same prompt);
 *   7. release the lock + mark the conversation idle.
 *
 * Abort/retry are owner-checked (§8.7) and reuse this runner's run bookkeeping.
 *
 * The Pi-session primitive (`startRpcSession`) and workspace chooser are
 * injected so this module stays free of a hard `lib/rpc-manager` import at the
 * type level (the runtime wires the real one in).
 */

import { randomUUID } from "crypto";

import { TelegramConversationService, ConversationBusyError, sessionLabel } from "./telegram-conversation-service";
import { TelegramStreamRenderer } from "./telegram-stream-renderer";
import { telegramOwnerKey } from "@/modules/agent-execution";
import {
  getAgentExecutionCoordinator,
  type AgentExecutionCoordinator,
  type AgentRunContext,
} from "@/modules/agent-execution";
import type { TelegramStore } from "./telegram-store";
import type { TelegramTransport } from "./telegram-transport";
import type { ToolVerbosity, TelegramConversation } from "./types";

/** Minimal shape needed from `lib/rpc-manager`'s startRpcSession. */
export interface SessionOpener {
  (
    sessionId: string,
    sessionFile: string,
    cwd: string | undefined,
    options?: Record<string, unknown>,
  ): Promise<{
    session: {
      sessionId: string;
      sessionFile: string;
      onEvent: (listener: (event: AgentEventLike) => void) => () => void;
      send: (command: Record<string, unknown>) => Promise<unknown>;
    };
    realSessionId: string;
  }>;
}

/** Structural subset of the SDK AgentEvent the renderer cares about. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentEventLike = any;

export interface PromptRunnerDeps {
  store: TelegramStore;
  conversationService: TelegramConversationService;
  coordinator?: AgentExecutionCoordinator;
  transport: TelegramTransport;
  openSession: SessionOpener;
  /** Picks the working directory for a new session; null = none available. */
  resolveWorkspace: (chatId: number, threadId: number, userId: number) => Promise<string | null>;
  defaultToolVerbosity?: ToolVerbosity;
}

export interface RunPromptInput {
  chatId: number;
  threadId: number;
  userId: number;
  userDisplayName?: string | null;
  chatType: "private" | "group" | "supergroup" | "channel";
  text: string;
  locale?: string;
}

export interface RunResult {
  ok: boolean;
  /** Present when the session was busy with another owner. */
  owner?: AgentRunContext;
  /** Present on internal failure (already surfaced to the user). */
  error?: string;
  runId?: string;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  chatId: number;
  threadId: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any;
  unsubscribe: () => void;
}

export class TelegramPromptRunner {
  private readonly coordinator: AgentExecutionCoordinator;
  /** chatId:threadId → active run (for /abort, /retry ownership). */
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly deps: PromptRunnerDeps) {
    this.coordinator = deps.coordinator ?? getAgentExecutionCoordinator();
  }

  /** True when this conversation currently has a Telegram-owned run. */
  isActive(chatId: number, threadId: number): boolean {
    return this.active.has(key(chatId, threadId));
  }

  async runPrompt(input: RunPromptInput): Promise<RunResult> {
    const { store, conversationService, transport } = this.deps;

    // 1. Workspace.
    const workspace = await this.deps.resolveWorkspace(input.chatId, input.threadId, input.userId);
    if (!workspace) {
      return { ok: false, error: "尚未选择工作区。请发送 /workspace 选择一个工作区后再试。" };
    }

    // 2. Ensure conversation row (busy check inside).
    let conv: TelegramConversation;
    try {
      conv = conversationService.ensure({
        chatId: input.chatId,
        threadId: input.threadId,
        userId: input.userId,
        chatType: input.chatType,
        workspace,
        locale: input.locale,
      });
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        return { ok: false, error: "当前会话正在执行，请稍后再试。" };
      }
      throw error;
    }

    // 3. Open / resume the Pi session.
    let session: ActiveRun["session"];
    let realSessionId: string;
    try {
      const resumed = Boolean(conv.activeSessionId && conv.activeSessionPath);
      const opened = await this.deps.openSession(
        resumed ? conv.activeSessionId! : "",
        resumed ? conv.activeSessionPath! : "",
        conv.workspace ?? workspace,
        {
          // Apply a per-conversation model pin set via /model. On a fresh
          // session this is applied atomically at construction. For a resume,
          // startRpcSession intentionally ignores initialModel when the session
          // already has messages, so we re-assert it below after open.
          ...(conv.modelProvider && conv.modelId
            ? { initialModel: { provider: conv.modelProvider, modelId: conv.modelId } }
            : {}),
        },
      );
      session = opened.session;
      realSessionId = opened.realSessionId;
      // Re-assert the model pin on a resumed session (startRpcSession does not
      // apply initialModel to a session with existing messages). Best-effort:
      // a failure here doesn't block the run.
      if (resumed && conv.modelProvider && conv.modelId) {
        try {
          await session.send({
            type: "set_model",
            provider: conv.modelProvider,
            modelId: conv.modelId,
          });
        } catch {
          // Non-fatal — the run continues with the session's current model.
        }
      }
      if (!resumed) {
        conversationService.setActiveSession(input.chatId, input.threadId, realSessionId, session.sessionFile);
      } else {
        conversationService.markRunning(input.chatId, input.threadId);
      }
    } catch (error) {
      conversationService.markIdle(input.chatId, input.threadId);
      return { ok: false, error: errMsg(error) };
    }

    // 4. Acquire the run lock (§8.3).
    const runId = randomUUID();
    const ownerKey = telegramOwnerKey(input.chatId, input.threadId);
    const acquired = this.coordinator.acquire({
      runId,
      sessionId: realSessionId,
      source: "telegram",
      ownerKey,
      sourceLabel: "Telegram",
    });
    if (!acquired.ok) {
      conversationService.markIdle(input.chatId, input.threadId);
      return { ok: false, owner: acquired.owner, error: ownerBusyMessage(acquired.owner) };
    }

    // 5. Subscribe BEFORE sending (§8.3), then render.
    conversationService.recordPrompt(input.chatId, input.threadId, input.text);
    const verbosity = conv.toolVerbosity ?? this.deps.defaultToolVerbosity ?? "summary";
    const renderer = new TelegramStreamRenderer({
      transport,
      store,
      chatId: input.chatId,
      threadId: input.threadId,
      toolVerbosity: verbosity,
    });
    renderer.startTyping();

    const done = new Promise<{ error?: string }>((resolve) => {
      const unsubscribe = session.onEvent((event: AgentEventLike) => {
        const type = event?.type as string | undefined;
        if (type === "message_update" || type === "message_end") {
          const text = extractAssistantText(event.message);
          if (text) renderer.appendText(text);
        } else if (type === "tool_execution_end") {
          renderer.recordTool(event.toolName ?? "tool", Boolean(event.isError));
        } else if (type === "prompt_error") {
          resolve({ error: event.errorMessage ?? "执行出错" });
        } else if (type === "prompt_done") {
          resolve({});
        }
      });
      // Stash for /abort.
      this.active.set(key(input.chatId, input.threadId), {
        runId,
        sessionId: realSessionId,
        chatId: input.chatId,
        threadId: input.threadId,
        session,
        unsubscribe,
      });
    });

    // 6. Send the prompt (fire-and-forget; completion arrives via events).
    try {
      await session.send({ type: "prompt", message: input.text, source: "rpc" });
    } catch (error) {
      this.cleanup(input.chatId, input.threadId, runId, realSessionId);
      await renderer.finalize(errMsg(error));
      return { ok: false, error: errMsg(error), runId };
    }

    // 7. Await completion, then finalize + release.
    const result = await done;
    this.cleanup(input.chatId, input.threadId, runId, realSessionId);
    await renderer.finalize(result.error);
    return { ok: true, runId };
  }

  /** Aborts the active Telegram-owned run for a conversation (§8.7). */
  async abort(chatId: number, threadId: number, userId: number, isOwner: boolean): Promise<RunResult> {
    const run = this.active.get(key(chatId, threadId));
    if (!run) return { ok: false, error: "当前没有正在执行的会话。" };
    // Owner check: only the run owner or a Pi Hub owner may abort.
    const owner = this.coordinator.getOwner(run.sessionId);
    if (owner && owner.ownerKey !== telegramOwnerKey(chatId, threadId) && !isOwner) {
      return { ok: false, owner, error: "无法停止其他客户端的执行。" };
    }
    try {
      await run.session.send({ type: "abort" });
    } catch (error) {
      return { ok: false, error: errMsg(error) };
    }
    return { ok: true, runId: run.runId };
  }

  /** Re-runs the last recorded prompt for a conversation (§14.1 /retry). */
  async retry(input: RunPromptInput): Promise<RunResult> {
    const conv = this.deps.conversationService.get(input.chatId, input.threadId);
    if (!conv?.lastPrompt) {
      return { ok: false, error: "没有可重试的上一次 Prompt。" };
    }
    return this.runPrompt({ ...input, text: conv.lastPrompt });
  }

  // ---- internal ------------------------------------------------------------

  private cleanup(chatId: number, threadId: number, runId: string, sessionId: string): void {
    const run = this.active.get(key(chatId, threadId));
    if (run) {
      run.unsubscribe();
      this.active.delete(key(chatId, threadId));
    }
    this.coordinator.release(sessionId, runId);
    this.deps.conversationService.markIdle(chatId, threadId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

function ownerBusyMessage(owner?: AgentRunContext): string {
  if (!owner) return "当前会话正在由其他客户端执行。";
  return `当前会话正在由 ${owner.sourceLabel} 执行，请稍后再试。`;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts concatenated assistant text from an Agent message's content blocks.
 * Pure + exported for unit testing.
 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") return b.text;
      }
      return "";
    })
    .join("");
}

/** Builds a display name for session labels. */
export function displayUsername(user: { username?: string | null; displayName?: string | null; telegramUserId: number }): string {
  return user.username ?? user.displayName ?? `user-${user.telegramUserId}`;
}

void sessionLabel;
