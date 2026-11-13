/**
 * illuci — Role Governance · Role Registry
 *
 * The current governance role namespace is the model-routing compatibility
 * role set: the role ids that capability-matrix.js getRoles() derives from
 * the matrix projection (implementer, reviewer, arbiter, attacker-blackbox, ...).
 * Role, specialist, skill-framework and permission-boundary implementations live
 * under core/roles/ and core/roles/skill-frameworks/. This registry projects the
 * model-routing role set from the current capability matrix.
 *
 * This module adds the thin, pure registry helpers Phase 1 needs:
 *   - ROLE_ALIASES        - operator-friendly synonyms -> a canonical role id.
 *   - ROLE_VALID_TOPOLOGIES - per-role topology allow-list (Phase 1 seed: empty;
 *                           a null entry, or an absent entry, means "valid
 *                           everywhere" so nothing is constrained yet).
 *   - resolveRoleId / isKnownRoleId / isRoleValidForTopology / listRoleIds.
 *
 * It owns aliases and topology validity; the matrix owns the projected role
 * capability data.
 *
 * @module core/roles/role-registry
 */

import { getRoles } from "../matrix/capability-matrix.js";
import { isRuntimeRole } from "./runtime-roles.js";

/**
 * Operator-friendly synonyms mapped to a canonical matrix role id. The values
 * MUST each resolve to a real id in getRoles() (verified lazily at resolve
 * time — an alias pointing at a non-existent role simply fails isKnownRoleId).
 *
 * attacker / red-team → attacker-blackbox: the offensive recon entrypoint role
 * that exists on grok and deepseek in the matrix.
 * builder / coder → implementer: the canonical implementation role.
 */
export const ROLE_ALIASES = Object.freeze({
  attacker: "attacker-blackbox",
  "red-team": "attacker-blackbox",
  redteam: "attacker-blackbox",
  builder: "implementer",
  coder: "implementer",
  developer: "implementer",
  reviewer: "reviewer", // identity alias kept explicit for symmetry/legibility
});

/**
 * Per-role topology allow-list. Phase 1 ships this seed-only (empty): a role
 * with NO entry, or an entry of `null`, is valid in EVERY topology. A future
 * phase may populate a role with an explicit array to constrain it. Frozen so
 * the seed cannot be mutated at runtime.
 *
 * @type {Readonly<Record<string, string[]|null>>}
 */
export const ROLE_VALID_TOPOLOGIES = Object.freeze({
  // Seed-only for Phase 1. Example of the future shape (kept commented so the
  // contract is legible without arming any constraint):
  //   "attacker-blackbox": ["honeypot", "panopticon", "censorate"],
});

/**
 * Resolve a role input (canonical id OR alias) to its canonical matrix role id.
 * Returns null for an unknown input — never throws, never invents an id.
 *
 * @param {string} input
 * @returns {string|null} canonical role id, or null if unresolvable/unknown
 */
export function resolveRoleId(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Direct canonical hit takes precedence over an alias of the same spelling.
  if (isKnownRoleId(trimmed)) return trimmed;

  const aliased = ROLE_ALIASES[trimmed] || ROLE_ALIASES[trimmed.toLowerCase()];
  if (aliased && isKnownRoleId(aliased)) return aliased;

  // Runtime overlay (additive): a created runtime role resolves AFTER the frozen
  // canon + aliases — it never shadows a canonical id.
  if (isRuntimeRole(trimmed)) return trimmed;

  return null;
}

/**
 * Is this an exact canonical matrix role id (from getRoles())?
 *
 * @param {string} roleId
 * @returns {boolean}
 */
export function isKnownRoleId(roleId) {
  if (typeof roleId !== "string" || roleId === "") return false;
  return getRoles().includes(roleId);
}

/**
 * Is a role valid for a topology under the Phase-1 allow-list?
 *
 * Rules:
 *   - An unknown role is never valid (resolve/validate at the boundary first).
 *   - A role with no ROLE_VALID_TOPOLOGIES entry, or a `null` entry, is valid
 *     everywhere (the Phase-1 default — nothing is constrained yet).
 *   - A role with an array entry is valid only for topologies in that array.
 *
 * Accepts a canonical id or an alias for `roleId` (it resolves first).
 *
 * @param {string} roleId — canonical id or alias
 * @param {string} topologyId
 * @returns {boolean}
 */
export function isRoleValidForTopology(roleId, topologyId) {
  const canonical = resolveRoleId(roleId);
  if (canonical === null) return false;

  const allow = ROLE_VALID_TOPOLOGIES[canonical];
  if (allow === undefined || allow === null) return true; // valid everywhere
  return Array.isArray(allow) && allow.includes(topologyId);
}

/**
 * The canonical role id list (matrix namespace). Thin pass-through to getRoles()
 * so callers have a single import surface for "all governance roles".
 *
 * @returns {string[]}
 */
export function listRoleIds() {
  return getRoles();
}

export default {
  ROLE_ALIASES,
  ROLE_VALID_TOPOLOGIES,
  resolveRoleId,
  isKnownRoleId,
  isRoleValidForTopology,
  listRoleIds,
};
