/**
 * illuci — Role Governance · Barrel
 *
 * Phase 1 of the darwinian-hardened unified governance architecture: the
 * capability/permission role-join layer. Re-exports the module surface so a
 * consumer imports from one place (`core/roles`) rather than reaching into the
 * individual files.
 *
 * Everything here is DARK behind isRoleGovernanceEnabled() at the wiring sites
 * (bridges/tools.js, gates/approval-context.js). With the flag OFF the wired
 * guards short-circuit and runtime BEHAVIOR is identical to pre-Phase-1.
 *
 * @module core/roles
 */

export { isRoleGovernanceEnabled } from "./config.js";
export { DENIAL_CODES } from "./denial-codes.js";
export {
  ROLE_ALIASES,
  ROLE_VALID_TOPOLOGIES,
  resolveRoleId,
  isKnownRoleId,
  isRoleValidForTopology,
  listRoleIds,
} from "./role-registry.js";
export {
  ROLE_PROFILES,
  getRoleProfile,
  applySubtractiveModifier,
} from "./role-profiles.js";
export { buildRoleContext } from "./build-role-context.js";
export {
  specialistRoleId,
  listSpecialistRoleSlugs,
  deriveSpecialistRole,
  listSpecialistRoles,
  resolveSpecialistRole,
} from "./specialists/catalog.js";
export { getSpecialistRolePreamble } from "./specialists/preamble.js";
export {
  listSkillFrameworkIds,
  getSkillFrameworkGraph,
  validateSkillFrameworkGraph,
  skillAtomsForFrameworkRef,
  permissionControlsForFrameworkRef,
  toolChannelControlsForFrameworkRef,
  skillIdsForFrameworkRef,
  skillIdsForFrameworkRefs,
  permissionBoundaryRefsForFrameworkRef,
  permissionBoundaryRefsForFrameworkRefs,
  resolveSkillFramework,
  resolveSkillFrameworkUse,
} from "./skill-frameworks/catalog.js";
