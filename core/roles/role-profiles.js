/**
 * illuci — Role Governance · Role Profiles
 *
 * A role profile is the per-(matrix)-role governance overlay. It is SUBTRACTIVE
 * BY CONSTRUCTION: a role may only REMOVE actions from the topology's permission
 * ceiling, NEVER add. There is no field by which a profile can widen the ceiling
 * — applySubtractiveModifier only ever filters the base set down. This is the
 * darwinian-culled invariant ("a role-modifier that WIDENS the ceiling" was a
 * fictional claim that is structurally impossible here).
 *
 * Each profile is keyed by a CANONICAL MATRIX role id (the role-registry /
 * capability-matrix namespace) and carries:
 *   - tightenActions?: string[]  — actions this role REMOVES from the ceiling.
 *   - requireGateFor?: string[]  — actions this role forces through the gate even
 *                                  if the ceiling would auto-approve (carried for
 *                                  a later phase; Phase 1 does not yet consume it).
 *   - skillBundleRoleId?: string|null — the bridge to skill-registry ROLES (the
 *                                  DIFFERENT namespace: senior-engineer,
 *                                  lead-architect, …). build-role-context.js uses
 *                                  this to pull the role's skill bundle. null /
 *                                  absent → no skill bundle for this role.
 *   - skillFrameworkRefs?: string[] - graph-native skill-framework refs. These
 *                                  resolve through core/roles/skill-frameworks
 *                                  and may contribute skill ids plus boundary refs.
 *   - permissionBoundaryRefs?: string[] - explicit role boundary refs for audit.
 *
 * @module core/roles/role-profiles
 */

import { getRuntimeRole } from "./runtime-roles.js";

/**
 * @typedef {object} RoleProfile
 * @property {string[]} [tightenActions]   actions REMOVED from the topology ceiling
 * @property {string[]} [requireGateFor]   actions forced through the gate (Phase-2 consumer)
 * @property {string|null} [skillBundleRoleId] bridge to a skill-registry ROLES id
 * @property {string[]} [skillFrameworkRefs] graph-native skill-framework refs
 * @property {string[]} [permissionBoundaryRefs] explicit role boundary refs
 */

/**
 * Profiles keyed by canonical matrix role id. The skillBundleRoleId values map
 * onto skill-registry.js ROLES (senior-engineer, lead-architect,
 * security-engineer, tech-lead). Roles without a skill bundle leave it null.
 *
 * @type {Readonly<Record<string, RoleProfile>>}
 */
export const ROLE_PROFILES = Object.freeze({
  // Implementation role — full skill bundle, no tightening (it gets the ceiling).
  implementer: Object.freeze({
    tightenActions: [],
    requireGateFor: [],
    skillBundleRoleId: "senior-engineer",
  }),

  // Review role — read/verify posture: it removes write/commit authoring from
  // whatever ceiling the topology grants. Subtractive demonstration that is also
  // a sensible default (a reviewer should not author).
  reviewer: Object.freeze({
    tightenActions: ["file_write", "file_edit", "git_add", "git_commit"],
    requireGateFor: [],
    skillBundleRoleId: "lead-architect",
    skillFrameworkRefs: ["gitops-review"],
    permissionBoundaryRefs: ["gitops-read", "gitops-verify"],
  }),

  // Architecture role — designs, does not author production code.
  architect: Object.freeze({
    tightenActions: ["file_write", "file_edit", "git_add", "git_commit"],
    requireGateFor: [],
    skillBundleRoleId: "lead-architect",
  }),

  // Offensive recon role — explicitly NO authoring/commit surface; force the
  // gate on shell execution. Bridges to the security skill bundle.
  "attacker-blackbox": Object.freeze({
    tightenActions: ["file_write", "file_edit", "git_add", "git_commit"],
    requireGateFor: ["shell_exec"],
    skillBundleRoleId: "security-engineer",
  }),

  // Coordination role — tech-lead skill bundle, no tightening.
  governor: Object.freeze({
    tightenActions: [],
    requireGateFor: [],
    skillBundleRoleId: "tech-lead",
    skillFrameworkRefs: ["gitops-review"],
    permissionBoundaryRefs: ["gitops-read", "gitops-verify"],
  }),
});

/** An empty profile — the default for any role without an explicit entry. */
const EMPTY_PROFILE = Object.freeze({
  tightenActions: Object.freeze([]),
  requireGateFor: Object.freeze([]),
  skillBundleRoleId: null,
  skillFrameworkRefs: Object.freeze([]),
  permissionBoundaryRefs: Object.freeze([]),
});

/**
 * Get the profile for a canonical matrix role id. Defaults to an empty profile
 * (no tightening, no gate-forcing, no skill bundle) for any unknown / unmapped
 * role — never throws, never invents.
 *
 * @param {string} roleId — canonical matrix role id
 * @returns {RoleProfile}
 */
export function getRoleProfile(roleId) {
  if (typeof roleId !== "string") return EMPTY_PROFILE;
  // Runtime overlay (additive): the frozen canon first, then a created runtime role.
  return ROLE_PROFILES[roleId] || getRuntimeRole(roleId) || EMPTY_PROFILE;
}

/**
 * Apply a role's SUBTRACTIVE modifier to a base action set: return baseActions
 * minus the role's tightenActions. Pure — does not mutate baseActions and never
 * ADDS an action (an action in tightenActions that is absent from baseActions is
 * a no-op; an action NOT in tightenActions is always preserved). The result is a
 * subset of baseActions by construction, so a profile can never widen a ceiling.
 *
 * @param {string[]} baseActions — the topology ceiling (PERMISSION_ACTIONS[level])
 * @param {string} roleId — canonical matrix role id
 * @returns {string[]} baseActions with the role's tightenActions removed
 */
export function applySubtractiveModifier(baseActions, roleId) {
  const base = Array.isArray(baseActions) ? baseActions : [];
  const profile = getRoleProfile(roleId);
  const tighten = Array.isArray(profile.tightenActions) ? profile.tightenActions : [];
  if (tighten.length === 0) return [...base];
  const remove = new Set(tighten);
  return base.filter((action) => !remove.has(action));
}

export default {
  ROLE_PROFILES,
  getRoleProfile,
  applySubtractiveModifier,
};
