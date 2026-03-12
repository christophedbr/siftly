/**
 * Research Topics: embed bookmarks, cluster by similarity, generate markdown.
 *
 * Pipeline: embed → cluster → synthesize → write markdown files
 * Output: Obsidian-compatible .md files in the configured research directory.
 */

import prisma from "@/lib/db";
import { getCachedOpenAIClient, chatComplete } from "@/lib/ai-provider";
import * as fs from "fs/promises";
import * as path from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnrichedBookmark {
  id: string;
  text: string;
  authorHandle: string;
  authorName: string;
  tweetId: string;
  semanticTags: string[];
  sentiment?: string;
  people?: string[];
  companies?: string[];
  categories: string[];
  entities?: {
    hashtags?: string[];
    urls?: string[];
    mentions?: string[];
    tools?: string[];
  };
}

export interface GeneratedTopic {
  slug: string;
  name: string;
  summary: string;
  themes: string[];
  bookmarkIds: string[];
  relatedSlugs: string[];
}

export interface TopicGenerationOptions {
  distanceThreshold?: number; // cosine distance cutoff (default 0.30)
  minClusterSize?: number; // minimum bookmarks per topic (default 3)
  maxTopics?: number; // cap on number of topics (default 50)
  outputPath?: string; // directory to write markdown files
}

// ── Embedding ────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 100; // OpenAI supports up to 2048 inputs per call

/**
 * Build the text input for embedding a bookmark.
 * Combines semantic tags (richest signal) with tweet text and metadata.
 */
function buildEmbeddingInput(bookmark: EnrichedBookmark): string {
  const parts: string[] = [];
  if (bookmark.semanticTags.length > 0) {
    parts.push(bookmark.semanticTags.join(", "));
  }
  parts.push(bookmark.text.slice(0, 400));
  if (bookmark.entities?.tools?.length) {
    parts.push(`Tools: ${bookmark.entities.tools.join(", ")}`);
  }
  if (bookmark.companies?.length) {
    parts.push(`Companies: ${bookmark.companies.join(", ")}`);
  }
  return parts.join(" | ");
}

/**
 * Compute embeddings for bookmarks that don't have one yet.
 * Stores results in BookmarkEmbedding table. Returns count of new embeddings.
 */
export async function computeMissingEmbeddings(
  bookmarkIds: string[],
  onProgress?: (done: number) => void,
): Promise<number> {
  // Find which bookmarks already have embeddings
  const existing = await prisma.bookmarkEmbedding.findMany({
    where: { bookmarkId: { in: bookmarkIds } },
    select: { bookmarkId: true },
  });
  const existingSet = new Set(existing.map((e) => e.bookmarkId));
  const missing = bookmarkIds.filter((id) => !existingSet.has(id));

  if (missing.length === 0) return 0;

  const client = await getCachedOpenAIClient();
  let embedded = 0;

  // Fetch bookmark data for missing embeddings
  for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
    const batchIds = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
    const bookmarks = await prisma.bookmark.findMany({
      where: { id: { in: batchIds } },
      select: {
        id: true,
        text: true,
        authorHandle: true,
        semanticTags: true,
        enrichmentMeta: true,
        entities: true,
        categories: {
          select: { category: { select: { name: true } } },
        },
      },
    });

    const inputs = bookmarks.map((bm) => {
      let tags: string[] = [];
      try {
        if (bm.semanticTags) tags = JSON.parse(bm.semanticTags);
      } catch {
        /* ignore */
      }

      let meta: { sentiment?: string; companies?: string[] } = {};
      try {
        if (bm.enrichmentMeta) meta = JSON.parse(bm.enrichmentMeta);
      } catch {
        /* ignore */
      }

      let entities: EnrichedBookmark["entities"];
      try {
        if (bm.entities) entities = JSON.parse(bm.entities);
      } catch {
        /* ignore */
      }

      return buildEmbeddingInput({
        id: bm.id,
        text: bm.text,
        authorHandle: bm.authorHandle,
        authorName: "",
        tweetId: "",
        semanticTags: tags,
        companies: meta.companies,
        categories: bm.categories.map((c) => c.category.name),
        entities,
      });
    });

    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs,
    });

    // Store embeddings
    const creates = res.data.map((item, idx) => ({
      bookmarkId: bookmarks[idx].id,
      embedding: JSON.stringify(item.embedding),
    }));

    await prisma.bookmarkEmbedding.createMany({
      data: creates,
      skipDuplicates: true,
    });

    embedded += creates.length;
    onProgress?.(embedded);
  }

  return embedded;
}

// ── Cosine similarity & clustering ───────────────────────────────────────────

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Agglomerative clustering with average linkage.
 * Returns an array of cluster indices (one per input vector).
 */
export function agglomerativeClustering(
  vectors: number[][],
  threshold: number,
): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Each item starts as its own cluster
  const clusters: Set<number>[] = vectors.map((_, i) => new Set([i]));
  const active = new Set(Array.from({ length: n }, (_, i) => i));

  // Pre-compute pairwise distance matrix (upper triangle)
  const dist: number[][] = Array.from({ length: n }, () =>
    new Array(n).fill(0),
  );
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(vectors[i], vectors[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Iteratively merge closest clusters until threshold exceeded
  while (active.size > 1) {
    let bestDist = Infinity;
    let bestI = -1;
    let bestJ = -1;

    const activeArr = [...active];
    for (let ai = 0; ai < activeArr.length; ai++) {
      for (let aj = ai + 1; aj < activeArr.length; aj++) {
        const ci = activeArr[ai];
        const cj = activeArr[aj];

        // Average linkage: mean distance between all pairs
        let totalDist = 0;
        let count = 0;
        for (const pi of clusters[ci]) {
          for (const pj of clusters[cj]) {
            totalDist += dist[pi][pj];
            count++;
          }
        }
        const avgDist = totalDist / count;

        if (avgDist < bestDist) {
          bestDist = avgDist;
          bestI = ci;
          bestJ = cj;
        }
      }
    }

    if (bestDist > threshold || bestI === -1) break;

    // Merge bestJ into bestI
    for (const idx of clusters[bestJ]) {
      clusters[bestI].add(idx);
    }
    active.delete(bestJ);
  }

  // Build result: map each point to its cluster label
  const labels = new Array(n).fill(-1);
  let clusterIdx = 0;
  for (const ci of active) {
    for (const idx of clusters[ci]) {
      labels[idx] = clusterIdx;
    }
    clusterIdx++;
  }

  return labels;
}

// ── Topic synthesis ──────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Use LLM to generate a topic name, summary, and themes from a cluster of bookmarks.
 */
async function synthesizeCluster(
  bookmarks: EnrichedBookmark[],
): Promise<{ name: string; summary: string; themes: string[] }> {
  const items = bookmarks.slice(0, 15).map((b) => ({
    text: b.text.slice(0, 300),
    tags: b.semanticTags.slice(0, 10),
    author: `@${b.authorHandle}`,
    categories: b.categories.slice(0, 3),
  }));

  const prompt = `Analyze this cluster of ${bookmarks.length} related bookmarks and generate a research topic.

Return ONLY valid JSON:
{
  "name": "A concise, specific topic name (3-7 words)",
  "summary": "2-3 sentences synthesizing the key insight across these bookmarks. What pattern or knowledge do they collectively represent?",
  "themes": ["3-5 specific sub-themes or key concepts that recur across the bookmarks"]
}

Rules:
- The topic name should be specific and actionable, not generic ("AI Agent Orchestration Patterns" not "AI Stuff")
- The summary should synthesize, not just list. What would someone learn from reading all of these?
- Themes should be concrete concepts, not vague categories

BOOKMARKS:
${JSON.stringify(items, null, 1)}`;

  const text = await chatComplete(prompt, { maxTokens: 512 });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { name: "Untitled Topic", summary: "", themes: [] };

  try {
    const parsed = JSON.parse(match[0]) as {
      name?: string;
      summary?: string;
      themes?: string[];
    };
    return {
      name: parsed.name || "Untitled Topic",
      summary: parsed.summary || "",
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
    };
  } catch {
    return { name: "Untitled Topic", summary: "", themes: [] };
  }
}

/**
 * Use LLM to find cross-topic relationships.
 */
async function findRelatedTopics(
  topics: GeneratedTopic[],
): Promise<Map<string, string[]>> {
  if (topics.length < 2) return new Map();

  const topicList = topics.map((t) => ({
    slug: t.slug,
    name: t.name,
    themes: t.themes.slice(0, 3),
  }));

  const prompt = `Given these research topics, identify which are related to each other.
Return ONLY valid JSON — an object where each key is a topic slug and the value is an array of related topic slugs (max 3 per topic).
Only include genuinely related topics, not every topic.

TOPICS:
${JSON.stringify(topicList, null, 1)}`;

  try {
    const text = await chatComplete(prompt, { maxTokens: 1024 });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return new Map();
    const parsed = JSON.parse(match[0]) as Record<string, string[]>;
    const result = new Map<string, string[]>();
    for (const [slug, related] of Object.entries(parsed)) {
      if (Array.isArray(related)) {
        result.set(
          slug,
          related.filter((r) => typeof r === "string").slice(0, 3),
        );
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

// ── Markdown generation ──────────────────────────────────────────────────────

function generateTopicMarkdown(
  topic: GeneratedTopic,
  bookmarks: EnrichedBookmark[],
  allTopics: GeneratedTopic[],
): string {
  const date = new Date().toISOString().split("T")[0];
  const categories = [...new Set(bookmarks.flatMap((b) => b.categories))].slice(
    0,
    5,
  );

  let md = `# ${topic.name}\n\n`;
  md += `> Auto-generated from Siftly bookmark analysis\n`;
  md += `> Generated: ${date} | Bookmarks: ${bookmarks.length}`;
  if (categories.length > 0) md += ` | Categories: ${categories.join(", ")}`;
  md += `\n\n`;

  // Summary
  md += `## Summary\n\n${topic.summary}\n\n`;

  // Key Themes
  if (topic.themes.length > 0) {
    md += `## Key Themes\n\n`;
    for (const theme of topic.themes) {
      md += `- ${theme}\n`;
    }
    md += `\n`;
  }

  // Source Bookmarks
  md += `## Source Bookmarks\n\n`;
  md += `| Author | Content | Tags |\n`;
  md += `|--------|---------|------|\n`;
  for (const bm of bookmarks.slice(0, 20)) {
    const excerpt = bm.text
      .replace(/\n/g, " ")
      .slice(0, 120)
      .replace(/\|/g, "\\|");
    const topTags = bm.semanticTags
      .slice(0, 4)
      .join(", ")
      .replace(/\|/g, "\\|");
    md += `| @${bm.authorHandle} | ${excerpt} | ${topTags} |\n`;
  }
  if (bookmarks.length > 20) {
    md += `\n*...and ${bookmarks.length - 20} more bookmarks*\n`;
  }
  md += `\n`;

  // Related Topics
  const related = allTopics.filter((t) => topic.relatedSlugs.includes(t.slug));
  if (related.length > 0) {
    md += `---\n\n## Related Topics\n\n`;
    for (const r of related) {
      md += `- [[research/topics/${r.slug}|${r.name}]]\n`;
    }
    md += `\n`;
  }

  // Footer
  md += `---\n\n## Related\n\n`;
  md += `- [[research/topics/_index|Research Topics Index]]\n`;

  // Tags for Obsidian
  const tagList = topic.themes
    .slice(0, 3)
    .map((t) => `#${slugify(t)}`)
    .join(" ");
  if (tagList) md += `\n${tagList}\n`;

  return md;
}

function generateIndexMarkdown(
  topics: GeneratedTopic[],
  totalBookmarks: number,
): string {
  const date = new Date().toISOString().split("T")[0];

  let md = `# Research Topics Index\n\n`;
  md += `> Auto-generated from Siftly bookmark analysis\n`;
  md += `> Last generated: ${date} | Topics: ${topics.length} | Bookmarks analyzed: ${totalBookmarks}\n\n`;

  md += `## Topics\n\n`;
  md += `| Topic | Bookmarks | Themes |\n`;
  md += `|-------|-----------|--------|\n`;

  const sorted = [...topics].sort(
    (a, b) => b.bookmarkIds.length - a.bookmarkIds.length,
  );
  for (const t of sorted) {
    const themes = t.themes.slice(0, 3).join(", ");
    md += `| [[research/topics/${t.slug}\\|${t.name}]] | ${t.bookmarkIds.length} | ${themes} |\n`;
  }
  md += `\n`;

  md += `---\n\n## Related\n\n`;
  md += `- [[research/agent-architecture/_index|Agent Architecture Index]]\n`;
  md += `- [[research/bookmarks/README|Bookmarks]]\n`;

  return md;
}

// ── Main pipeline ────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_PATH = path.join(
  process.env.HOME || "/tmp",
  "Documents/GitHub/life-os/research/topics",
);

export type TopicPhase =
  | "starting"
  | "loading"
  | "embedding"
  | "clustering"
  | "synthesizing"
  | "linking"
  | "writing"
  | null;

export interface TopicGenerationProgress {
  status: "idle" | "running" | "stopping";
  phase: TopicPhase;
  done: number;
  total: number;
  lastError: string | null;
  error: string | null;
}

const globalTopicState = globalThis as unknown as {
  topicGenState: TopicGenerationProgress;
  topicGenAbort: boolean;
};

if (!globalTopicState.topicGenState) {
  globalTopicState.topicGenState = {
    status: "idle",
    phase: null,
    done: 0,
    total: 0,
    lastError: null,
    error: null,
  };
}
if (globalTopicState.topicGenAbort === undefined) {
  globalTopicState.topicGenAbort = false;
}

export function getTopicState(): TopicGenerationProgress {
  return { ...globalTopicState.topicGenState };
}

export function setTopicState(update: Partial<TopicGenerationProgress>): void {
  globalTopicState.topicGenState = {
    ...globalTopicState.topicGenState,
    ...update,
  };
}

export function requestTopicAbort(): void {
  globalTopicState.topicGenAbort = true;
  setTopicState({ status: "stopping" });
}

function shouldAbortTopics(): boolean {
  return globalTopicState.topicGenAbort;
}

/**
 * Get output path from settings or fall back to default.
 */
async function getOutputPath(): Promise<string> {
  const setting = await prisma.setting
    .findUnique({ where: { key: "researchTopicsPath" } })
    .catch(() => null);
  return setting?.value?.trim() || DEFAULT_OUTPUT_PATH;
}

/**
 * Run the full topic generation pipeline.
 */
export async function generateResearchTopics(
  options: TopicGenerationOptions = {},
): Promise<GeneratedTopic[]> {
  const {
    distanceThreshold = 0.3,
    minClusterSize = 3,
    maxTopics = 50,
  } = options;

  globalTopicState.topicGenAbort = false;
  setTopicState({
    status: "running",
    phase: "loading",
    done: 0,
    total: 0,
    lastError: null,
    error: null,
  });

  try {
    // 1. Load all enriched bookmarks
    setTopicState({ phase: "loading" });
    const rows = await prisma.bookmark.findMany({
      where: { semanticTags: { not: null } },
      select: {
        id: true,
        tweetId: true,
        text: true,
        authorHandle: true,
        authorName: true,
        semanticTags: true,
        enrichmentMeta: true,
        entities: true,
        categories: {
          select: { category: { select: { name: true } } },
        },
      },
      orderBy: { id: "asc" },
    });

    if (rows.length < minClusterSize) {
      setTopicState({
        error: `Only ${rows.length} enriched bookmarks. Need at least ${minClusterSize}.`,
      });
      return [];
    }

    const bookmarks: EnrichedBookmark[] = rows.map((r) => {
      let tags: string[] = [];
      try {
        if (r.semanticTags) tags = JSON.parse(r.semanticTags);
      } catch {
        /* ignore */
      }
      let meta: {
        sentiment?: string;
        people?: string[];
        companies?: string[];
      } = {};
      try {
        if (r.enrichmentMeta) meta = JSON.parse(r.enrichmentMeta);
      } catch {
        /* ignore */
      }
      let entities: EnrichedBookmark["entities"];
      try {
        if (r.entities) entities = JSON.parse(r.entities);
      } catch {
        /* ignore */
      }

      return {
        id: r.id,
        tweetId: r.tweetId,
        text: r.text,
        authorHandle: r.authorHandle,
        authorName: r.authorName,
        semanticTags: tags,
        sentiment: meta.sentiment,
        people: meta.people,
        companies: meta.companies,
        categories: r.categories.map((c) => c.category.name),
        entities,
      };
    });

    setTopicState({ total: bookmarks.length });

    if (shouldAbortTopics()) return [];

    // 2. Compute embeddings
    setTopicState({ phase: "embedding" });
    const bookmarkIds = bookmarks.map((b) => b.id);
    await computeMissingEmbeddings(bookmarkIds, (done) => {
      setTopicState({ done, phase: "embedding" });
    });

    if (shouldAbortTopics()) return [];

    // 3. Load all embeddings
    setTopicState({ phase: "clustering", done: 0 });
    const embeddingRows = await prisma.bookmarkEmbedding.findMany({
      where: { bookmarkId: { in: bookmarkIds } },
      select: { bookmarkId: true, embedding: true },
    });

    const embeddingMap = new Map<string, number[]>();
    for (const row of embeddingRows) {
      try {
        embeddingMap.set(row.bookmarkId, JSON.parse(row.embedding));
      } catch {
        /* ignore */
      }
    }

    // Filter to bookmarks that have embeddings
    const embeddedBookmarks = bookmarks.filter((b) => embeddingMap.has(b.id));
    const vectors = embeddedBookmarks.map((b) => embeddingMap.get(b.id)!);

    if (embeddedBookmarks.length < minClusterSize) {
      setTopicState({
        error: `Only ${embeddedBookmarks.length} bookmarks with embeddings.`,
      });
      return [];
    }

    // 4. Cluster
    const labels = agglomerativeClustering(vectors, distanceThreshold);

    // Group bookmarks by cluster label
    const clusterMap = new Map<number, EnrichedBookmark[]>();
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!clusterMap.has(label)) clusterMap.set(label, []);
      clusterMap.get(label)!.push(embeddedBookmarks[i]);
    }

    // Filter by minimum size and cap
    const validClusters = [...clusterMap.values()]
      .filter((c) => c.length >= minClusterSize)
      .sort((a, b) => b.length - a.length)
      .slice(0, maxTopics);

    if (validClusters.length === 0) {
      setTopicState({
        error: `No clusters with ${minClusterSize}+ bookmarks at distance threshold ${distanceThreshold}. Try increasing the threshold.`,
      });
      return [];
    }

    if (shouldAbortTopics()) return [];

    // 5. Synthesize topics with LLM
    setTopicState({
      phase: "synthesizing",
      done: 0,
      total: validClusters.length,
    });
    const topics: GeneratedTopic[] = [];

    for (let i = 0; i < validClusters.length; i++) {
      if (shouldAbortTopics()) break;

      const cluster = validClusters[i];
      const result = await synthesizeCluster(cluster);

      let slug = slugify(result.name);
      // Ensure unique slug
      const existingSlugs = new Set(topics.map((t) => t.slug));
      if (existingSlugs.has(slug)) slug = `${slug}-${i + 1}`;

      topics.push({
        slug,
        name: result.name,
        summary: result.summary,
        themes: result.themes,
        bookmarkIds: cluster.map((b) => b.id),
        relatedSlugs: [],
      });

      setTopicState({ done: i + 1 });
    }

    if (shouldAbortTopics()) return topics;

    // 6. Find cross-topic relationships
    setTopicState({ phase: "linking" });
    const relatedMap = await findRelatedTopics(topics);
    for (const topic of topics) {
      topic.relatedSlugs = relatedMap.get(topic.slug) || [];
    }

    // 7. Write markdown files
    setTopicState({ phase: "writing" });
    const outputPath = options.outputPath || (await getOutputPath());
    await fs.mkdir(outputPath, { recursive: true });

    // Build bookmark lookup for markdown generation
    const bookmarkLookup = new Map(embeddedBookmarks.map((b) => [b.id, b]));

    for (const topic of topics) {
      const topicBookmarks = topic.bookmarkIds
        .map((id) => bookmarkLookup.get(id))
        .filter((b): b is EnrichedBookmark => b !== undefined);

      const markdown = generateTopicMarkdown(topic, topicBookmarks, topics);
      await fs.writeFile(
        path.join(outputPath, `${topic.slug}.md`),
        markdown,
        "utf-8",
      );
    }

    // Write index
    const indexMd = generateIndexMarkdown(topics, embeddedBookmarks.length);
    await fs.writeFile(path.join(outputPath, "_index.md"), indexMd, "utf-8");

    // 8. Store topics in DB
    await prisma.researchTopic.deleteMany({}); // clear old topics
    await prisma.researchTopic.createMany({
      data: topics.map((t) => ({
        slug: t.slug,
        name: t.name,
        summary: t.summary,
        themes: JSON.stringify(t.themes),
        bookmarkIds: JSON.stringify(t.bookmarkIds),
      })),
    });

    return topics;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setTopicState({ lastError: msg.slice(0, 200) });
    throw err;
  } finally {
    const wasStopped = globalTopicState.topicGenAbort;
    globalTopicState.topicGenAbort = false;
    setTopicState({
      status: "idle",
      phase: null,
      error: wasStopped ? "Stopped by user" : getTopicState().error,
    });
  }
}
