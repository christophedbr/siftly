import { NextRequest, NextResponse } from "next/server";
import { isPrivateUrl, extractMeta, syntheticTitle } from "@/lib/link-content";

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=86400", // cache 24h
};

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  if (isPrivateUrl(url)) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `HTTP ${res.status}` },
        { status: 502 },
      );
    }

    // Only read first 50KB — enough for head tags
    const reader = res.body?.getReader();
    if (!reader)
      return NextResponse.json({ error: "no body" }, { status: 502 });

    let html = "";
    let bytes = 0;
    while (bytes < 50_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      bytes += value.length;
      // Stop once we've passed </head>
      if (html.includes("</head>")) break;
    }
    reader.cancel().catch(() => {});

    let finalUrl = res.url;

    // t.co with a browser UA returns a 200 JS-redirect page; the destination URL
    // appears in the <title> tag.  Detect this and use the real destination URL.
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
    }

    const domain = (() => {
      try {
        return new URL(finalUrl).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    })();

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

    const image = extractMeta(
      html,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    );

    const siteName = extractMeta(
      html,
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    );

    const resolvedTitle = title || syntheticTitle(finalUrl, siteName);

    return NextResponse.json(
      {
        title: resolvedTitle,
        description,
        image,
        siteName,
        domain,
        url: finalUrl,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "preview failed";
    return NextResponse.json(
      { error: msg },
      { status: 502, headers: CACHE_HEADERS },
    );
  }
}
