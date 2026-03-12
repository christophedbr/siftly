import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { syncBookmarks, isSyncing } from "@/lib/x-sync";
import { triggerCategorizePipeline } from "@/lib/pipeline-trigger";

/** POST — trigger a manual sync using stored credentials */
export async function POST() {
  if (isSyncing()) {
    return NextResponse.json(
      { error: "A sync is already in progress" },
      { status: 409 },
    );
  }

  try {
    const [authSetting, ct0Setting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "x_auth_token" } }),
      prisma.setting.findUnique({ where: { key: "x_ct0" } }),
    ]);

    if (!authSetting?.value || !ct0Setting?.value) {
      return NextResponse.json(
        {
          error:
            "X credentials not configured. Save your auth_token and ct0 first.",
        },
        { status: 400 },
      );
    }

    const result = await syncBookmarks(authSetting.value, ct0Setting.value);

    // Auto-trigger categorization → enrichment → research topics
    if (result.imported > 0) {
      triggerCategorizePipeline();
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    const status = msg.includes("already in progress") ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
