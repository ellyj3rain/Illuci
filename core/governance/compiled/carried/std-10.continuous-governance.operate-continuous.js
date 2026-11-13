// Explicit adopted carried-policy adapter. See ../adoption/ground-zero-source.json.
// Source obligation: std-10.continuous-governance.operate-continuous
export const OBLIGATION_ID = "std-10.continuous-governance.operate-continuous";
export const TIER = "carried";
export const TRIGGER = "session-init";
// The constraint carried into agent operating context.
export const PREAMBLE = "Use observations from development and operation to evaluate behavior and method. Connect sourced evidence to interpretation, an authorized correction and the observed next action. Compare the result with current intent and relevant earlier corrections. A logged finding or suggestion is not proof that behavior changed.";

export default { OBLIGATION_ID, TIER, TRIGGER, PREAMBLE };
