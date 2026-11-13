// The universal reasoning DIAL — registry of pointers (champion "A-universal-dial", 2026-06-17).
//
// HISTORY: this file used to be a per-provider param INJECTOR. It translated the
// dial to a family-specific knob (effort / thinking+thinkingTier / think /
// reasoning_effort) and the runner spread that knob into the dispatch opts as a
// SECOND field alongside options.reasoning. The colosseum retired that design:
// the dial now rides ONLY as options.reasoning (the one field the operator sets,
// the adaptive fallback ladder steps — dispatch/adaptive-fallback.js:91 — and
// every reasoning-capable bridge reads), and each BRIDGE translates that live
// dial to its own provider knob at body-build time via illuci/core/reasoning/dial.js.
//
// WHY KEEP THIS FILE: applyReasoningParamMap stays a stable, callable export (the
// runner choke-point + the byte-identity contract tests still import it), and the
// file remains the single human-readable INDEX of "which dial position becomes
// which provider knob, and which bridge owns that translation" — so the knowledge
// is centralized here, not scattered across seven bridges. The behavior moved to
// the bridges; the doc-index stayed.
//
// ── dial -> provider knob, per family+transport (who owns the translation) ──
//
//   family / transport        provider knob (set by the bridge)        owner bridge        translator (dial.js)
//   ───────────────────────   ──────────────────────────────────────   ─────────────────   ────────────────────
//   claude / cli              (none — variant-only: opus/sonnet/haiku)  claude.js           — (dial degrades to no-op)
//   claude / api              output_config.effort (+adaptive thinking)  claude-api.js       toEffort   (effort-capability-gated)
//   grok   / api              body.reasoning_effort                     grok-api.js         toEffort   (capability-gated)
//   grok   / grok-build       --effort <tier>                           grok-cli.js         toEffort   (env+capability-gated)
//   gemini / api              generationConfig.thinkingConfig (on/off)  gemini-api.js       toGeminiThinking
//   gemini / local            (none — CLI default rules)                gemini.js           —
//   ollama-served (cloud)     top-level `think` (native /api/chat)      ollama.js           toOllamaThink
//   gpt    / openai           modelReasoningEffort                      codex.js            options.reasoning (pattern A, no-op edit)
//   kimi   / *                (none — variant-only)                     kimi.js             —
//
// A new reasoning-capable provider adds a row here AND reads options.reasoning in
// its bridge (via dial.js); it never re-injects a knob into the dispatch opts.

/**
 * Resolve the dial into { universalReasoning, bridgeOptions }.
 *
 * universalReasoning carries the dial straight through on options.reasoning (the
 * adaptive/logging path + the one field the bridges read). bridgeOptions is now
 * ALWAYS empty — the per-provider translation moved into the bridges, so the
 * runner no longer spreads a second knob into dispatch. The export stays callable
 * (and its empty bridgeOptions keeps the flat-id choke-point contract green) so
 * no importer breaks.
 *
 * @returns {{ universalReasoning: (string|undefined), bridgeOptions: {} }}
 */
export function applyReasoningParamMap(entry, params = {}) {
  const dial = params?.reasoning;
  if (dial == null || dial === "") return { universalReasoning: undefined, bridgeOptions: {} };
  return { universalReasoning: dial, bridgeOptions: {} };
}

export default { applyReasoningParamMap };
