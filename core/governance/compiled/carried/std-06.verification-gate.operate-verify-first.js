// Explicit adopted carried-policy adapter. See ../adoption/ground-zero-source.json.
// Source obligation: std-06.verification-gate.operate-verify-first
export const OBLIGATION_ID = "std-06.verification-gate.operate-verify-first";
export const TIER = "carried";
export const TRIGGER = "session-init";
// The constraint carried into agent operating context.
export const PREAMBLE = "Verify the selected outcome at its actual receiving boundary. Select checks from the claim, changed inputs, affected contracts, dependencies and remaining uncertainty. Reuse applicable evidence with provenance; a new commit or publication alone does not invalidate it. Distinguish failed, incomplete, skipped and unavailable results. Continue delivery once sufficient evidence resolves the selected question.";

export default { OBLIGATION_ID, TIER, TRIGGER, PREAMBLE };
