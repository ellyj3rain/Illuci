/**
 * illuci — Role Governance · Build Role Context
 *
 * buildRoleContext({ roleId, topology }) is the role-join: it derives, for a
 * (matrix) role seated into a topology, BOTH halves the role assigns:
 *
 *   caps               — the role's capability surface: the skill ids from its
 *                        skill bundle (bridged matrix-role → skill-registry ROLES
 *                        via the profile's skillBundleRoleId) UNIONED with the
 *                        topology's skill overlay (findApplicableTo(topology)).
 *                        These are SKILL ids — the capability vocabulary the
 *                        Phase-1 tool-boundary check measures a tool against.
 *
 *   effectivePermission — the topology's permission ceiling
 *                        (PERMISSION_ACTIONS[TOPOLOGY_PERMISSIONS[topology]])
 *                        with the role's SUBTRACTIVE modifier applied. The role
 *                        ASSIGNS this; the gate classifier later only TIGHTENS
 *                        further — neither can widen the topology ceiling.
 *
 * Real APIs only (the darwinian culled the fictions):
 *   - TOPOLOGY_PERMISSIONS[topology] is a STRING level (e.g. "read-verify"),
 *     not an object with .level/.allowedActions.
 *   - TOPOLOGY_SKILLS is keyed by SKILL id; the topology overlay comes from
 *     findApplicableTo(topology), never TOPOLOGY_SKILLS[topology].
 *   - skill-registry ROLES is a DIFFERENT namespace; getSkill resolves a skill
 *     id → a skill OBJECT (so we .map(s => s.id) for ids).
 *
 * @module core/roles/build-role-context
 */

import { ROLES as SKILL_BUNDLE_ROLES, getSkill } from "../agents/skill-registry.js";
import { findApplicableTo } from "../skills/topology-skills.js";
import { PERMISSION_ACTIONS, TOPOLOGY_PERMISSIONS } from "../gates/approval-context.js";
import { getRoleProfile, applySubtractiveModifier } from "./role-profiles.js";
import {
  skillIdsForFrameworkRefs,
  permissionBoundaryRefsForFrameworkRefs,
  resolveSkillFrameworkUse,
} from "./skill-frameworks/catalog.js";

/**
 * Resolve a matrix role's skill-bundle capability ids via its profile bridge.
 * Returns [] when the role has no skillBundleRoleId, or the bridged id is not a
 * known skill-registry ROLE, or a listed skill id is unknown (defensive — never
 * throws out of context-building).
 *
 * @param {string} roleId — canonical matrix role id
 * @returns {string[]} skill ids from the bridged skill bundle
 */
function bundleSkillIds(roleId) {
  const profile = getRoleProfile(roleId);
  const bundleRoleId = profile.skillBundleRoleId;
  if (!bundleRoleId) return [];

  const bundle = SKILL_BUNDLE_ROLES[bundleRoleId];
  if (!bundle || !Array.isArray(bundle.skills)) return [];

  const ids = [];
  for (const skillId of bundle.skills) {
    try {
      ids.push(getSkill(skillId).id);
    } catch {
      // Unknown skill id in the bundle — skip rather than throw.
    }
  }
  return ids;
}

/**
 * Resolve the topology's skill overlay as a list of skill ids. findApplicableTo
 * already returns skill ids; we normalize defensively in case an entry is an
 * object carrying an `.id`.
 *
 * @param {string} topology
 * @returns {string[]} skill ids applicable to the topology
 */
function topologyOverlaySkillIds(topology) {
  if (!topology) return [];
  const applicable = findApplicableTo(topology) || [];
  return applicable
    .map((s) => (typeof s === "string" ? s : s && s.id))
    .filter((id) => typeof id === "string");
}

function roleSkillFrameworkRefs(roleId) {
  const refs = getRoleProfile(roleId).skillFrameworkRefs;
  return Array.isArray(refs) ? refs.filter((id) => typeof id === "string" && id) : [];
}

function frameworkSkillIds(roleId) {
  const ids = skillIdsForFrameworkRefs(roleSkillFrameworkRefs(roleId));
  const resolved = [];
  for (const id of ids) {
    try {
      resolved.push(getSkill(id).id);
    } catch {
      // Unknown skill id in a framework graph - skip rather than throw.
    }
  }
  return resolved;
}

function rolePermissionBoundaryRefs(roleId) {
  const profile = getRoleProfile(roleId);
  const direct = Array.isArray(profile.permissionBoundaryRefs) ? profile.permissionBoundaryRefs : [];
  return [
    ...new Set([
      ...direct.filter((id) => typeof id === "string" && id),
      ...permissionBoundaryRefsForFrameworkRefs(roleSkillFrameworkRefs(roleId)),
    ]),
  ];
}

function roleSkillFrameworkUses(roleId) {
  return roleSkillFrameworkRefs(roleId).map((frameworkId) => resolveSkillFrameworkUse({ frameworkId, roleId }));
}

/**
 * Build the role-context for a seated role.
 *
 * @param {object} arg
 * @param {string} arg.roleId — canonical matrix role id (resolve aliases before here)
 * @param {string} [arg.topology] — topology id the role is seated into
 * @returns {{ caps: string[], effectivePermission: string[] }}
 */
export function buildRoleContext({ roleId, topology } = {}) {
  // ── caps: skill-bundle ids ∪ topology overlay ids (deduplicated) ──
  const caps = [
    ...new Set([
      ...bundleSkillIds(roleId),
      ...frameworkSkillIds(roleId),
      ...topologyOverlaySkillIds(topology),
    ]),
  ];

  // ── effectivePermission: topology ceiling minus the role's tightenActions ──
  const level = topology ? TOPOLOGY_PERMISSIONS[topology] : null;
  const ceiling = (level && PERMISSION_ACTIONS[level]) ? PERMISSION_ACTIONS[level] : [];
  const effectivePermission = applySubtractiveModifier(ceiling, roleId);

  return {
    caps,
    effectivePermission,
    skillFrameworkRefs: roleSkillFrameworkRefs(roleId),
    skillFrameworkUses: roleSkillFrameworkUses(roleId),
    permissionBoundaryRefs: rolePermissionBoundaryRefs(roleId),
  };
}

export default { buildRoleContext };
