import { NextResponse } from "next/server";

import {
  getTelegramRuntime,
  coerceBotApiConfig,
  normalizeLocalFileRoot,
  TelegramError,
  type TelegramSettings,
  type ToolVerbosity,
} from "@/modules/telegram";
import { configToDto, getStoreOrError, telegramErrorResponse } from "@/lib/telegram-dto";

/**
 * GET/PUT the non-secret Telegram configuration (design doc §21.2, open-source
 * Bot API Server §14.1/§14.2). The Bot Token is never read or written here.
 */
export const dynamic = "force-dynamic";

const VALID_TOOL_VERBOSITY = new Set<ToolVerbosity>([
  "all",
  "summary",
  "errors-only",
  "none",
]);

export async function GET() {
  const access = getStoreOrError();
  if (!access.ok) return access.response;
  return NextResponse.json(configToDto(access.store.getSettings()));
}

interface ConfigBody {
  enabled?: unknown;
  privateOnly?: unknown;
  defaultLocale?: unknown;
  defaultWorkspace?: unknown;
  toolVerbosity?: unknown;
  dropPendingUpdates?: unknown;
  publicUrl?: unknown;
  botApi?: {
    mode?: unknown;
    apiRoot?: unknown;
    localMode?: unknown;
    localFileRoot?: unknown;
  };
}

export async function PUT(req: Request) {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    const store = access.store;
    const body = (await req.json().catch(() => ({}))) as ConfigBody;

    const current = store.getSettings();

    // Normalize botApi first so apiRoot/localMode validation surfaces early.
    let botApi = current.botApi;
    if (body.botApi && typeof body.botApi === "object") {
      const b = body.botApi;
      try {
        botApi = coerceBotApiConfig(
          {
            mode:
              b.mode === "official" || b.mode === "self-hosted" ? b.mode : undefined,
            apiRoot: typeof b.apiRoot === "string" ? b.apiRoot : undefined,
            localMode:
              typeof b.localMode === "boolean" ? b.localMode : undefined,
            localFileRoot:
              typeof b.localFileRoot === "string" ? b.localFileRoot : undefined,
          },
          current.botApi,
        );
        // Re-derive localFileRoot through the normalizer for safety.
        botApi = {
          ...botApi,
          localFileRoot: normalizeLocalFileRoot(botApi.localFileRoot),
        };
      } catch (error) {
        if (error instanceof TelegramError) return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus },
        );
        throw error;
      }
    }

    const toolVerbosity =
      typeof body.toolVerbosity === "string" &&
      VALID_TOOL_VERBOSITY.has(body.toolVerbosity as ToolVerbosity)
        ? (body.toolVerbosity as ToolVerbosity)
        : current.toolVerbosity;

    const defaultLocale =
      typeof body.defaultLocale === "string" && body.defaultLocale.trim()
        ? body.defaultLocale.trim()
        : current.defaultLocale;

    const defaultWorkspace =
      body.defaultWorkspace === null
        ? null
        : typeof body.defaultWorkspace === "string" && body.defaultWorkspace.trim()
          ? body.defaultWorkspace.trim()
          : current.defaultWorkspace;

    const publicUrl =
      body.publicUrl === null
        ? null
        : typeof body.publicUrl === "string" && body.publicUrl.trim()
          ? body.publicUrl.trim()
          : current.publicUrl;

    const next: TelegramSettings = {
      ...current,
      enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      privateOnly:
        typeof body.privateOnly === "boolean" ? body.privateOnly : current.privateOnly,
      defaultLocale,
      defaultWorkspace,
      toolVerbosity,
      dropPendingUpdates:
        typeof body.dropPendingUpdates === "boolean"
          ? body.dropPendingUpdates
          : current.dropPendingUpdates,
      publicUrl,
      botApi,
      updatedAt: Date.now(),
    };

    store.upsertSettings({
      enabled: next.enabled,
      privateOnly: next.privateOnly,
      defaultLocale: next.defaultLocale,
      defaultWorkspace: next.defaultWorkspace,
      toolVerbosity: next.toolVerbosity,
      dropPendingUpdates: next.dropPendingUpdates,
      publicUrl: next.publicUrl,
      botApiMode: next.botApi.mode,
      apiRoot: next.botApi.apiRoot,
      localMode: next.botApi.localMode,
      localFileRoot: next.botApi.localFileRoot,
    });

    // Restart polling so the new apiRoot/enabled state takes effect
    // (open-source Bot API Server §14.2). Not awaited in the request path's
    // critical section — restart() is idempotent and self-contained.
    const runtime = getTelegramRuntime();
    void runtime?.restart();

    return NextResponse.json(configToDto(store.getSettings()));
  } catch (error) {
    return telegramErrorResponse(error);
  }
}
