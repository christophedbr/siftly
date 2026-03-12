/**
 * X API v2 Bookmark Sync via OAuth 2.0
 *
 * Uses the official X API v2 bookmarks endpoint with PKCE OAuth tokens.
 * Tokens are stored as env vars (X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN).
 * Token refresh uses Node.js https module to bypass Next.js fetch patching.
 */

import https from "https";
import prisma from "@/lib/db";

// ── Token management ────────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

/** Raw HTTPS POST — bypasses Next.js fetch patching that strips Authorization headers */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 500,
              data: JSON.parse(raw),
            });
          } catch {
            reject(new Error(`Invalid JSON from ${url}: ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;

  // Use DB-stored token (rotated) if available, else fall back to env
  const dbToken = await prisma.setting
    .findUnique({ where: { key: "x_refresh_token_latest" } })
    .then((s) => s?.value)
    .catch(() => null);
  const refreshToken = dbToken || process.env.X_REFRESH_TOKEN;

  if (!clientId || !refreshToken) {
    throw new Error(
      "X API credentials not configured (X_CLIENT_ID, X_REFRESH_TOKEN)",
    );
  }

  // Confidential client: Basic auth + client_id in body
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();

  const { status, data } = await httpsPost(
    "https://api.twitter.com/2/oauth2/token",
    headers,
    body,
  );

  if (status !== 200 || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token as string;
  tokenExpiresAt =
    Date.now() + ((data.expires_in as number) ?? 7200) * 1000 - 60_000;

  // Store rotated refresh token in DB for persistence
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await prisma.setting.upsert({
      where: { key: "x_refresh_token_latest" },
      update: { value: data.refresh_token as string },
      create: {
        key: "x_refresh_token_latest",
        value: data.refresh_token as string,
      },
    });
  }

  return cachedAccessToken!;
}

export async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }
  return refreshAccessToken();
}

// ── X API v2 calls ──────────────────────────────────────────────────────────

export async function xGet(endpoint: string, token: string) {
  const res = await fetch(`https://api.twitter.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function getMyUserId(token: string): Promise<string> {
  const { status, data } = await xGet("/2/users/me", token);
  if (status !== 200)
    throw new Error(`Failed to get user: ${JSON.stringify(data)}`);
  return data.data.id;
}

// ── Sync bookmarks ──────────────────────────────────────────────────────────

interface XUser {
  id: string;
  username: string;
  name: string;
}

interface XTweet {
  id: string;
  text: string;
  author_id: string;
  created_at?: string;
  entities?: {
    hashtags?: { tag: string }[];
    urls?: { expanded_url: string }[];
    mentions?: { username: string }[];
  };
}

export async function syncFromXApi(): Promise<{
  imported: number;
  skipped: number;
  total: number;
}> {
  const token = await getAccessToken();
  const userId = await getMyUserId(token);

  // Fetch small pages — stop as soon as we hit a full page of known bookmarks.
  // The API returns newest-first, so new bookmarks are always on page 1.
  const params = new URLSearchParams({
    max_results: "20",
    "tweet.fields": "created_at,entities,author_id",
    "user.fields": "username,name",
    expansions: "author_id",
  });

  let imported = 0;
  let skipped = 0;
  let paginationToken: string | null = null;
  let pages = 0;
  const maxPages = 5;

  do {
    const url = `/2/users/${userId}/bookmarks?${params}${
      paginationToken ? `&pagination_token=${paginationToken}` : ""
    }`;
    const { status, data } = await xGet(url, token);

    if (status === 401) {
      const newToken = await refreshAccessToken();
      const retry = await xGet(url, newToken);
      if (retry.status !== 200) {
        throw new Error(`X API error after refresh: ${retry.status}`);
      }
      Object.assign(data, retry.data);
    } else if (status !== 200) {
      if (data?.errors?.[0]?.message) throw new Error(data.errors[0].message);
      throw new Error(`X API error: ${status}`);
    }

    const tweets: XTweet[] = data.data ?? [];
    const users: XUser[] = data.includes?.users ?? [];
    const userMap = new Map(users.map((u: XUser) => [u.id, u]));

    let pageImported = 0;

    for (const tweet of tweets) {
      const exists = await prisma.bookmark.findUnique({
        where: { tweetId: tweet.id },
        select: { id: true },
      });

      if (exists) {
        skipped++;
        continue;
      }

      const author = userMap.get(tweet.author_id);

      let parsedDate: Date | null = null;
      if (tweet.created_at) {
        const d = new Date(tweet.created_at);
        if (!isNaN(d.getTime())) parsedDate = d;
      }

      await prisma.bookmark.create({
        data: {
          tweetId: tweet.id,
          text: tweet.text,
          authorHandle: author?.username ?? "unknown",
          authorName: author?.name ?? "Unknown",
          tweetCreatedAt: parsedDate,
          rawJson: JSON.stringify(tweet),
          source: "bookmark",
        },
      });

      pageImported++;
      imported++;
    }

    // If an entire page was already known, no point fetching more
    if (pageImported === 0 && tweets.length > 0) break;

    paginationToken = data.meta?.next_token ?? null;
    pages++;
  } while (paginationToken && pages < maxPages);

  // Update last sync timestamp
  if (imported > 0 || skipped > 0) {
    await prisma.setting.upsert({
      where: { key: "x_api_last_sync" },
      update: { value: new Date().toISOString() },
      create: { key: "x_api_last_sync", value: new Date().toISOString() },
    });
  }

  return { imported, skipped, total: imported + skipped };
}

export function isXApiConfigured(): boolean {
  return !!(process.env.X_CLIENT_ID && process.env.X_REFRESH_TOKEN);
}
