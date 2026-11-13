/**
 * illuci — Role Governance · Denial Codes
 *
 * The governance layers that may refuse a tool call each had an
 * indistinguishable `{ allow:false }` / `{ approved:false }` / `{ decision:"deny" }`
 * shape with only a prose `reason`. Phase 1 introduces a single centralized
 * enum so denials are machine-distinguishable when tagged additively
 * onto the existing failure shapes (a new `code` field — never a replacement).
 *
 *   CAPABILITY_DENIED     — the role lacks the capability for the tool (NEW; the
 *                           tool-boundary capability check in bridges/tools.js).
 *   SKILL_LICENSE_DENIED  — no bound skill licenses the off-floor MCP bridge
 *                           (the DR-112 license check in skills/grants.js).
 *   PERMISSION_DENIED     — the permission level / approval context refuses the
 *                           action (the gate classifier's categorical/relational
 *                           veto in gates/classifier/).
 *   WORK_PERMIT_DENIED    — the agent's runtime work permit does not bind this
 *                           exact action, channel, capability, target, or risk.
 *
 * String values === keys, frozen, so a consumer may compare against either the
 * constant or the literal string without drift.
 *
 * @module core/roles/denial-codes
 */

export const DENIAL_CODES = Object.freeze({
  CAPABILITY_DENIED: "CAPABILITY_DENIED",
  SKILL_LICENSE_DENIED: "SKILL_LICENSE_DENIED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  WORK_PERMIT_DENIED: "WORK_PERMIT_DENIED",
});

export default { DENIAL_CODES };
