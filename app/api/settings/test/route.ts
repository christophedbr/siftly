import { NextRequest, NextResponse } from "next/server";
import { testProvider, type AIProvider } from "@/lib/ai-provider";
import { getCliAuthStatus } from "@/lib/claude-cli-auth";

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { provider?: string } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = (body.provider ?? "anthropic") as AIProvider;

  if (provider === "anthropic") {
    // Check CLI auth first for a better error message
    const cliStatus = getCliAuthStatus();
    if (cliStatus.available && cliStatus.expired) {
      return NextResponse.json({
        working: false,
        error: "Claude CLI session expired — run `claude` to refresh",
      });
    }
  }

  const result = await testProvider(provider);
  return NextResponse.json(result);
}
