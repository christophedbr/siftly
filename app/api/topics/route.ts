import { NextRequest, NextResponse, after } from "next/server";
import {
  generateResearchTopics,
  getTopicState,
  setTopicState,
  requestTopicAbort,
} from "@/lib/topic-clusterer";
import { preflightProviderCheck } from "@/lib/ai-provider";

export const maxDuration = 300;

/**
 * GET /api/topics — Check generation status or list existing topics.
 */
export async function GET(): Promise<NextResponse> {
  const state = getTopicState();
  return NextResponse.json(state);
}

/**
 * POST /api/topics — Trigger research topic generation.
 *
 * Body (all optional):
 * - distanceThreshold: number (default 0.30, lower = more specific topics)
 * - minClusterSize: number (default 3)
 * - maxTopics: number (default 50)
 * - outputPath: string (directory to write markdown files)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const state = getTopicState();
  if (state.status === "running" || state.status === "stopping") {
    return NextResponse.json(
      { error: "Topic generation is already running" },
      { status: 409 },
    );
  }

  // Pre-flight: need OpenAI for embeddings
  const preflight = await preflightProviderCheck();
  // Embeddings always use OpenAI regardless of provider setting,
  // but chatComplete uses whatever is configured — so just warn
  if (preflight) {
    console.warn("[topics] Provider preflight warning:", preflight);
  }

  let body: {
    distanceThreshold?: number;
    minClusterSize?: number;
    maxTopics?: number;
    outputPath?: string;
  } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  setTopicState({
    status: "running",
    phase: "starting",
    done: 0,
    total: 0,
    lastError: null,
    error: null,
  });

  after(async () => {
    try {
      const topics = await generateResearchTopics(body);
      console.log(`[topics] Generated ${topics.length} research topics`);
    } catch (err) {
      console.error("[topics] Generation failed:", err);
      setTopicState({
        status: "idle",
        phase: null,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  });

  return NextResponse.json({ status: "started" });
}

/**
 * DELETE /api/topics — Cancel running generation.
 */
export async function DELETE(): Promise<NextResponse> {
  const state = getTopicState();
  if (state.status !== "running") {
    return NextResponse.json(
      { error: "No generation running" },
      { status: 409 },
    );
  }
  requestTopicAbort();
  return NextResponse.json({ stopped: true });
}
