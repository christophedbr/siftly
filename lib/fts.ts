/**
 * PostgreSQL full-text search for bookmarks.
 * Replaces SQLite FTS5 with Postgres tsvector/tsquery.
 */

import prisma from "@/lib/db";

/**
 * Search bookmarks using PostgreSQL full-text search.
 * Returns bookmark IDs ordered by relevance rank.
 * Returns [] on error (caller should fall back to LIKE queries).
 */
export async function ftsSearch(keywords: string[]): Promise<string[]> {
  if (keywords.length === 0) return [];

  try {
    // Sanitize keywords: remove special chars
    const terms = keywords
      .map((kw) => kw.replace(/[^a-zA-Z0-9\s]/g, "").trim())
      .filter((kw) => kw.length >= 2);

    if (terms.length === 0) return [];

    // Build tsquery with OR between terms
    const tsquery = terms.join(" | ");

    const results = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Bookmark"
      WHERE to_tsvector('english',
        coalesce(text, '') || ' ' ||
        coalesce("semanticTags", '') || ' ' ||
        coalesce(entities, '')
      ) @@ to_tsquery('english', ${tsquery})
      ORDER BY ts_rank(
        to_tsvector('english',
          coalesce(text, '') || ' ' ||
          coalesce("semanticTags", '') || ' ' ||
          coalesce(entities, '')
        ),
        to_tsquery('english', ${tsquery})
      ) DESC
      LIMIT 150
    `;
    return results.map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * No-op for Postgres — FTS is built-in, no virtual table needed.
 */
export async function ensureFtsTable(): Promise<void> {
  // Postgres FTS works directly on columns, no separate table needed
}

/**
 * No-op for Postgres — no separate FTS table to rebuild.
 */
export async function rebuildFts(): Promise<void> {
  // Postgres FTS works directly on columns
}
