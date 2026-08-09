import { NextResponse } from "next/server";

import {
  getStoreOrError,
  telegramErrorResponse,
  userToDto,
} from "@/lib/telegram-dto";

/**
 * List paired Telegram users (design doc §21.6). No secrets involved; user
 * records never contain the bot token.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = getStoreOrError();
    if (!access.ok) return access.response;
    return NextResponse.json({ items: access.store.listUsers().map(userToDto) });
  } catch (error) {
    return telegramErrorResponse(error);
  }
}

/**
 * Bulk-create users is intentionally NOT supported via POST — users are
 * created only through the Telegram `/pair` flow so identity is verified
 * against the live Telegram user. This route is GET + PATCH/DELETE on [id].
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Users are added through the Telegram /pair flow after a pairing code is issued.",
      code: "VALIDATION_ERROR",
    },
    { status: 400 },
  );
}
