/**
 * Provider-agnostic AI client.
 *
 * Supports Anthropic (Claude) and OpenAI (GPT) based on the `aiProvider` setting.
 * Falls back to Anthropic if no provider is configured.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import prisma from "@/lib/db";
import { resolveAnthropicClient } from "@/lib/claude-cli-auth";

export type AIProvider = "anthropic" | "openai";

// ── Settings cache ────────────────────────────────────────────────────────

let _providerCache: AIProvider | null = null;
let _providerExpiry = 0;

export async function getAIProvider(): Promise<AIProvider> {
  if (_providerCache && Date.now() < _providerExpiry) return _providerCache;
  const setting = await prisma.setting
    .findUnique({ where: { key: "aiProvider" } })
    .catch(() => null);
  _providerCache = (setting?.value as AIProvider) ?? "anthropic";
  _providerExpiry = Date.now() + 60_000;
  return _providerCache;
}

let _modelCache: string | null = null;
let _modelExpiry = 0;

async function getModel(provider: AIProvider): Promise<string> {
  if (_modelCache && Date.now() < _modelExpiry) return _modelCache;
  const key = provider === "openai" ? "openaiModel" : "anthropicModel";
  const setting = await prisma.setting
    .findUnique({ where: { key } })
    .catch(() => null);
  _modelCache =
    setting?.value ??
    (provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001");
  _modelExpiry = Date.now() + 5 * 60 * 1000;
  return _modelCache;
}

// ── OpenAI key cache ─────────────────────────────────────────────────────

let _openaiKeyCache: string | null = null;
let _openaiKeyExpiry = 0;

async function getOpenAIKey(): Promise<string> {
  if (_openaiKeyCache && Date.now() < _openaiKeyExpiry) return _openaiKeyCache;
  const dbKey = await prisma.setting
    .findUnique({ where: { key: "openaiApiKey" } })
    .then((s) => s?.value?.trim() ?? "")
    .catch(() => "");
  const key = dbKey || process.env.OPENAI_API_KEY?.trim() || "";
  _openaiKeyCache = key;
  _openaiKeyExpiry = Date.now() + 60_000;
  return key;
}

// ── Client construction ───────────────────────────────────────────────────

function createOpenAIClient(dbKey?: string): OpenAI {
  const apiKey = dbKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("No OpenAI API key configured.");
  return new OpenAI({ apiKey });
}

let _openaiClientCache: OpenAI | null = null;
let _openaiClientKey = "";

/**
 * Get a cached OpenAI client (avoids DB lookup + allocation per call during pipeline runs).
 */
export async function getCachedOpenAIClient(): Promise<OpenAI> {
  const key = await getOpenAIKey();
  if (!key) throw new Error("No OpenAI API key configured.");
  if (!_openaiClientCache || _openaiClientKey !== key) {
    _openaiClientCache = new OpenAI({ apiKey: key });
    _openaiClientKey = key;
  }
  return _openaiClientCache;
}

/**
 * Pre-flight check: verify the configured provider has an API key before
 * starting a long pipeline. Returns an error message or null if OK.
 */
export async function preflightProviderCheck(
  resolvedProvider?: AIProvider,
): Promise<string | null> {
  const provider = resolvedProvider ?? (await getAIProvider());
  if (provider === "openai") {
    const key = await getOpenAIKey();
    if (!key) return "No OpenAI API key configured. Go to Settings to add one.";
  } else {
    const dbKey = await prisma.setting
      .findUnique({ where: { key: "anthropicApiKey" } })
      .then((s) => s?.value?.trim() ?? "")
      .catch(() => "");
    if (!dbKey && !process.env.ANTHROPIC_API_KEY) {
      return "No Anthropic API key configured. Go to Settings to add one, or log in with Claude CLI.";
    }
  }
  return null;
}

// ── Unified completion ────────────────────────────────────────────────────

export interface CompletionOptions {
  maxTokens?: number;
  /** Override the provider for this call */
  provider?: AIProvider;
}

/**
 * Send a prompt and get a text response, using whichever provider is configured.
 */
export async function chatComplete(
  prompt: string,
  options: CompletionOptions = {},
): Promise<string> {
  const provider = options.provider ?? (await getAIProvider());
  const model = await getModel(provider);
  const maxTokens = options.maxTokens ?? 2048;

  if (provider === "openai") {
    const client = await getCachedOpenAIClient();
    const res = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return res.choices[0]?.message?.content ?? "";
  }

  // Anthropic
  const dbKey = await prisma.setting
    .findUnique({ where: { key: "anthropicApiKey" } })
    .then((s) => s?.value ?? "")
    .catch(() => "");
  const client = resolveAnthropicClient({ dbKey });
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const textBlock = msg.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return textBlock?.text ?? "";
}

/**
 * Test that the configured provider's API key works.
 */
export async function testProvider(
  provider: AIProvider,
): Promise<{ working: boolean; error?: string }> {
  try {
    if (provider === "openai") {
      const dbKey = await prisma.setting
        .findUnique({ where: { key: "openaiApiKey" } })
        .then((s) => s?.value ?? "")
        .catch(() => "");
      const client = createOpenAIClient(dbKey);
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
      });
      return { working: true };
    }

    // Anthropic
    const dbKey = await prisma.setting
      .findUnique({ where: { key: "anthropicApiKey" } })
      .then((s) => s?.value ?? "")
      .catch(() => "");
    const client = resolveAnthropicClient({ dbKey });
    await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    });
    return { working: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly =
      msg.includes("401") || msg.includes("invalid")
        ? "Invalid API key"
        : msg.includes("403")
          ? "Key does not have permission"
          : msg.slice(0, 120);
    return { working: false, error: friendly };
  }
}
