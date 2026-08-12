import { NextResponse } from "next/server";
import { buildClientInfo } from "@/lib/client-info";

// Static identity response — no auth, no reads, no side effects. The Tauri
// client probes this during startup to confirm "this port is Pi Hub" (see the
// cross-repo contract in AGENTS.md §5.5). Must be reachable without any
// credentials and must respond quickly (< ~100ms) to avoid probe timeouts.
export const dynamic = "force-dynamic";

// GET /api/client-info — public identity probe used by pi-hub-desktop.
export async function GET() {
  return NextResponse.json(buildClientInfo(), {
    headers: { "Cache-Control": "no-store" },
  });
}
