/** Normalize reported OpenAI/DeepSeek usage only; absent or contradictory evidence stays unknown. */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function normalizeOpenAiTokenUsage(raw) {
  if (!record(raw) || !count(raw.prompt_tokens) || !count(raw.completion_tokens)) return null;
  const prompt = raw.prompt_tokens, outputTokens = raw.completion_tokens;
  if (Object.hasOwn(raw, 'prompt_tokens_details') && !record(raw.prompt_tokens_details)) return null;
  if (Object.hasOwn(raw, 'completion_tokens_details') && !record(raw.completion_tokens_details)) return null;
  const promptDetails = raw.prompt_tokens_details || {};
  const completionDetails = raw.completion_tokens_details || {};
  const hasCached = Object.hasOwn(promptDetails, 'cached_tokens'), hasHit = Object.hasOwn(raw, 'prompt_cache_hit_tokens');
  const cached = hasCached ? promptDetails.cached_tokens : undefined;
  const hit = hasHit ? raw.prompt_cache_hit_tokens : undefined;
  if ((hasCached && !count(cached)) || (hasHit && !count(hit))) return null;
  if (hasCached && hasHit && cached !== hit) return null;
  const cacheReadTokens = cached ?? hit ?? 0;
  if (cacheReadTokens > prompt) return null;
  const inputTokens = prompt - cacheReadTokens;
  if (Object.hasOwn(raw, 'prompt_cache_miss_tokens') && (!count(raw.prompt_cache_miss_tokens) || raw.prompt_cache_miss_tokens !== inputTokens)) return null;
  const hasReasoning = Object.hasOwn(completionDetails, 'reasoning_tokens');
  const reasoning = hasReasoning ? completionDetails.reasoning_tokens : undefined;
  if (hasReasoning && (!count(reasoning) || reasoning > outputTokens)) return null;
  // prompt_tokens already contains cache hits; reasoning_tokens already belongs to completion_tokens.
  const totalTokens = prompt + outputTokens;
  if (!count(totalTokens) || totalTokens === 0) return null;
  if (Object.hasOwn(raw, 'total_tokens') && (!count(raw.total_tokens) || raw.total_tokens !== totalTokens)) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, totalTokens,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) };
}
