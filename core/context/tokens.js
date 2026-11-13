/**
 * illuci — Centralized Token Service
 *
 * Single source of truth for token estimation and context limits.
 * Replaces divergent heuristics in dispatch, store, manager, and bridges.
 *
 * Formation ruling R8: centralized token service with model-specific
 * encodings and context limit mappings.
 */

// ─── MODEL CONTEXT LIMITS ───
// Total context window per model. Conservative — reserves space for output.

// ─── MODEL MAXIMUM CONTEXT WINDOWS ───
// The absolute max each model supports. These don't change.

const MODEL_MAX_CONTEXT = {
  "claude-local": 1000000,
  "codex-local":  1000000,
  "deepseek":     128000,
  "gpt-oss":      128000,
  "qwen-code":    128000,
  "gemini-local": 2000000,
  "grok":         128000,
  "kimi-local":   128000,
  "ollama":       128000,
};

// ─── TIER-BASED CONTEXT LIMITS ───
// What the user actually gets depends on their Illuci tier.
// Internal/operator mode uses full model capacity.
// BYOK users get whatever their key supports (capped at model max).

const TIER_LIMITS = {
  "internal":  null,              // No cap — full model capacity (operator mode)
  "tier-6":    null,              // Saturation — full capacity
  "tier-5":    1000000,           // 1M cap
  "tier-4":    500000,            // 500K cap
  "tier-3":    200000,            // 200K cap
  "tier-2":    128000,            // 128K cap
  "tier-1":    32000,             // 32K cap
  "free":      8000,              // 8K cap
  "byok":      null,              // BYOK — uses model max, their key their limit
};

const ACTIVE_TIER = process.env.ILLUCI_TIER || "internal";

/**
 * Resolve the effective context limit for a model at the current tier.
 */
function resolveLimit(modelId) {
  const modelMax = MODEL_MAX_CONTEXT[modelId] || 8000;
  const tierCap = TIER_LIMITS[ACTIVE_TIER];
  if (tierCap === null || tierCap === undefined) return modelMax;
  return Math.min(modelMax, tierCap);
}

// ─── PER-FAMILY CHARACTER-TO-TOKEN RATIOS ───
// Used when bridges don't report real usage.
// Tuned from observed tokenizer behavior per family.

const CHARS_PER_TOKEN = {
  claude:   3.5,
  gpt:      4.0,
  gemini:   4.0,
  deepseek: 3.5,
  llama:    3.8,
  grok:     4.0,
  kimi:     3.5,
  qwen:     3.8,
};

// ─── MODEL → FAMILY MAPPING ───

const MODEL_FAMILY = {
  "claude-local": "claude",
  "codex-local":  "gpt",
  "deepseek":     "deepseek",
  "gpt-oss":      "gpt",
  "qwen-code":    "qwen",
  "gemini-local": "gemini",
  "grok":         "grok",
  "kimi-local":   "kimi",
  "ollama":       "qwen",
};

const TOKEN_OVERHEAD_PER_MESSAGE = 4;

// ─── PUBLIC API ───

/**
 * Get the usable context window for a model (tokens).
 * Resolves through: model max → tier cap → user preference.
 */
export function getContextLimit(modelId) {
  return resolveLimit(modelId);
}

/**
 * Estimate tokens for a text string.
 * Uses model-specific char/token ratio when modelId is provided,
 * falls back to family ratio or generic 3.8.
 *
 * @param {string} text
 * @param {string} [modelIdOrFamily] — model ID or family name
 * @returns {number}
 */
export function estimateTokens(text = "", modelIdOrFamily) {
  const family = MODEL_FAMILY[modelIdOrFamily] || modelIdOrFamily;
  const ratio = CHARS_PER_TOKEN[family] || 3.8;
  return Math.ceil(text.length / ratio);
}

/**
 * Estimate tokens for an array of messages.
 *
 * @param {Array<{content: string}>} messages
 * @param {string} [modelId]
 * @returns {number}
 */
export function estimateMessageTokens(messages, modelId) {
  return messages.reduce((sum, m) =>
    sum + estimateTokens(m.content || "", modelId) + TOKEN_OVERHEAD_PER_MESSAGE, 0);
}

/**
 * Check if text fits in a model's context window.
 *
 * @param {string} text
 * @param {string} modelId
 * @param {number} [reserved=0] — tokens already consumed
 * @returns {{ fits: boolean, used: number, limit: number, remaining: number }}
 */
export function fitsInContext(text, modelId, reserved = 0) {
  const limit = getContextLimit(modelId);
  const used = estimateTokens(text, modelId) + reserved;
  return { fits: used <= limit, used, limit, remaining: limit - used };
}

/**
 * Apply estimated usage to a result if the bridge didn't report real counts.
 * Does NOT overwrite real token counts from bridges.
 *
 * @param {object} result — bridge response
 * @param {string} inputText — the governed message sent to the bridge
 * @param {string} modelId — model that produced the result
 * @returns {object} result with usage filled in
 */
export function applyEstimatedUsage(result, inputText, modelId) {
  const usage = result?.usage || {};
  if ((usage.total_tokens || 0) > 0) return result;

  const promptTokens = estimateTokens(inputText, modelId);
  const completionTokens = estimateTokens(result?.response || "", modelId);

  return {
    ...result,
    usage: {
      ...usage,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated: true,
    },
  };
}

export default {
  getContextLimit,
  estimateTokens,
  estimateMessageTokens,
  fitsInContext,
  applyEstimatedUsage,
  MODEL_MAX_CONTEXT,
  TIER_LIMITS,
  CHARS_PER_TOKEN,
};
