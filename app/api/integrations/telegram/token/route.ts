import { NextResponse } from "next/server";

import {
  saveLocalToken,
  clearLocalToken,
  isTokenManagedByEnv,
  getTelegramRuntime,
  startTelegramRuntime,
  TelegramErrorCode,
  TelegramError,
} from "@/modules/telegram";

/**
 * Bot Token write/delete (design doc §21.3). The token is write-only from the
 * API — there is no GET. Env-managed tokens reject mutations with 409.
 *
 * Saving/clearing triggers a runtime restart so polling reflects the change.
 */
export const dynamic = "force-dynamic";

interface PutBody {
  token?: unknown;
}

export async function PUT(req: Request) {
  try {
    if (isTokenManagedByEnv()) {
      return NextResponse.json(
        {
          error: "Bot token is managed by the PI_HUB_TELEGRAM_BOT_TOKEN environment variable",
          code: TelegramErrorCode.TELEGRAM_TOKEN_MANAGED_BY_ENV,
        },
        { status: 409 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as PutBody;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return NextResponse.json(
        { error: "token is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    saveLocalToken(token);
    // The route can run before instrumentation has finished bootstrapping the
    // singleton, so make sure a usable runtime exists before updating settings.
    const runtime = await startTelegramRuntime();
    // Auto-enable the integration when a token is saved. The settings row
    // defaults to enabled=false and the runtime skips polling entirely while
    // it stays false — this was the #1 silent "bot doesn't respond" cause:
    // token + test-connection both succeed, but no message is ever received.
    const store = runtime.getStore();
    if (!store) throw new Error("Telegram runtime is not ready");
    store.upsertSettings({ enabled: true });
    void runtime.restart();
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TelegramError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    if (isTokenManagedByEnv()) {
      return NextResponse.json(
        {
          error: "Bot token is managed by the PI_HUB_TELEGRAM_BOT_TOKEN environment variable",
          code: TelegramErrorCode.TELEGRAM_TOKEN_MANAGED_BY_ENV,
        },
        { status: 409 },
      );
    }
    clearLocalToken();
    const runtime = getTelegramRuntime();
    void runtime?.restart();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
