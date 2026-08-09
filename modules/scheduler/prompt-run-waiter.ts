/**
 * PromptRunWaiter — waits for a fire-and-forget Pi prompt to finish.
 *
 * `session.send({ type: "prompt" })` returns immediately (§30.1). The wrapper
 * emits `prompt_done` once the turn fully resolves, and `prompt_error` on
 * failure. We must NOT end on the first `agent_end` (§16.4) — retries,
 * compaction, and extension-queued messages can continue the same prompt.
 *
 * Also auto-responds to `extension_ui_request` (§17): there is no human at the
 * keyboard during a scheduled run, so confirm → false, everything else →
 * cancelled. This keeps unattended runs from hanging on interactive prompts.
 *
 * The waiter operates against a minimal session shape so it can be unit-tested
 * with a fake. The real caller passes the `AgentSessionWrapper` from
 * `lib/rpc-manager.ts`, which satisfies this interface.
 */

import { SchedulerError, SchedulerErrorCode } from "./errors";

/** Minimal session surface the waiter depends on. */
export interface WaiterSession {
  /** Subscribe to wrapper events; returns an unsubscribe fn. */
  onEvent(listener: (event: { type: string; [k: string]: unknown }) => void): () => void;
  /** Send a command; mirrors AgentSessionWrapper.send. */
  send(command: Record<string, unknown>): Promise<unknown>;
}

export interface WaitResult {
  /** True when the prompt completed without a prompt_error. */
  ok: boolean;
  /** Error message captured from prompt_error, if any. */
  error: string | null;
  /** Warnings collected during the run (e.g. auto-cancelled UI requests). */
  warnings: string[];
}

const INTERACTIVE_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
  "custom",
]);

/**
 * Sends a prompt and resolves only after the wrapper's `prompt_done` event.
 * Subscribes BEFORE sending (§30.2) so a fast-completing prompt cannot drop
 * its terminal event. Resolves exactly once regardless of races.
 *
 * `runMeta` is forwarded onto the `prompt` command so the synthesized terminal
 * events are tagged with the scheduler business source — a Web page subscribed
 * to the same session then cannot mis-route a scheduled run into a Web
 * completion notification. When omitted, the run is treated as `api` source.
 */
export function runPromptAndWait(
  session: WaiterSession,
  message: string,
  timeoutMs: number,
  options: {
    signal?: AbortSignal;
    runMeta?: { runId: string; source: "scheduler" | "api" };
  } = {},
): Promise<WaitResult> {
  return new Promise<WaitResult>((resolve) => {
    let promptError: string | null = null;
    const warnings: string[] = [];
    let settled = false;

    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      signalListenerCleanup();
      resolve(result);
    };

    const off = session.onEvent((event) => {
      // Auto-respond to interactive extension requests (§17).
      if (event.type === "extension_ui_request") {
        const id = event.id as string | undefined;
        const method = event.method as string | undefined;
        if (id && method) {
          if (method === "confirm") {
            void session
              .send({ type: "extension_ui_response", id, confirmed: false })
              .catch(() => undefined);
            warnings.push(`Auto-cancelled extension confirm request (${id})`);
          } else if (INTERACTIVE_METHODS.has(method)) {
            void session
              .send({ type: "extension_ui_response", id, cancelled: true })
              .catch(() => undefined);
            warnings.push(`Auto-cancelled extension ${method} request (${id})`);
          }
        }
        return;
      }

      if (event.type === "prompt_error") {
        promptError =
          (event.errorMessage as string | undefined) ?? "Unknown prompt error";
        return;
      }

      if (event.type === "prompt_done") {
        finish({ ok: !promptError, error: promptError, warnings });
      }
    });

    const timer = setTimeout(() => {
      void session.send({ type: "abort" }).catch(() => undefined);
      finish({
        ok: false,
        error: new SchedulerError(
          SchedulerErrorCode.TASK_TIMEOUT,
          `Prompt timed out after ${timeoutMs}ms`,
        ).message,
        warnings,
      });
    }, timeoutMs);

    // External cancellation (runtime stop / run cancel).
    const onAbort = () => {
      void session.send({ type: "abort" }).catch(() => undefined);
      finish({
        ok: false,
        error: "Cancelled",
        warnings,
      });
    };
    let signalListenerCleanup = () => {};
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      signalListenerCleanup = () =>
        options.signal?.removeEventListener("abort", onAbort);
    }

    // Fire the prompt AFTER subscribing. send() itself returns immediately.
    session
      .send({
        type: "prompt",
        message,
        ...(options.runMeta ? { runMeta: options.runMeta } : {}),
      })
      .catch((error) => {
        finish({
          ok: false,
          error:
            error instanceof Error ? error.message : `send() failed: ${error}`,
          warnings,
        });
      });
  });
}
