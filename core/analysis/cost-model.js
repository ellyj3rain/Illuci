/**
 * illuci — Cost Model
 *
 * Per-model token rates for routing optimization and budget tracking.
 * Supports subscription, local, and API-billed model resources.
 *
 * Formation ruling R10: cost model prerequisite before formation optimization.
 */

// ─── PER-MODEL RATES (USD per 1K tokens) ───
// Rates as of April 2026. Subscription and local routes are represented as flat-rate.

const MODEL_RATES = {
  // Frontier — API-billed
  "claude-local": { input: 0.003, output: 0.015, billing: "subscription", note: "Anthropic subscription" },
  "codex-local":  { input: 0.002, output: 0.008, billing: "subscription", note: "OpenAI Plus subscription" },
  "gemini-local": { input: 0.000, output: 0.000, billing: "subscription", note: "Google AI Studio free tier" },
  "grok":         { input: 0.000, output: 0.000, billing: "subscription", note: "SuperGrok subscription" },
  "kimi-local":   { input: 0.000, output: 0.000, billing: "subscription", note: "Kimi free tier" },

  // Local/cloud Ollama routes
  "deepseek":     { input: 0.000, output: 0.000, billing: "local", note: "Ollama cloud route" },
  "gpt-oss":      { input: 0.000, output: 0.000, billing: "local", note: "Ollama cloud route" },
  "qwen-code":    { input: 0.000, output: 0.000, billing: "local", note: "Ollama cloud route" },
  "ollama":       { input: 0.000, output: 0.000, billing: "local", note: "Ollama local — free" },
};

/**
 * Get the rate card for a model.
 * @param {string} modelId
 * @returns {{ input: number, output: number, billing: string, note: string }}
 */
export function getRate(modelId) {
  return MODEL_RATES[modelId] || { input: 0, output: 0, billing: "unknown", note: "Unknown model" };
}

/**
 * Calculate the cost of a model call in USD.
 * Returns 0 for subscription and local models.
 *
 * @param {string} modelId
 * @param {{ prompt_tokens?: number, completion_tokens?: number }} usage
 * @returns {number} Cost in USD
 */
export function calculateCost(modelId, usage = {}) {
  const rate = getRate(modelId);
  if (rate.billing === "subscription" || rate.billing === "local") return 0;

  const inputCost = ((usage.prompt_tokens || 0) / 1000) * rate.input;
  const outputCost = ((usage.completion_tokens || 0) / 1000) * rate.output;
  return inputCost + outputCost;
}

/**
 * Calculate the cost of a full topology run from its trace.
 *
 * @param {object} trace — topology execution trace
 * @returns {{ total: number, byModel: object, byPhase: object }}
 */
export function calculateRunCost(trace) {
  const byModel = {};
  const byPhase = {};
  let total = 0;

  for (const [phaseId, phase] of Object.entries(trace.phases || {})) {
    let phaseCost = 0;

    for (const r of (phase.responses || [])) {
      if (!r.model || r.error) continue;
      const cost = calculateCost(r.model, r.usage || {});
      phaseCost += cost;
      byModel[r.model] = (byModel[r.model] || 0) + cost;
    }

    byPhase[phaseId] = phaseCost;
    total += phaseCost;
  }

  return { total, byModel, byPhase };
}

/**
 * Rank models by cost efficiency for a given role.
 * Cheaper models rank higher. Zero-cost models are always preferred.
 *
 * @param {string[]} modelIds — candidate models
 * @param {number} [estimatedTokens=1000] — expected token usage
 * @returns {Array<{ model: string, costPer1K: number, billing: string }>}
 */
export function rankByCost(modelIds, estimatedTokens = 1000) {
  return modelIds
    .map(id => {
      const rate = getRate(id);
      return {
        model: id,
        costPer1K: rate.input + rate.output,
        billing: rate.billing,
      };
    })
    .sort((a, b) => a.costPer1K - b.costPer1K);
}

export default {
  getRate,
  calculateCost,
  calculateRunCost,
  rankByCost,
  MODEL_RATES,
};
