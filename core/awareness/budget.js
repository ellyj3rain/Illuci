// Phase 3 — the awareness-digest budget.
//
// The cross-team digest rides EVERY dispatch and scales with the number of
// concurrent topologies, so it must be bounded. But a flat constant (the rejected
// 12 events / 800 tokens) wastes a frontier model's window and starves cross-team
// awareness on capable models. This is the colosseum-crowned "Synthesis S1 —
// Adaptive Context-Tier Digest Budget": the budget is a tier-weighted fraction of
// the seat model's real context window, clamped to a floor and ceiling; the event
// count derives from the token budget. Deterministic, one tuning surface, no model
// call. (Budget battle, 2026-06-17, newest fleet models.)
//
//   budgetTokens = clamp(round(contextWindow * baseFraction * potencyMult), floor, ceiling)
//   maxEvents    = max(1, floor(budgetTokens / perEventTokenCeiling))
//
// Numbers on illuci's real fleet: frontier 1M -> 16,384 tok / 42 events; Claude 200k ->
// 6,000 / 15; mid 256k -> 3,840 / 10 (high 5,760 / 15); cloud 128k high -> 2,880 / 7;
// small 32k local -> floored to 384 / 1. floor == perEventTokenCeiling by design, so
// the minimum budget buys exactly one full-size entry, no wasted remainder.

import { getCapabilities } from "../bridges/capabilities.js";
import { getEntry } from "../bridges/model-registry.js";

export const AWARENESS_BUDGET = Object.freeze({
  baseFraction: 0.015, // 1.5% of the seat model context window
  tierMult: Object.freeze({ top: 2.0, high: 1.5, mid: 1.0, low: 0.5 }),
  floorTokens: 384,
  ceilingTokens: 16384,
  perEventTokenCeiling: 384,
  fallbackContextWindow: 8192, // capabilities.js has no datum for an unknown id
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** Cheap token estimate (chars/4) — monotonic, no model call. */
export function estTokens(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Fold the model-registry tier + capabilities reasoning + context window onto one
 * potency band. The ctx>=512k high-reasoning promotion catches a 1M-window model
 * (e.g. Gemini) that carries reasoning "high" but no tier "frontier", so it is not
 * down-bucketed to "mid" and starved.
 */
export function resolvePotency({ tier = "", reasoning = "", contextWindow = 0 } = {}) {
  const t = String(tier).toLowerCase();
  const r = String(reasoning).toLowerCase();
  const ctx = contextWindow || 0;
  if (t === "frontier" || r === "xhigh" || r === "frontier") return "top";
  if ((t === "high" || t === "xhigh" || r === "high") && ctx >= 512000) return "top";
  if (t === "high" || t === "xhigh" || r === "high") return "high";
  if (t === "fast" || r === "low" || r === "none") return "low";
  return "mid";
}

/**
 * The S1 adaptive context-tier digest budget for a seat model id.
 * @param {string} modelId
 * @returns {{ maxTokens:number, maxEvents:number, perEventTokenCeiling:number, potency:string, contextWindow:number }}
 */
export function computeAwarenessBudget(modelId) {
  let caps = null;
  let entry = null;
  try { caps = getCapabilities(modelId); } catch { /* unknown id — fall through */ }
  try { entry = getEntry(modelId); } catch { /* unknown id — fall through */ }

  const contextWindow = caps?.contextWindow > 0 ? caps.contextWindow : AWARENESS_BUDGET.fallbackContextWindow;
  const potency = resolvePotency({
    tier: entry?.tier || "",
    reasoning: caps?.reasoningDefault || entry?.reasoning || "",
    contextWindow,
  });
  const mult = AWARENESS_BUDGET.tierMult[potency] ?? 1.0;
  const raw = Math.round(contextWindow * AWARENESS_BUDGET.baseFraction * mult);
  const maxTokens = clamp(raw, AWARENESS_BUDGET.floorTokens, AWARENESS_BUDGET.ceilingTokens);
  return {
    maxTokens,
    maxEvents: Math.max(1, Math.floor(maxTokens / AWARENESS_BUDGET.perEventTokenCeiling)),
    perEventTokenCeiling: AWARENESS_BUDGET.perEventTokenCeiling,
    potency,
    contextWindow,
  };
}

export default { AWARENESS_BUDGET, estTokens, resolvePotency, computeAwarenessBudget };
