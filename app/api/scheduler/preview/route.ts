import { NextResponse } from "next/server";

import { previewNextRun } from "@/modules/scheduler";
import { errorResponse } from "@/lib/scheduler-dto";

interface PreviewBody {
  schedule?: unknown;
}

/**
 * Computes the next-run preview for a schedule input (design doc §"Preview
 * 接口"). Returns the next instant plus local + UTC display strings and a few
 * upcoming run times. Pure — does not touch the database, so it works even if
 * the scheduler hasn't started.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as PreviewBody;
    if (!body.schedule || typeof body.schedule !== "object") {
      return NextResponse.json(
        { error: "schedule is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const s = body.schedule as {
      type?: unknown;
      time?: unknown;
      localDateTime?: unknown;
      cronExpression?: unknown;
      timezone?: unknown;
    };
    if (
      (s.type !== "daily" && s.type !== "cron" && s.type !== "once") ||
      typeof s.timezone !== "string"
    ) {
      return NextResponse.json(
        {
          error: "schedule.type and schedule.timezone are required",
          code: "VALIDATION_ERROR",
        },
        { status: 400 },
      );
    }
    const input =
      s.type === "daily"
        ? {
            type: "daily" as const,
            time: typeof s.time === "string" ? s.time : "00:00",
            timezone: s.timezone,
          }
        : s.type === "cron"
          ? {
              type: "cron" as const,
              cronExpression:
                typeof s.cronExpression === "string" ? s.cronExpression : "",
              timezone: s.timezone,
            }
          : {
              type: "once" as const,
              localDateTime:
                typeof s.localDateTime === "string"
                  ? s.localDateTime
                  : new Date().toISOString().slice(0, 16),
              timezone: s.timezone,
            };
    const preview = previewNextRun(input);
    return NextResponse.json({
      nextRunAt: new Date(preview.nextRunAt).toISOString(),
      localDisplay: preview.localDisplay,
      utcDisplay: preview.utcDisplay,
      nextRuns: preview.nextRuns.map((ms) => new Date(ms).toISOString()),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
