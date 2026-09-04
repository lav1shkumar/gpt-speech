import { NextResponse } from "next/server";

import { readRealtimeServerConfig } from "@/lib/server/realtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  let ready = true;

  try {
    readRealtimeServerConfig();
  } catch {
    ready = false;
  }

  return NextResponse.json(
    {
      status: ready ? "ok" : "not_ready",
      checks: {
        azureOpenAI: ready ? "configured" : "not_configured",
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

