/**
 * Shared link metadata extraction utilities.
 *
 * Used by both the link-preview API route and the categorization pipeline
 * to fetch OG metadata from URLs embedded in bookmarks.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Block requests to private/loopback addresses to prevent SSRF */
export function isPrivateUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== "http:" && protocol !== "https:") return true;
    if (hostname === "localhost" || hostname === "0.0.0.0") return true;
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^169\.254\./.test(hostname)) return true;
    if (hostname === "::1" || /^\[::1\]$/.test(hostname)) return true;
    if (/^fd[0-9a-f]{2,}:/i.test(hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function extractMeta(html: string, ...patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return "";
}

/** For JS-rendered platforms that can't be scraped, derive a human-readable title */
export function syntheticTitle(finalUrl: string, siteName: string): string {
  try {
    const { hostname, pathname } = new URL(finalUrl);
    const host = hostname.replace(/^www\./, "");

    if (
      (host === "x.com" || host === "twitter.com") &&
      pathname.startsWith("/i/article")
    ) {
      return "Article on X";
    }
    if (host === "x.com" || host === "twitter.com") {
      return "View on X";
    }
    if (siteName) return `Article on ${siteName}`;
  } catch {
    /* ignore */
  }
  return "";
}

// ── Pipeline link fetching ───────────────────────────────────────────────

export interface LinkSummary {
  url: string;
  title: string;
  description: string;
  siteName: string;
}

/** Domains already covered by the tweet text — no need to fetch */
const SKIP_DOMAINS = new Set([
  "x.com",
  "twitter.com",
  "t.co",
  "pic.twitter.com",
]);

export function shouldSkipUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return SKIP_DOMAINS.has(hostname.replace(/^www\./, ""));
  } catch {
    return true;
  }
}

/**
 * Fetch OG metadata from a single URL. Returns null on failure.
 * Reads only the first 50KB (enough for <head> tags).
 */
async function fetchLinkMeta(url: string): Promise<LinkSummary | null> {
  if (isPrivateUrl(url) || shouldSkipUrl(url)) return null;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;

    let html = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (bytes < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytes += value.length;
      if (html.includes("</head>")) break;
    }
    reader.cancel().catch(() => {});

    // Resolve t.co redirects
    let finalUrl = res.url;
    const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const titleTagText = titleTagMatch?.[1]?.trim() ?? "";
    if (
      titleTagText.match(/^https?:\/\//) &&
      (() => {
        try {
          return new URL(finalUrl).hostname.includes("t.co");
        } catch {
          return false;
        }
      })()
    ) {
      finalUrl = titleTagText;
      // If the resolved URL is a twitter/x link, skip it
      if (shouldSkipUrl(finalUrl)) return null;
    }

    const title = extractMeta(
      html,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    );

    const description = extractMeta(
      html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    );

    const siteName = extractMeta(
      html,
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    );

    const resolvedTitle = title || syntheticTitle(finalUrl, siteName);

    // Only return if we got something useful
    if (!resolvedTitle && !description) return null;

    return {
      url: finalUrl,
      title: resolvedTitle,
      description: description.slice(0, 300),
      siteName,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch OG metadata for a list of URLs (up to 3 per call, 4s timeout each).
 * Skips x.com/twitter.com/t.co URLs (already covered by tweet text).
 */
export async function fetchLinkSummaries(
  urls: string[],
): Promise<LinkSummary[]> {
  const unique = [...new Set(urls)].slice(0, 3);
  const results = await Promise.all(unique.map(fetchLinkMeta));
  return results.filter((r): r is LinkSummary => r !== null);
}
