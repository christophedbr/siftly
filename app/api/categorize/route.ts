import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import prisma from "@/lib/db";
import { resolveAnthropicClient } from "@/lib/claude-cli-auth";
import {
  seedDefaultCategories,
  categorizeBatch,
  mapBookmarkForCategorization,
  writeCategoryResults,
  BOOKMARK_SELECT,
} from "@/lib/categorizer";
import {
  getAnthropicModel,
  analyzeItem,
  runWithConcurrency,
  enrichBatchSemanticTags,
  BookmarkForEnrichment,
} from "@/lib/vision-analyzer";
import { backfillEntities } from "@/lib/rawjson-extractor";
import { rebuildFts } from "@/lib/fts";
import {
  getAIProvider,
  preflightProviderCheck,
  getCachedOpenAIClient,
} from "@/lib/ai-provider";
import { fetchLinkSummaries } from "@/lib/link-content";
import { generateResearchTopics } from "@/lib/topic-clusterer";
import {
  extractConversationId,
  fetchThreadContext,
} from "@/lib/thread-extractor";

export const maxDuration = 300;

type Stage = "vision" | "entities" | "enrichment" | "categorize" | "parallel";

interface CategorizationState {
  status: "idle" | "running" | "stopping";
  stage: Stage | null;
  done: number;
  total: number;
  stageCounts: {
    visionTagged: number;
    entitiesExtracted: number;
    enriched: number;
    categorized: number;
  };
  lastError: string | null;
  error: string | null;
}

// In-memory state for progress tracking across requests
const globalState = globalThis as unknown as {
  categorizationState: CategorizationState;
  categorizationAbort: boolean;
};

if (!globalState.categorizationState) {
  globalState.categorizationState = {
    status: "idle",
    stage: null,
    done: 0,
    total: 0,
    stageCounts: {
      visionTagged: 0,
      entitiesExtracted: 0,
      enriched: 0,
      categorized: 0,
    },
    lastError: null,
    error: null,
  };
}
if (globalState.categorizationAbort === undefined) {
  globalState.categorizationAbort = false;
}

function shouldAbort(): boolean {
  return globalState.categorizationAbort;
}

function getState(): CategorizationState {
  return { ...globalState.categorizationState };
}

function setState(update: Partial<CategorizationState>): void {
  globalState.categorizationState = {
    ...globalState.categorizationState,
    ...update,
  };
}

export async function GET(): Promise<NextResponse> {
  const state = getState();
  return NextResponse.json({
    status: state.status,
    stage: state.stage,
    done: state.done,
    total: state.total,
    stageCounts: state.stageCounts,
    lastError: state.lastError,
    error: state.error,
  });
}

export async function DELETE(): Promise<NextResponse> {
  const state = getState();
  if (state.status !== "running") {
    return NextResponse.json({ error: "No pipeline running" }, { status: 409 });
  }
  globalState.categorizationAbort = true;
  setState({ status: "stopping" });
  return NextResponse.json({ stopped: true });
}

const PIPELINE_WORKERS = 20;
const CAT_BATCH_SIZE = 25;
const ENRICH_BATCH_SIZE = 5;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (getState().status === "running" || getState().status === "stopping") {
    return NextResponse.json(
      { error: "Categorization is already running" },
      { status: 409 },
    );
  }

  let body: { bookmarkIds?: string[]; apiKey?: string; force?: boolean } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { bookmarkIds = [], apiKey, force = false } = body;

  if (apiKey && typeof apiKey === "string" && apiKey.trim() !== "") {
    await prisma.setting.upsert({
      where: { key: "anthropicApiKey" },
      update: { value: apiKey.trim() },
      create: { key: "anthropicApiKey", value: apiKey.trim() },
    });
  }

  globalState.categorizationAbort = false;

  // Pre-flight: verify the configured provider has a working API key
  const provider = await getAIProvider();
  const preflightError = await preflightProviderCheck();
  if (preflightError) {
    // Allow Anthropic CLI fallback — only hard-fail for OpenAI missing key
    if (provider === "openai") {
      setState({
        status: "idle",
        stage: null,
        done: 0,
        total: 0,
        stageCounts: {
          visionTagged: 0,
          entitiesExtracted: 0,
          enriched: 0,
          categorized: 0,
        },
        lastError: null,
        error: preflightError,
      });
      return NextResponse.json({ error: preflightError }, { status: 400 });
    }
  }

  let total = 0;
  try {
    if (bookmarkIds.length > 0) {
      total = bookmarkIds.length;
    } else if (force) {
      total = await prisma.bookmark.count();
    } else {
      total = await prisma.bookmark.count({ where: { enrichedAt: null } });
    }
  } catch {
    total = 0;
  }

  setState({
    status: "running",
    stage: "entities",
    done: 0,
    total,
    stageCounts: {
      visionTagged: 0,
      entitiesExtracted: 0,
      enriched: 0,
      categorized: 0,
    },
    lastError: null,
    error: null,
  });

  const dbApiKey =
    (
      await prisma.setting.findUnique({ where: { key: "anthropicApiKey" } })
    )?.value?.trim() || "";

  const capturedTotal = total;
  const capturedBookmarkIds = bookmarkIds;
  const capturedForce = force;

  after(async () => {
    const counts = {
      visionTagged: 0,
      entitiesExtracted: 0,
      enriched: 0,
      categorized: 0,
    };

    try {
      // Anthropic client is optional — only needed for Anthropic vision
      let client: Anthropic | null = null;
      try {
        client = resolveAnthropicClient({ dbKey: dbApiKey });
      } catch {
        if (provider !== "openai") {
          setState({
            lastError:
              "No Anthropic API key configured. Go to Settings to add one, or log in with Claude CLI.",
          });
          console.error("No API key or CLI auth — skipping pipeline");
          return;
        }
        console.log(
          "[pipeline] Using OpenAI provider — vision via GPT-4o-mini",
        );
      }

      // Pre-build OpenAI client once for the whole pipeline (cached key)
      let openaiClient: import("openai").default | null = null;
      if (provider === "openai") {
        try {
          openaiClient = await getCachedOpenAIClient();
        } catch (err) {
          setState({
            error: `OpenAI client failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }

      await seedDefaultCategories();

      if (capturedForce) {
        await prisma.mediaItem.updateMany({
          where: { imageTags: "{}" },
          data: { imageTags: null },
        });
        await prisma.bookmark.updateMany({
          where: { semanticTags: "[]" },
          data: { semanticTags: null },
        });
      }

      // Stage 1: Entity extraction (free, fast — no API calls)
      if (!shouldAbort()) {
        setState({ stage: "entities" });
        counts.entitiesExtracted = await backfillEntities((n) => {
          counts.entitiesExtracted = n;
          setState({ stageCounts: { ...counts } });
        }, shouldAbort).catch((err) => {
          console.error("Entity extraction error:", err);
          return counts.entitiesExtracted;
        });
        setState({ stageCounts: { ...counts } });
      }

      // Stage 2: Parallel pipeline — vision + link fetch → enrich queue → categorize queue
      if (!shouldAbort()) {
        let bookmarkIdsToProcess: string[];
        if (capturedBookmarkIds.length > 0) {
          bookmarkIdsToProcess = capturedBookmarkIds;
        } else if (capturedForce) {
          const all = await prisma.bookmark.findMany({
            select: { id: true },
            orderBy: { id: "asc" },
          });
          bookmarkIdsToProcess = all.map((b) => b.id);
        } else {
          const unprocessed = await prisma.bookmark.findMany({
            where: { enrichedAt: null },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          bookmarkIdsToProcess = unprocessed.map((b) => b.id);
        }

        const runTotal = bookmarkIdsToProcess.length;
        setState({
          stage: "parallel",
          done: 0,
          total: runTotal,
          stageCounts: { ...counts },
        });

        // Load category metadata once
        const dbCategories = await prisma.category.findMany({
          select: { slug: true, name: true, description: true },
        });
        const allSlugs = dbCategories.map((c) => c.slug);
        const categoryDescriptions = Object.fromEntries(
          dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
        );
        const model = await getAnthropicModel();
        const openaiVisionModel = "gpt-4o-mini";

        // ── Enrichment queue (batch of 5) ──────────────────────────────────
        const enrichPending: BookmarkForEnrichment[] = [];
        let enrichFlushing = false;

        async function drainEnrichQueue(final = false): Promise<void> {
          if (final) {
            while (enrichFlushing) {
              await new Promise<void>((r) => setTimeout(r, 50));
            }
          } else if (
            enrichFlushing ||
            enrichPending.length < ENRICH_BATCH_SIZE
          ) {
            return;
          }

          enrichFlushing = true;
          try {
            while (enrichPending.length > 0) {
              if (!final && enrichPending.length < ENRICH_BATCH_SIZE) break;
              const batch = enrichPending.splice(0, ENRICH_BATCH_SIZE);
              if (batch.length === 0) break;
              try {
                const results = await enrichBatchSemanticTags(batch, client);
                const resultMap = new Map(results.map((r) => [r.id, r]));

                for (const b of batch) {
                  const result = resultMap.get(b.id);
                  if (result?.tags.length) {
                    await prisma.bookmark.update({
                      where: { id: b.id },
                      data: {
                        semanticTags: JSON.stringify(result.tags),
                        enrichmentMeta: JSON.stringify({
                          sentiment: result.sentiment,
                          people: result.people,
                          companies: result.companies,
                        }),
                      },
                    });
                    counts.enriched++;
                    setState({ stageCounts: { ...counts } });
                  }
                }
              } catch (err) {
                console.warn(
                  "[parallel] enrich batch error:",
                  err instanceof Error ? err.message : err,
                );
                setState({
                  lastError: `Enrichment: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`,
                });
              }

              // Queue enriched IDs for categorization
              for (const b of batch) catPending.push(b.id);
              await drainCategorizeQueue();
            }
          } finally {
            enrichFlushing = false;
          }
        }

        // ── Categorization queue (batch of 25) ────────────────────────────
        const catPending: string[] = [];
        let catFlushing = false;

        async function drainCategorizeQueue(final = false): Promise<void> {
          if (final) {
            while (catFlushing) {
              await new Promise<void>((resolve) => setTimeout(resolve, 50));
            }
          } else if (catFlushing || catPending.length < CAT_BATCH_SIZE) {
            return;
          }

          catFlushing = true;
          try {
            while (catPending.length > 0) {
              if (!final && catPending.length < CAT_BATCH_SIZE) break;
              const ids = catPending.splice(0, CAT_BATCH_SIZE);
              if (ids.length === 0) break;
              const rows = await prisma.bookmark.findMany({
                where: { id: { in: ids } },
                select: BOOKMARK_SELECT,
              });
              const batch = rows.map(mapBookmarkForCategorization);
              try {
                const results = await categorizeBatch(
                  batch,
                  client,
                  categoryDescriptions,
                  allSlugs,
                );
                await writeCategoryResults(results);
                counts.categorized += ids.length;
                setState({ stageCounts: { ...counts } });
              } catch (catErr) {
                console.error("[parallel] categorize batch error:", catErr);
              }
            }
          } finally {
            catFlushing = false;
          }
        }

        let processedCount = 0;

        async function processBookmark(bookmarkId: string): Promise<void> {
          if (shouldAbort()) return;

          const bm = await prisma.bookmark.findUnique({
            where: { id: bookmarkId },
            select: {
              id: true,
              text: true,
              semanticTags: true,
              entities: true,
              rawJson: true,
              authorHandle: true,
              mediaItems: {
                where: { type: { in: ["photo", "gif", "video"] } },
                select: {
                  id: true,
                  url: true,
                  thumbnailUrl: true,
                  type: true,
                  imageTags: true,
                },
              },
            },
          });
          if (!bm) return;

          // Vision: analyze untagged media items (works with both providers)
          let anyVisionRan = false;
          for (const media of bm.mediaItems) {
            if (shouldAbort()) return;
            if (media.imageTags !== null) continue;
            try {
              await analyzeItem(
                {
                  id: media.id,
                  url: media.url,
                  thumbnailUrl: media.thumbnailUrl,
                  type: media.type,
                },
                client,
                provider === "openai" ? openaiVisionModel : model,
                {
                  provider,
                  openaiClient: openaiClient ?? undefined,
                },
              );
              anyVisionRan = true;
              counts.visionTagged++;
              setState({ stageCounts: { ...counts } });
            } catch (err) {
              console.warn(
                "[parallel] vision failed for",
                media.id,
                err instanceof Error ? err.message : err,
              );
            }
          }

          // Link content: fetch OG metadata from URLs in the bookmark
          let linkSummaries: BookmarkForEnrichment["linkSummaries"];
          let entities: BookmarkForEnrichment["entities"];
          let threadReplyTexts: string[] | undefined;
          if (bm.entities) {
            try {
              entities = JSON.parse(
                bm.entities,
              ) as BookmarkForEnrichment["entities"];
            } catch {
              /* ignore */
            }
          }

          // Thread extraction: fetch URLs + text from author's follow-up tweets
          let threadUrls: string[] = [];
          if (entities?.tweetType === "thread" && bm.rawJson) {
            const conversationId = extractConversationId(bm.rawJson);
            if (conversationId) {
              try {
                const threadCtx = await fetchThreadContext(
                  conversationId,
                  bm.authorHandle,
                );
                threadUrls = threadCtx.urls;
                if (threadCtx.replyTexts.length > 0) {
                  threadReplyTexts = threadCtx.replyTexts;
                }
              } catch {
                /* non-fatal */
              }
            }
          }

          // Merge entity URLs + thread URLs, then fetch OG metadata
          const allUrls = [...(entities?.urls ?? []), ...threadUrls];
          if (allUrls.length > 0) {
            try {
              const summaries = await fetchLinkSummaries(allUrls);
              if (summaries.length > 0) linkSummaries = summaries;
            } catch {
              /* non-fatal */
            }
          }

          // Queue for enrichment (batched) if not already enriched
          if (!bm.semanticTags) {
            const imageTags = anyVisionRan
              ? (
                  await prisma.mediaItem.findMany({
                    where: {
                      bookmarkId: bm.id,
                      type: { in: ["photo", "gif", "video"] },
                    },
                    select: { imageTags: true },
                  })
                )
                  .map((m) => m.imageTags)
                  .filter(
                    (t): t is string => t !== null && t !== "" && t !== "{}",
                  )
              : bm.mediaItems
                  .map((m) => m.imageTags)
                  .filter(
                    (t): t is string => t !== null && t !== "" && t !== "{}",
                  );

            if (
              imageTags.length === 0 &&
              bm.text.length < 20 &&
              !linkSummaries?.length &&
              !threadReplyTexts?.length
            ) {
              // Trivial bookmark — skip enrichment, queue directly for categorization
              await prisma.bookmark.update({
                where: { id: bm.id },
                data: { semanticTags: "[]" },
              });
              catPending.push(bm.id);
            } else {
              enrichPending.push({
                id: bm.id,
                text: bm.text,
                imageTags,
                entities,
                linkSummaries,
                threadReplyTexts,
              });
              await drainEnrichQueue();
            }
          } else {
            // Already enriched — queue directly for categorization
            catPending.push(bm.id);
            await drainCategorizeQueue();
          }

          processedCount++;
          setState({ done: processedCount, stageCounts: { ...counts } });
        }

        // Run all bookmark workers with bounded concurrency
        const tasks = bookmarkIdsToProcess.map(
          (id) => () => processBookmark(id),
        );
        try {
          await runWithConcurrency(tasks, PIPELINE_WORKERS);
        } finally {
          // Drain remaining items in enrichment → categorization order
          await drainEnrichQueue(true);
          await drainCategorizeQueue(true);
        }
      }
    } catch (err) {
      console.error("Pipeline error:", err);
      setState({
        lastError:
          err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }

    if (!shouldAbort()) {
      await rebuildFts().catch((err) =>
        console.error("FTS rebuild error:", err),
      );

      // Auto-regenerate research topics after enrichment
      console.log("[pipeline] Regenerating research topics...");
      await generateResearchTopics({ distanceThreshold: 0.45 }).catch((err) =>
        console.error("Topic generation error:", err),
      );
    }

    const wasStopped = globalState.categorizationAbort;
    globalState.categorizationAbort = false;
    setState({
      status: "idle",
      stage: null,
      done: wasStopped ? getState().done : capturedTotal,
      total: capturedTotal,
      error: wasStopped ? "Stopped by user" : null,
    });
  });

  return NextResponse.json({ status: "started", total });
}
