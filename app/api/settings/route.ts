import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";

function maskKey(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.length <= 8) return "********";
  return `${raw.slice(0, 6)}${"*".repeat(raw.length - 10)}${raw.slice(-4)}`;
}

const ALLOWED_ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
] as const;

const ALLOWED_OPENAI_MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
] as const;

const ALLOWED_PROVIDERS = ["anthropic", "openai"] as const;

export async function GET(): Promise<NextResponse> {
  try {
    const [anthropic, anthropicModel, openai, openaiModel, aiProvider] =
      await Promise.all([
        prisma.setting.findUnique({ where: { key: "anthropicApiKey" } }),
        prisma.setting.findUnique({ where: { key: "anthropicModel" } }),
        prisma.setting.findUnique({ where: { key: "openaiApiKey" } }),
        prisma.setting.findUnique({ where: { key: "openaiModel" } }),
        prisma.setting.findUnique({ where: { key: "aiProvider" } }),
      ]);

    return NextResponse.json({
      anthropicApiKey: maskKey(anthropic?.value ?? null),
      hasAnthropicKey: anthropic !== null,
      anthropicModel: anthropicModel?.value ?? "claude-haiku-4-5-20251001",
      openaiApiKey: maskKey(openai?.value ?? null),
      hasOpenaiKey: openai !== null,
      openaiModel: openaiModel?.value ?? "gpt-4o-mini",
      aiProvider: aiProvider?.value ?? "anthropic",
    });
  } catch (err) {
    console.error("Settings GET error:", err);
    return NextResponse.json(
      {
        error: `Failed to fetch settings: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: {
    anthropicApiKey?: string;
    anthropicModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    aiProvider?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Save AI provider
  if (body.aiProvider !== undefined) {
    if (!(ALLOWED_PROVIDERS as readonly string[]).includes(body.aiProvider)) {
      return NextResponse.json(
        { error: "Invalid AI provider" },
        { status: 400 },
      );
    }
    await prisma.setting.upsert({
      where: { key: "aiProvider" },
      update: { value: body.aiProvider },
      create: { key: "aiProvider", value: body.aiProvider },
    });
    return NextResponse.json({ saved: true });
  }

  // Save Anthropic model
  if (body.anthropicModel !== undefined) {
    if (
      !(ALLOWED_ANTHROPIC_MODELS as readonly string[]).includes(
        body.anthropicModel,
      )
    ) {
      return NextResponse.json(
        { error: "Invalid Anthropic model" },
        { status: 400 },
      );
    }
    await prisma.setting.upsert({
      where: { key: "anthropicModel" },
      update: { value: body.anthropicModel },
      create: { key: "anthropicModel", value: body.anthropicModel },
    });
    return NextResponse.json({ saved: true });
  }

  // Save OpenAI model
  if (body.openaiModel !== undefined) {
    if (
      !(ALLOWED_OPENAI_MODELS as readonly string[]).includes(body.openaiModel)
    ) {
      return NextResponse.json(
        { error: "Invalid OpenAI model" },
        { status: 400 },
      );
    }
    await prisma.setting.upsert({
      where: { key: "openaiModel" },
      update: { value: body.openaiModel },
      create: { key: "openaiModel", value: body.openaiModel },
    });
    return NextResponse.json({ saved: true });
  }

  // Save API keys
  for (const [bodyKey, settingKey] of [
    ["anthropicApiKey", "anthropicApiKey"],
    ["openaiApiKey", "openaiApiKey"],
  ] as const) {
    const value = body[bodyKey];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim() === "") {
        return NextResponse.json(
          { error: `Invalid ${bodyKey} value` },
          { status: 400 },
        );
      }
      try {
        await prisma.setting.upsert({
          where: { key: settingKey },
          update: { value: value.trim() },
          create: { key: settingKey, value: value.trim() },
        });
        return NextResponse.json({ saved: true });
      } catch (err) {
        console.error(`Settings POST (${settingKey}) error:`, err);
        return NextResponse.json(
          {
            error: `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
          },
          { status: 500 },
        );
      }
    }
  }

  return NextResponse.json({ error: "No setting provided" }, { status: 400 });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  let body: { key?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const allowed = ["anthropicApiKey", "openaiApiKey"];
  if (!body.key || !allowed.includes(body.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  await prisma.setting.deleteMany({ where: { key: body.key } });
  return NextResponse.json({ deleted: true });
}
