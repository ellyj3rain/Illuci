/**
 * illuci — The universal reasoning DIAL (one vocabulary, one place).
 *
 * Champion design "A-universal-dial" (colosseum, 2026-06-17): the operator sets
 * ONE dial (options.reasoning), the adaptive fallback ladder steps THAT SAME
 * field per attempt (dispatch/adaptive-fallback.js:91 — `{ ...merged, reasoning:
 * tier }`), and every reasoning-capable bridge reads THAT SAME field at
 * body-build time. Because the dial the operator sets, the field the ladder
 * steps, and the field the bridges read are one variable, the xhigh->high->medium
 * step-down toward reasoningFloor is honored by construction with zero desync.
 *
 * This module is the ONE place the dial vocabulary + the per-provider knob shapes
 * live, so a bridge never re-encodes the dial (the inconsistency the retired
 * per-provider map existed to abolish, now centralized here instead of scattered).
 *
 * Pure data + pure functions. Imports nothing from the bridge graph, so every
 * bridge may import it without cycles.
 */

/** The universal dial positions, ascending compute posture. Mirrors
 *  model-registry.js REASONING_DIAL (kept local so a bridge needs only this
 *  module, never the registry, to translate).
 *  [A110] `minimal` promoted to a REAL position (previously an alias clamped
 *  to `low`): the adaptive ladder already emitted it as a distinct step, and
 *  the observed Codex model catalog distinguishes it from low. Available
 *  levels depend on the selected model and client. */
export const DIAL_POSITIONS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Clamp any value to a known dial position (lowercased), else null.
 *
 * Returns null for:
 *  - unset / empty (undefined, null, "")
 *  - legacy claude capability-tier words (frontier / balanced / fast) and any
 *    other non-dial token — so a CLI-variant default like reasoning:"frontier"
 *    degrades to a no-op exactly as today rather than leaking a bogus knob.
 *
 * The adaptive ladder only ever emits real dial tiers (low..max), so a stepped
 * value always normalizes cleanly; a null is the explicit "no reasoning knob"
 * signal a bridge keys its capability-aware omission on.
 */
// Non-dial tokens that map to a nearest dial position so an explicit request degrades
// predictably instead of vanishing to null. The universal dial maps ultra to
// max; the Codex mapper preserves an explicit ultra request as a distinct value.
const DIAL_ALIASES = Object.freeze({ none: "off", ultra: "max" });
export function normalizeDial(value) {
  if (value == null || value === "") return null;
  const pos = String(value).trim().toLowerCase();
  if (pos in DIAL_ALIASES) return DIAL_ALIASES[pos];
  return DIAL_POSITIONS.includes(pos) ? pos : null;
}

// ── per-shape mappers (the only places dial -> provider knob is encoded) ──

/** OpenAI-compatible `reasoning_effort` enum (xAI grok-api, generic effort).
 *  The accepted set is {low, medium, high} plus xAI's extended {xhigh, max};
 *  "off" yields null (caller omits the knob). Unknown -> null. */
const EFFORT_ACCEPTED = new Set(["low", "medium", "high", "xhigh", "max"]);
export function toEffort(dial) {
  const d = normalizeDial(dial);
  if (!d || d === "off") return null;
  // `minimal` is a real dial position since [A110]; this shape has no minimal
  // tier, so it clamps to `low` (the prior alias behavior, now shape-local).
  if (d === "minimal") return "low";
  return EFFORT_ACCEPTED.has(d) ? d : null;
}

/** Codex `modelReasoningEffort` mapping preserves max and ultra as distinct
 *  requested settings; model and client capability still need qualification.
 *  "off"/unset yield null — the bridge falls to its own default. */
const CODEX_EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export function toCodexEffort(dial) {
  if (typeof dial === "string" && dial.trim().toLowerCase() === "ultra") return "ultra";
  const d = normalizeDial(dial);
  if (!d || d === "off") return null;
  return CODEX_EFFORTS.includes(d) ? d : null;
}

// NOTE: claude-api reasoning is the modern `output_config.effort` control (dial 1:1 to
// the effort enum via toEffort), NOT a token budget — the legacy
// `thinking:{type:"enabled",budget_tokens}` shape 400s on Opus 4.7/4.8. So there is no
// dial->token-budget mapper here by design.

/**
 * Gemini thinking is on/off only (we deliberately do NOT fabricate per-tier
 * token budgets — the model sizes its own when on). Returns:
 *   - false for the "off" dial  -> caller sets thinkingBudget 0
 *   - true  for any active dial -> caller sets thinkingBudget -1 (dynamic)
 *   - null  for an unset/unknown dial -> caller emits no thinkingConfig
 */
export function toGeminiThinking(dial) {
  const d = normalizeDial(dial);
  if (!d) return null;
  return d !== "off";
}

/**
 * Ollama native /api/chat `think` is a boolean: on for any active dial, off for
 * the "off" dial, null when no dial is set (caller leaves think unset so the
 * model/server default rules). Mirrors toGeminiThinking's on/off policy.
 */
export function toOllamaThink(dial) {
  const d = normalizeDial(dial);
  if (!d) return null;
  return d !== "off";
}

export default {
  DIAL_POSITIONS,
  normalizeDial,
  toEffort,
  toCodexEffort,
  toGeminiThinking,
  toOllamaThink,
};
