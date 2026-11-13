/**
 * illuci — Build Preset
 *
 * Full 8-model lineup using the dev-team topology.
 * Every available model has a seat.
 *
 *   Architect:    claude-local  (design, long-context reasoning)
 *   Implementer:  codex-local, kimi-local  (code generation — two models, concurrent)
 *   Reviewer:     deepseek, gemini-local, grok  (code review — three models, concurrent)
 *   QA:           ollama        (fast local validation, uncensored)
 */

export const CDC_TOPOLOGY = "dev-team";

export const CDC_DEFAULT_LINEUP = {
  architect: "claude-local",
  implementer: ["codex-local", "kimi-local"],
  reviewer: ["deepseek", "gemini-local", "grok"],
  qa: "ollama",
};

/**
 * Build a dev-team lineup with optional overrides.
 * @param {object} overrides — { seat: modelId } to override defaults
 */
export function cdcLineup(overrides = {}) {
  return { ...CDC_DEFAULT_LINEUP, ...overrides };
}

export default { CDC_TOPOLOGY, CDC_DEFAULT_LINEUP, cdcLineup };
