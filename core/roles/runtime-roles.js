/**
 * illuci/core/roles/runtime-roles.js — the writable runtime role-overlay store.
 *
 * A persisted, process-global overlay OVER the frozen canonical role system
 * (role-registry.js + role-profiles.js). Operator-ratified 2026-06-21 (via crucible):
 *   - ADDITIVE-ONLY: a runtime role is a NEW id. Resolution consults the frozen
 *     canon FIRST, then this overlay (role-registry.js / role-profiles.js do that),
 *     so the canon is never shadowed — createRuntimeRole REFUSES a canonical id.
 *   - SUBTRACTIVE INVARIANT preserved for free: a stored profile carries only the
 *     RoleProfile shape (tightenActions / requireGateFor / skillBundleRoleId /
 *     skillFrameworkRefs / permissionBoundaryRefs). There
 *     is no field by which it can WIDEN a ceiling, so a runtime role can only restrict
 *     — applySubtractiveModifier(role-profiles.js) filters the topology ceiling down.
 *   - PROCESS-GLOBAL, single-operator-tenant (like the session->seat map).
 *   - PERSISTED to a home .illuci leaf: ~/.illuci/roles/runtime-roles.json.
 *
 * Read by getRoleProfile (role-profiles.js) + resolveRoleId (role-registry.js) as the
 * overlay; written by the role.create write verb (the skill-framework's first write).
 *
 * @module core/roles/runtime-roles
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";
import { isKnownRoleId } from "./role-registry.js";

const STORE_FILE = resolveIlluciHomeDir("roles", "runtime-roles.json");

/** @type {{ roles: Record<string, { tightenActions: string[], requireGateFor: string[], skillBundleRoleId: string|null, skillFrameworkRefs?: string[], permissionBoundaryRefs?: string[] }> } | null} */
let cache = null;

/** Load the store (memoized). Missing / malformed file → an empty store, never throws. */
function load() {
  if (cache) return cache;
  if (!existsSync(STORE_FILE)) { cache = { roles: {} }; return cache; }
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    cache = parsed && typeof parsed === "object" && parsed.roles && typeof parsed.roles === "object"
      ? { roles: parsed.roles }
      : { roles: {} };
  } catch {
    cache = { roles: {} };
  }
  return cache;
}

function persist() {
  const store = load();
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/** Sanitize to a string[] of non-empty strings. */
function cleanStrings(input) {
  return Array.isArray(input) ? input.filter((a) => typeof a === "string" && a !== "") : [];
}

function cleanActions(input) {
  return cleanStrings(input);
}

/**
 * Create (or replace) a runtime role. The id must be a non-empty string that does
 * NOT collide with a canonical role (additive-only — never shadow the frozen canon).
 * The stored profile is SUBTRACTIVE BY CONSTRUCTION (RoleProfile shape only). Returns
 * the stored profile, or null when the id is invalid or canonical.
 *
 * @param {string} roleId
 * @param {{ tightenActions?: string[], requireGateFor?: string[], skillBundleRoleId?: string|null, skillFrameworkRefs?: string[], permissionBoundaryRefs?: string[] }} [spec]
 * @returns {{ tightenActions: string[], requireGateFor: string[], skillBundleRoleId: string|null }|null}
 */
export function createRuntimeRole(roleId, spec = {}) {
  if (typeof roleId !== "string") return null;
  const id = roleId.trim();
  if (id === "") return null;
  if (isKnownRoleId(id)) return null; // additive-only: never shadow a canonical role
  const profile = {
    tightenActions: cleanActions(spec.tightenActions),
    requireGateFor: cleanActions(spec.requireGateFor),
    skillBundleRoleId: typeof spec.skillBundleRoleId === "string" ? spec.skillBundleRoleId : null,
    skillFrameworkRefs: cleanStrings(spec.skillFrameworkRefs),
    permissionBoundaryRefs: cleanStrings(spec.permissionBoundaryRefs),
  };
  const store = load();
  store.roles[id] = profile;
  persist();
  return profile;
}

/** The runtime profile for a role id, or null if not a runtime role. */
export function getRuntimeRole(roleId) {
  if (typeof roleId !== "string") return null;
  return load().roles[roleId] || null;
}

/** Is this a runtime (overlay) role id? */
export function isRuntimeRole(roleId) {
  return getRuntimeRole(roleId) !== null;
}

/** All runtime role ids. */
export function listRuntimeRoles() {
  return Object.keys(load().roles);
}

/** Remove a runtime role (re-seat / test cleanup). Returns whether one was removed. */
export function removeRuntimeRole(roleId) {
  const store = load();
  if (store.roles[roleId]) { delete store.roles[roleId]; persist(); return true; }
  return false;
}

/**
 * Attach a skill bundle to an EXISTING runtime role (sets its skillBundleRoleId).
 * Runtime roles only — the frozen canon is immutable. Returns the updated profile,
 * or null when the id is not a runtime role.
 *
 * @param {string} roleId
 * @param {string|null} skillBundleRoleId
 * @returns {{ tightenActions: string[], requireGateFor: string[], skillBundleRoleId: string|null }|null}
 */
export function assignSkillBundle(roleId, skillBundleRoleId) {
  const store = load();
  const role = store.roles[roleId];
  if (!role) return null; // only runtime roles — never mutate the frozen canon
  role.skillBundleRoleId = typeof skillBundleRoleId === "string" ? skillBundleRoleId : null;
  persist();
  return role;
}

/**
 * Attach skill-framework refs to an EXISTING runtime role. Runtime roles only.
 *
 * @param {string} roleId
 * @param {string[]} skillFrameworkRefs
 * @returns {{ tightenActions: string[], requireGateFor: string[], skillBundleRoleId: string|null, skillFrameworkRefs?: string[], permissionBoundaryRefs?: string[] }|null}
 */
export function assignSkillFrameworks(roleId, skillFrameworkRefs) {
  const store = load();
  const role = store.roles[roleId];
  if (!role) return null;
  role.skillFrameworkRefs = cleanStrings(skillFrameworkRefs);
  persist();
  return role;
}

/**
 * Set the dynamic permission boundary on an EXISTING runtime role: its tightenActions
 * (subtractive — only ever REMOVES from the topology ceiling) and requireGateFor.
 * Runtime roles only — the frozen canon is immutable. Returns the updated profile, or
 * null when the id is not a runtime role.
 *
 * @param {string} roleId
 * @param {{ tightenActions?: string[], requireGateFor?: string[], permissionBoundaryRefs?: string[] }} [boundary]
 * @returns {{ tightenActions: string[], requireGateFor: string[], skillBundleRoleId: string|null }|null}
 */
export function setBoundary(roleId, { tightenActions, requireGateFor, permissionBoundaryRefs } = {}) {
  const store = load();
  const role = store.roles[roleId];
  if (!role) return null; // only runtime roles - never mutate the frozen canon
  if (Array.isArray(tightenActions)) role.tightenActions = cleanActions(tightenActions);
  if (Array.isArray(requireGateFor)) role.requireGateFor = cleanActions(requireGateFor);
  if (Array.isArray(permissionBoundaryRefs)) role.permissionBoundaryRefs = cleanStrings(permissionBoundaryRefs);
  persist();
  return role;
}

/** Drop the in-memory cache so the next read re-loads from disk (test hermeticity). */
export function _resetRuntimeRolesCache() { cache = null; }

export default { createRuntimeRole, getRuntimeRole, isRuntimeRole, listRuntimeRoles, removeRuntimeRole, assignSkillBundle, assignSkillFrameworks, setBoundary };
