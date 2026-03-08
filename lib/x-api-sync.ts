/**
 * X API v2 Bookmark Sync via OAuth 2.0
 *
 * Uses the official X API v2 bookmarks endpoint with PKCE OAuth tokens.
 * Tokens are stored as env vars (X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN).
 */

import prisma from "@/lib/db";

// ── Token management ────────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function refreshAccessToken(): Promise<string> {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  const refreshToken = process.env.X_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "X API credentials not configured (X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN)",
    );
  }

  const res = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.access_token as string;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000 - 60_000; // 1 min buffer

  // If we got a new refresh token, store it in the DB for persistence
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await prisma.setting.upsert({
      where: { key: "x_refresh_token_latest" },
      update: { value: data.refresh_token },
      create: { key: "x_refresh_token_latest", value: data.refresh_token },
    });
  }

  return cachedAccessToken!;
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }
  return refreshAccessToken();
}

// ── X API v2 calls ──────────────────────────────────────────────────────────

async function xGet(endpoint: string, token: string) {
  const res = await fetch(`https://api.twitter.com${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
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

  const params = new URLSearchParams({
    max_results: "100",
    "tweet.fields": "created_at,entities,author_id",
    "user.fields": "username,name",
    expansions: "author_id",
  });

  let imported = 0;
  let skipped = 0;
  let paginationToken: string | null = null;
  let pages = 0;
  const maxPages = 8;

  do {
    const url = `/2/users/${userId}/bookmarks?${params}${
      paginationToken ? `&pagination_token=${paginationToken}` : ""
    }`;
    const { status, data } = await xGet(url, token);

    if (status === 401) {
      // Token expired mid-sync, refresh and retry
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

      imported++;
    }

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
  return !!(
    process.env.X_CLIENT_ID &&
    process.env.X_CLIENT_SECRET &&
    process.env.X_REFRESH_TOKEN
  );
}
