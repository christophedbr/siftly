import prisma from "@/lib/db";

// Module-level model cache — avoids hundreds of DB roundtrips per pipeline run
let _cachedModel: string | null = null;
let _modelCacheExpiry = 0;

/**
 * Get the configured Anthropic model from settings (cached for 5 minutes).
 */
export async function getAnthropicModel(): Promise<string> {
  if (_cachedModel && Date.now() < _modelCacheExpiry) return _cachedModel;
  const setting = await prisma.setting.findUnique({
    where: { key: "anthropicModel" },
  });
  _cachedModel = setting?.value ?? "claude-haiku-4-5-20251001";
  _modelCacheExpiry = Date.now() + 5 * 60 * 1000;
  return _cachedModel;
}
