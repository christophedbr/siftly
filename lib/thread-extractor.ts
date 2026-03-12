/**
 * Thread content extraction for bookmarked tweets.
 *
 * When a bookmark is part of a thread (self_thread field), fetches the
 * author's follow-up replies to extract URLs and text from the thread.
 * Uses X API v2 search/recent when OAuth credentials are available.
 */

import { isXApiConfigured, getAccessToken, xGet } from "@/lib/x-api-sync";

// ── Raw JSON helpers ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeGet(obj: any, ...keys: string[]): any {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Extract conversation ID from a thread-starter tweet's raw JSON.
 * The self_thread.id_str field identifies the conversation root.
 */
export function extractConversationId(rawJson: string): string | null {
  if (!rawJson) return null;
  try {
    const tweet = JSON.parse(rawJson);
    const selfThread =
      safeGet(tweet, "self_thread") ?? safeGet(tweet, "legacy", "self_thread");
    if (selfThread?.id_str) return selfThread.id_str;
    // X API v2 format
    if (tweet.conversation_id) return tweet.conversation_id;
    return null;
  } catch {
    return null;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────

let _callCount = 0;
let _windowStart = 0;
const MAX_CALLS_PER_WINDOW = 50; // conservative (180 allowed per 15min)
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(): boolean {
  const now = Date.now();
  if (now - _windowStart > WINDOW_MS) {
    _callCount = 0;
    _windowStart = now;
  }
  return _callCount >= MAX_CALLS_PER_WINDOW;
}

// ── URL filtering ─────────────────────────────────────────────────────────

const SKIP_DOMAINS = new Set([
  "x.com",
  "twitter.com",
  "t.co",
  "pic.twitter.com",
]);

function isSkipDomain(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return SKIP_DOMAINS.has(hostname.replace(/^www\./, ""));
  } catch {
    return true;
  }
}

// ── Thread context fetching ───────────────────────────────────────────────

export interface ThreadContext {
  urls: string[]; // Non-twitter URLs found in thread replies
  replyTexts: string[]; // Text content of thread replies
}

const EMPTY_CONTEXT: ThreadContext = { urls: [], replyTexts: [] };

/**
 * Fetch thread context (URLs + reply text) for a thread-starter bookmark.
 *
 * Uses X API v2 search/recent to find the author's replies in the same
 * conversation. Returns empty context if X API is not configured, rate
 * limited, or the search fails.
 *
 * Note: search/recent only covers the last 7 days. Older threads will
 * return empty context — this is an acceptable trade-off.
 */
export async function fetchThreadContext(
  conversationId: string,
  authorHandle: string,
): Promise<ThreadContext> {
  if (!isXApiConfigured()) return EMPTY_CONTEXT;
  if (isRateLimited()) return EMPTY_CONTEXT;
  if (!conversationId || !authorHandle) return EMPTY_CONTEXT;

  try {
    const token = await getAccessToken();

    // Search for author's replies in this conversation thread
    const query = encodeURIComponent(
      `conversation_id:${conversationId} from:${authorHandle}`,
    );
    const params = new URLSearchParams({
      "tweet.fields": "entities,text",
      max_results: "20",
    });

    const { status, data } = await xGet(
      `/2/tweets/search/recent?query=${query}&${params}`,
      token,
    );

    _callCount++;

    if (status !== 200 || !data.data) {
      if (status === 429) {
        // Rate limited — mark window as full
        _callCount = MAX_CALLS_PER_WINDOW;
        console.warn("[thread-extractor] Rate limited by X API");
      }
      return EMPTY_CONTEXT;
    }

    const urls: string[] = [];
    const replyTexts: string[] = [];

    for (const tweet of data.data as Record<string, unknown>[]) {
      // Skip the conversation root tweet itself
      if ((tweet.id as string) === conversationId) continue;

      // Collect reply text
      if (tweet.text) {
        replyTexts.push(tweet.text as string);
      }

      // Collect URLs from entities
      const tweetUrls =
        ((tweet.entities as Record<string, unknown>)?.urls as {
          expanded_url?: string;
        }[]) ?? [];
      for (const u of tweetUrls) {
        if (u.expanded_url && !isSkipDomain(u.expanded_url)) {
          urls.push(u.expanded_url);
        }
      }
    }

    return {
      urls: [...new Set(urls)],
      replyTexts,
    };
  } catch (err) {
    console.warn(
      "[thread-extractor] Failed to fetch thread:",
      err instanceof Error ? err.message : err,
    );
    return EMPTY_CONTEXT;
  }
}
