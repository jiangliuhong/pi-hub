import { NextResponse } from "next/server";

import {
  getTelegramRuntime,
  resolveTokenSource,
  isTokenManagedByEnv,
} from "@/modules/telegram";
import { statusToDto } from "@/lib/telegram-dto";

/**
 * Telegram runtime + configuration status (design doc §21.1).
 *
 * Never returns the Bot Token or any secret — only operational state and the
 * token *source* (environment/local/unset) so the UI can show whether it is
 * Web-manageable.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = getTelegramRuntime();
  const store = runtime?.getStore();
  const tokenSource = resolveTokenSource();
  const tokenManagedByEnv = isTokenManagedByEnv();

  if (!runtime || !store) {
    // Runtime not started yet (server boot race) — return a disabled snapshot.
    return NextResponse.json(
      statusToDto({
        tokenSource,
        tokenManagedByEnv,
        runtime: {
          runtime: {
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
          },
          settings: null,
        },
        userCount: 0,
        conversationCount: 0,
      }),
    );
  }

  return NextResponse.json(
    statusToDto({
      tokenSource,
      tokenManagedByEnv,
      runtime: runtime.getStatus(),
      userCount: store.userCount(),
      conversationCount: store.conversationCount(),
    }),
  );
}
