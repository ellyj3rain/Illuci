/**
 * Illuci - role intent composition.
 *
 * The operator-facing role namespace is the capability/matrix role set
 * (implementer, reviewer, tester, ...). Disposition composition consumes the
 * skill-bundle role namespace (senior-engineer, lead-architect, ...).
 * This module is the explicit bridge between those namespaces.
 */

import { composeDisposition } from "../agents/composition.js";
import { ROLES as SKILL_BUNDLE_ROLES } from "../agents/skill-registry.js";
import { resolveRoleId } from "../roles/role-registry.js";
import { getRoleProfile } from "../roles/role-profiles.js";

function cleanRoleId(roleId) {
  if (typeof roleId !== "string") return null;
  const trimmed = roleId.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Resolve an operator role intent into the disposition-composer role namespace.
 *
 * Known matrix roles use role-profiles.js as the bridge. A known matrix role
 * without a skillBundleRoleId intentionally resolves to no composition role;
 * that means no skill-bundle pull is applied, not that the preset default role
 * should sneak back in. Unknown roles remain fail-loud by returning the original
 * id as the composition role, which composeDisposition will reject.
 */
export function resolveCompositionRole(roleId) {
  const requestedRoleId = cleanRoleId(roleId);
  if (!requestedRoleId) {
    return {
      requestedRoleId: null,
      matrixRoleId: null,
      compositionRoleId: null,
      source: "none",
    };
  }

  if (Object.prototype.hasOwnProperty.call(SKILL_BUNDLE_ROLES, requestedRoleId)) {
    return {
      requestedRoleId,
      matrixRoleId: null,
      compositionRoleId: requestedRoleId,
      source: "skill-bundle",
    };
  }

  const matrixRoleId = resolveRoleId(requestedRoleId);
  if (!matrixRoleId) {
    return {
      requestedRoleId,
      matrixRoleId: null,
      compositionRoleId: requestedRoleId,
      source: "unresolved",
    };
  }

  const compositionRoleId = getRoleProfile(matrixRoleId).skillBundleRoleId || null;
  return {
    requestedRoleId,
    matrixRoleId,
    compositionRoleId,
    source: compositionRoleId ? "matrix-profile" : "matrix-profile-unmapped",
  };
}

export function resolveCompositionRoleId(roleId) {
  return resolveCompositionRole(roleId).compositionRoleId;
}

export function composeDispositionForRoleIntent(presetId, requestedRoleId = null, skillIds = [], options = {}) {
  const role = resolveCompositionRole(requestedRoleId);
  const explicitRoleIntent = role.requestedRoleId !== null;
  // options passes composer options through (A80: options.genome — the resolved
  // persona-genome context); usePresetDefaults stays owned by the role intent.
  const composed = composeDisposition(presetId, role.compositionRoleId, skillIds, {
    ...options,
    usePresetDefaults: !explicitRoleIntent,
  });

  return { composed, role };
}
