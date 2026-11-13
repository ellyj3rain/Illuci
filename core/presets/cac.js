/**
 * illuci — Validate Preset
 *
 * Default lineup for security assessment using the adversarial-debate topology.
 *
 *   Red Team:  deepseek      (offensive primary, zero TOS risk)
 *   Blue Team: claude-local  (defensive reasoning, governance)
 *   Arbiter:   gemini-local  (analytical, comparative assessment)
 */

export const CAC_TOPOLOGY = "adversarial-debate";

export const CAC_DEFAULT_LINEUP = {
  red: "deepseek",
  blue: "claude-local",
  arbiter: "gemini-local",
};

/**
 * Build an adversarial-review lineup with optional overrides.
 */
export function cacLineup(overrides = {}) {
  return { ...CAC_DEFAULT_LINEUP, ...overrides };
}

export default { CAC_TOPOLOGY, CAC_DEFAULT_LINEUP, cacLineup };
