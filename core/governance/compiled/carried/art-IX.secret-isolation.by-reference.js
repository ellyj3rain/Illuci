// Explicit carried-policy adapter from the selected Ground Zero source.
// Ground Zero owns the canonical provision; this project owns its runtime adaptation.
export const OBLIGATION_ID = "art-IX.secret-isolation.by-reference";
export const TIER = "carried";
export const TRIGGER = "session-init";
export const PREAMBLE = "Keep private data and credentials in their selected custody. Use references rather than embedding secret values in source, messages or artifacts. Check actual disclosure and effect boundaries; a name, path or digest is not permission.";
export default { OBLIGATION_ID, TIER, TRIGGER, PREAMBLE };
