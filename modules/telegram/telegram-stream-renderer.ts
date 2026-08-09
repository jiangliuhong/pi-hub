/**
 * TelegramStreamRenderer — turns Agent text/tool events into a live Telegram
 * message (design §15.2, §15.3, §15.5).
 *
 * Behaviour:
 *   - the first text delta creates the message;
 *   - subsequent deltas re-edit the same message, debounced (§15.2 ~1.5s) so
 *     we never call the Telegram API per-token;
 *   - a "停止 / Stop" inline button is shown while running and removed on
 *     completion;
 *   - final output exceeding the safe limit is split into multiple messages
 *     (§15.3);
 *   - tool verbosity (§15.5) controls whether tool start/end status is shown.
 *
 * The renderer owns NO state beyond the current run; it is created per prompt.
 * It is transport-agnostic (any object with sendMessage/editMessageText/
 * editMessageReplyMarkup) so it is unit-testable without a live bot.
 */

import { ActionService } from "./telegram-actions";
import type { TelegramStore } from "./telegram-store";
import type { TelegramTransport } from "./telegram-transport";
import type { InlineKeyboardRows } from "./telegram-outbox";
import type { ToolVerbosity } from "./types";
import { chunkPlainText, markdownToTelegramHtml } from "./telegram-html";

export interface RendererDeps {
  transport: Pick<
    TelegramTransport,
    "sendMessage" | "editMessageText" | "editMessageReplyMarkup" | "sendChatAction"
  >;
  store: TelegramStore;
  chatId: number;
  threadId?: number;
  /** Defaults to "summary". */
  toolVerbosity?: ToolVerbosity;
  /** Debounce window for edits (ms). Default 1500 (§15.2). */
  debounceMs?: number;
  /** Typing chat-action refresh interval (ms). Default 4500 (§15.2). */
  typingIntervalMs?: number;
}

export interface StopButton {
  rows: InlineKeyboardRows;
}

export class TelegramStreamRenderer {
  private messageId: number | null = null;
  private accumulated = "";
  private toolCalls = 0;
  private toolErrors = 0;
  private failedTools: string[] = [];
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private done = false;

  private readonly debounceMs: number;
  private readonly typingIntervalMs: number;
  private readonly toolVerbosity: ToolVerbosity;
  private readonly stopButton: { callbackData: string; rows: InlineKeyboardRows } | null;

  constructor(private readonly deps: RendererDeps) {
    this.debounceMs = deps.debounceMs ?? 1_500;
    this.typingIntervalMs = deps.typingIntervalMs ?? 4_500;
    this.toolVerbosity = deps.toolVerbosity ?? "summary";
    this.stopButton = this.createStopButton();
  }

  /** Begins the typing indicator loop. Pair with stopTyping()/finalize(). */
  startTyping(): void {
    this.typingTimer = setInterval(() => {
      void this.deps.transport
        .sendChatAction(this.deps.chatId, "typing", this.deps.threadId)
        .catch(() => {});
    }, this.typingIntervalMs);
  }

  stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /**
   * Sets the assistant text from a streaming snapshot and schedules a debounced
   * edit.
   *
   * pi's `message_update` events carry the full accumulated message so far
   * (not a delta), so we replace rather than append — otherwise the text would
   * grow on every event and explode into dozens of chunked messages.
   */
  appendText(text: string): void {
    if (this.done) return;
    this.accumulated = text;
    this.scheduleEdit();
  }

  /** Records a tool execution (for summary/error-only verbosity). */
  recordTool(name: string, isError: boolean): void {
    this.toolCalls++;
    if (isError) {
      this.toolErrors++;
      this.failedTools.push(name);
    }
    if (this.toolVerbosity === "all") {
      this.scheduleEdit();
    }
  }

  /** Finalizes the message: removes the stop button, applies verbosity footer. */
  async finalize(error?: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.stopTyping();
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    const footer = this.buildFooter(error);
    const full = (this.accumulated + footer).trim();
    await this.sendChunked(full, /* removeButtons */ true);
  }

  // ---- internal ------------------------------------------------------------

  private scheduleEdit(): void {
    if (this.editTimer) return;
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.flushEdit().catch(() => {});
    }, this.debounceMs);
  }

  private async flushEdit(): Promise<void> {
    if (this.done) return;
    const body = this.renderBody(/* running */ true);
    if (this.messageId === null) {
      // Lazily create the message on the first flush, then subsequent edits
      // update it in place. Without this, edits target messageId 0 and no-op.
      await this.ensureMessageCreated();
      if (this.messageId === null) return; // creation failed; give up silently
    }
    try {
      await this.deps.transport.editMessageText({
        chatId: this.deps.chatId,
        messageId: this.messageId,
        text: body,
        parseMode: "HTML",
        ...(this.stopButton ? { inlineKeyboard: this.stopButton.rows } : {}),
      });
    } catch {
      // ignore
    }
  }

  /** Ensures the Telegram message exists before editing. Call before flush. */
  async ensureMessageCreated(): Promise<void> {
    if (this.messageId !== null) return;
    const body = this.renderBody(true);
    try {
      const sent = await this.deps.transport.sendMessage({
        chatId: this.deps.chatId,
        ...(this.deps.threadId ? { threadId: this.deps.threadId } : {}),
        text: body,
        parseMode: "HTML",
        ...(this.stopButton ? { inlineKeyboard: this.stopButton.rows } : {}),
      });
      this.messageId = sent.messageId;
    } catch {
      // If creation fails, edits become no-ops; finalize will retry via chunks.
    }
  }

  private renderBody(running: boolean): string {
    const { html } = markdownToTelegramHtml(this.accumulated || (running ? "…" : ""));
    let body = html.text;
    if (running && this.toolVerbosity === "all" && this.toolCalls > 0) {
      body += `\n\n<i>工具调用：${this.toolCalls}</i>`;
    }
    return body;
  }

  private buildFooter(error?: string): string {
    const parts: string[] = [];
    if (error) {
      parts.push("", `⚠️ <i>执行出错：${escapeBasic(error)}</i>`);
    }
    if (this.toolVerbosity === "summary" && this.toolCalls > 0) {
      parts.push("", `<i>工具调用 ${this.toolCalls} 次${this.toolErrors ? `，失败 ${this.toolErrors}` : ""}。</i>`);
    } else if (this.toolVerbosity === "errors-only" && this.failedTools.length > 0) {
      parts.push("", `<i>失败工具：${escapeBasic(this.failedTools.join(", "))}</i>`);
    }
    return parts.join("\n");
  }

  /** Sends the final text, chunking if needed, removing the stop button. */
  private async sendChunked(text: string, removeButtons: boolean): Promise<void> {
    const { html, plain } = markdownToTelegramHtml(this.accumulated);
    // Use plain length for the chunk decision (Telegram counts rendered chars).
    const useHtml = html.text.length <= 3_800;
    const baseText = (useHtml ? html.text : plain) + this.buildFooter(undefined).replace(/^\n\n/, "\n\n");
    const chunks = chunkPlainText(baseText, 3_800);
    for (let idx = 0; idx < chunks.length; idx++) {
      const isLast = idx === chunks.length - 1;
      try {
        if (idx === 0 && this.messageId !== null) {
          // Edit the live message into the first chunk, drop the stop button.
          await this.deps.transport.editMessageText({
            chatId: this.deps.chatId,
            messageId: this.messageId,
            text: chunks[idx],
            ...(useHtml ? { parseMode: "HTML" } : {}),
            ...(removeButtons || isLast ? {} : this.stopButton ? { inlineKeyboard: this.stopButton.rows } : {}),
          });
        } else {
          await this.deps.transport.sendMessage({
            chatId: this.deps.chatId,
            ...(this.deps.threadId ? { threadId: this.deps.threadId } : {}),
            text: chunks[idx],
            ...(useHtml ? { parseMode: "HTML" } : {}),
          });
        }
      } catch {
        // best-effort delivery
      }
    }
    // Remove the stop button from the live message if it still has one.
    if (removeButtons && this.messageId !== null) {
      try {
        await this.deps.transport.editMessageReplyMarkup(this.deps.chatId, this.messageId, []);
      } catch {
        // ignore
      }
    }
    void text;
  }

  private createStopButton(): { callbackData: string; rows: InlineKeyboardRows } | null {
    try {
      const actions = new ActionService(this.deps.store);
      const { callbackData } = actions.create({
        actionType: "abort",
        payload: {},
        userId: null,
        chatId: this.deps.chatId,
        threadId: this.deps.threadId ?? 0,
      });
      return { callbackData, rows: [[{ text: "⏹ 停止", callbackData }]] };
    } catch {
      return null;
    }
  }
}

function escapeBasic(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
