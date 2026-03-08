import { NextResponse } from "next/server";
import { syncFromXApi, isXApiConfigured } from "@/lib/x-api-sync";

/** GET — check X API connection status */
export async function GET() {
  return NextResponse.json({ configured: isXApiConfigured() });
}

/** POST — trigger a sync via X API v2 */
export async function POST() {
  if (!isXApiConfigured()) {
    return NextResponse.json(
      {
        error:
          "X API not configured. Set X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN env vars.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await syncFromXApi();
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
