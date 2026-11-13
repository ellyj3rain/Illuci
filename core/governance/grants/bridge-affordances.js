// core/governance/grants/bridge-affordances.js
//
// [A41] The DECLARED bridge-affordance registry — the DR-126 follow-up that
// completes R5. A bridge DECLARES which licensed capabilities its tools
// exercise; the declaration is COMMITTED AND REVIEWED here (never runtime- or
// server-self-declared — the spec's no-self-declared rule applies to bridges
// exactly as it does to models). Three states, three meanings:
//
//   declared with affordances  -> every tool of the bridge requires EVERY
//                                 declared capability (coarse on purpose: a
//                                 bridge mixing gated and harmless tools
//                                 should be split, not under-declared);
//   declared EMPTY ([])        -> reviewed and found to exercise NO licensed
//                                 capability (composition/governance verbs);
//   UNDECLARED                 -> R5 deny-default under the flipped floor: an
//                                 off-floor tool nobody reviewed does not run.
//                                 The name-pattern map remains only as a
//                                 labeling aid.
//
// Adding an entry = a reviewed source change citing DR-126 (like every
// registry under the trust root: allowed_signers, allowed_emails, the
// capability vocabulary).

export const BRIDGE_AFFORDANCES = Object.freeze({
  // No skill in the registry grants any MCP bridge today (verified [A41]);
  // the registry starts EMPTY-and-real. The first skill that grants a bridge
  // must land that bridge's declaration here in the same reviewed change —
  // the fail-closed forcing function, by construction.
});

/** Look up a bridge's declaration. */
export function resolveBridgeAffordances(bridgeId) {
  if (!bridgeId || !Object.hasOwn(BRIDGE_AFFORDANCES, bridgeId)) {
    return { declared: false, affordances: null };
  }
  return { declared: true, affordances: [...BRIDGE_AFFORDANCES[bridgeId]] };
}

export default { BRIDGE_AFFORDANCES, resolveBridgeAffordances };
