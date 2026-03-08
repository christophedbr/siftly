import { NextResponse } from "next/server";
import { syncFromXApi, isXApiConfigured } from "@/lib/x-api-sync";

/** GET — check X API connection status + debug */
export async function GET() {
  const cid = process.env.X_CLIENT_ID ?? "";
  const cs = process.env.X_CLIENT_SECRET ?? "";
  const rt = process.env.X_REFRESH_TOKEN ?? "";
  return NextResponse.json({
    configured: isXApiConfigured(),
    method: "oauth2",
    debug: {
      hasClientId: cid.length > 0,
      clientIdLen: cid.length,
      clientIdPreview: cid.slice(0, 6),
      hasSecret: cs.length > 0,
      secretLen: cs.length,
      hasRefresh: rt.length > 0,
      refreshLen: rt.length,
      refreshPreview: rt.slice(0, 6),
    },
  });
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
