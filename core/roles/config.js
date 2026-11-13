/**
 * illuci — Role Governance · Config
 *
 * Dark-flag surface for the Phase-1 capability/permission role-join layer (the
 * "darwinian-hardened unified governance architecture", Phase 1). It mirrors
 * gates/classifier/config.js exactly: every reader reads process.env at CALL
 * TIME — never at import time — so a test (or a host) can flip the flag between
 * calls without re-importing, and the default is OFF (fail-safe-default).
 *
 * When OFF, every guard wired into the runtime (tools.js capability step,
 * approval-context role-tightening) short-circuits, so runtime BEHAVIOR is
 * identical to pre-role-governance behavior. (It is NOT byte-identical: the new
 * modules and their imports exist — the honesty is behavioral, not textual.)
 *
 * @module core/roles/config
 */

/**
 * Is role governance armed?
 *
 * Reads ILLUCI_ROLE_GOVERNANCE_ENABLED at call time. Default OFF (false). Only the
 * exact string "true" (case-insensitive, trimmed) arms it — any other value,
 * including "1", "yes", or empty, leaves it off.
 *
 * @returns {boolean}
 */
export function isRoleGovernanceEnabled() {
  const raw = process.env.ILLUCI_ROLE_GOVERNANCE_ENABLED;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}

/**
 * Is role governance STRICT (deny-by-default when no seat is resolvable)?
 *
 * Reads ILLUCI_ROLE_GOVERNANCE_STRICT at call time. Default OFF (false) — the
 * Phase-2 MCP-boundary exposure mirrors Phase-1's permissive-when-no-role
 * posture by default: with governance armed but no resolvable seat on a
 * request, the boundary stays permissive (the full tool catalog, no
 * CAPABILITY_DENIED) UNLESS this strict flag is set, which flips the no-seat
 * fallback to deny-by-default (an empty effective permission). Only the exact
 * string "true" (case-insensitive, trimmed) arms it — any other value leaves
 * it off. Independent of isRoleGovernanceEnabled (which gates whether
 * governance runs at all).
 *
 * @returns {boolean}
 */
export function isRoleGovernanceStrict() {
  const raw = process.env.ILLUCI_ROLE_GOVERNANCE_STRICT;
  if (typeof raw !== "string") return false;
  return raw.trim().toLowerCase() === "true";
}

export default { isRoleGovernanceEnabled, isRoleGovernanceStrict };
