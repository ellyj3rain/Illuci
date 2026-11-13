/**
 * illuci/core/mcp/permission-context.js — Phase 2: dynamic MCP-boundary exposure
 *
 * The DYNAMIC MCP-BOUNDARY EXPOSURE half of the unified governance architecture.
 * Phase 1 (bridges/tools.js, gates/approval-context.js) governs illuci's IN-PROCESS
 * tool execution by role. Phase 2 carries that same role-join OUT to the MCP
 * boundary: it makes the EXPOSED tool catalog (tools/list) and the dispatch path
 * (tools/call) honor a request's resolved seat — a seat sees only the tools its
 * effective permission entitles it to, and a call to an unentitled tool is denied
 * with CAPABILITY_DENIED BEFORE the handler runs.
 *
 * DEFENSE IN DEPTH (two independent layers):
 *   1. filterToolsByRoleContext — narrows the tools/list catalog to the permitted
 *      set (a seat never sees what it can't call).
 *   2. assertMcpToolExposed — re-checks at tools/call, independent of the list
 *      filter (a host that calls a name it never listed is still denied).
 *
 * BEHAVIOR-IDENTICAL-OFF: the FLAG IS READ AT CALL TIME (isRoleGovernanceEnabled).
 * With governance off, resolveRoleContext reports governanceEnabled:false and both
 * layers short-circuit — tools/list returns the FULL catalog and tools/call
 * dispatches exactly as before. No new module exists in the OFF path's behavior.
 *
 * PERMISSIVE-WHEN-NO-SEAT (default): with governance ARMED but no resolvable seat
 * on a request, the boundary stays permissive (full catalog, no denial), mirroring
 * Phase-1's bridges/tools.js "no roleId → allow" posture. Only ILLUCI_ROLE_GOVERNANCE_STRICT
 * flips that to deny-by-default (an empty effective permission).
 *
 * REAL MODEL ONLY (the darwinian culled the fictions):
 *   - effectivePermission is a string[] of allowed actions (build-role-context.js),
 *     NOT an object with .level/.allowedActions.
 *   - requiredActions are co-located on each tool def (getSchema(name).definition),
 *     drawn from the REAL PERMISSION_ACTIONS vocabulary — there is NO central
 *     requirements map.
 *   - a tool WITHOUT requiredActions is UNRESTRICTED (behavior-identical), not
 *     denied-by-default.
 *   - no-seat under non-strict governance is PERMISSIVE, not always-deny.
 *
 * @module core/mcp/permission-context
 */

import { isRoleGovernanceEnabled, isRoleGovernanceStrict } from "../roles/config.js";
import { resolveRoleId } from "../roles/role-registry.js";
import { buildRoleContext } from "../roles/build-role-context.js";
import { getSchema } from "./schema-registry.js";
import { DENIAL_CODES } from "../roles/denial-codes.js";

// ─────────────────────────────────────────────────────────────────────────
// SESSION → SEAT MAP
// ─────────────────────────────────────────────────────────────────────────
//
// An MCP host drives one (or more) sessions; a session may be bound to a seat
// (a role seated into a topology) by the operator-mediated dispatch layer. The
// map lets a tools/list or tools/call that carries only a sessionId resolve back
// to its seat. Module-level + process-scoped (single-operator-tenant, per the
// dispatch-tools.js scope note). Entries are canonicalized at set time; an
// unknown role is ignored (never invented).

/** @type {Map<string, { roleId: string, topologyId: string|null, seatId: string|null }>} */
const sessionSeatMap = new Map();

/**
 * Bind a session to a seat. The roleId is canonicalized via resolveRoleId; an
 * input that does not resolve to a known role is IGNORED (no entry written), so
 * the map never carries a fictional seat.
 *
 * @param {string} sessionId
 * @param {{ roleId: string, topologyId?: string|null, seatId?: string|null }} seat
 */
export function setSessionSeat(sessionId, { roleId, topologyId = null, seatId = null } = {}) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const canonical = resolveRoleId(roleId);
  if (!canonical) return; // unknown role — ignore, never invent
  sessionSeatMap.set(sessionId, { roleId: canonical, topologyId: topologyId ?? null, seatId: seatId ?? null });
}

/**
 * Forget a session's seat binding (e.g., session end / re-seat).
 *
 * @param {string} sessionId
 */
export function invalidateSessionPermission(sessionId) {
  if (typeof sessionId !== "string") return;
  sessionSeatMap.delete(sessionId);
}

/** Clear the entire session→seat map (test hermeticity / process reset). */
export function clearSessionSeatMap() {
  sessionSeatMap.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// SEAT + ROLE-CONTEXT RESOLUTION
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve the seat identity for a request context. A seat may be carried two
 * ways, in precedence order:
 *   1. ctx.roleId directly (canonicalized; ctx.topologyId / ctx.seatId ride along).
 *   2. ctx.sessionId looked up in the session→seat map.
 * Returns null when neither yields a known seat.
 *
 * @param {object} ctx
 * @returns {{ roleId: string, topologyId: string|null, seatId: string|null }|null}
 */
export function resolveSeatIdentity(ctx = {}) {
  if (ctx && typeof ctx === "object") {
    const direct = resolveRoleId(ctx.roleId);
    if (direct) {
      return {
        roleId: direct,
        topologyId: ctx.topologyId ?? null,
        seatId: ctx.seatId ?? null,
      };
    }
    if (typeof ctx.sessionId === "string" && sessionSeatMap.has(ctx.sessionId)) {
      return sessionSeatMap.get(ctx.sessionId);
    }
  }
  return null;
}

// resolveRoleContext caches its result per-ctx so the list filter + the call
// assert (two independent layers in one request) do not rebuild the same join.
// A WeakMap keyed by the ctx object is frozen-safe (no property written on ctx);
// the .set is itself guarded in case ctx is a non-extensible primitive holder.
const _roleCtxCache = new WeakMap();

/**
 * Resolve the role-context (the Phase-2 governance verdict surface) for a request.
 *
 * FLAG READ AT CALL TIME. Returns one of:
 *   - { governanceEnabled:false, effectivePermission:null }
 *       governance off → both layers short-circuit (behavior-identical-off).
 *   - { governanceEnabled:true, seat, caps, effectivePermission }
 *       a resolvable seat → the Phase-1 role-join (caps + a string[] permission).
 *   - { governanceEnabled:true, effectivePermission:[] }
 *       no seat + STRICT → deny-by-default (empty permission).
 *   - { governanceEnabled:true, effectivePermission:null, _permissiveNoSeat:true }
 *       no seat + non-strict → PERMISSIVE (mirrors Phase-1 no-roleId allow).
 *
 * @param {object} [ctx]
 * @returns {{ governanceEnabled: boolean, seat?: object, caps?: string[], effectivePermission: string[]|null, _permissiveNoSeat?: boolean }}
 */
export function resolveRoleContext(ctx = {}) {
  if (ctx && typeof ctx === "object" && _roleCtxCache.has(ctx)) {
    return _roleCtxCache.get(ctx);
  }

  let result;
  if (!isRoleGovernanceEnabled()) {
    result = { governanceEnabled: false, effectivePermission: null };
  } else {
    const seat = resolveSeatIdentity(ctx);
    if (seat) {
      const { caps, effectivePermission } = buildRoleContext({
        roleId: seat.roleId,
        topology: seat.topologyId,
      });
      result = { governanceEnabled: true, seat, caps, effectivePermission };
    } else if (isRoleGovernanceStrict()) {
      // No resolvable seat + strict → deny-by-default.
      result = { governanceEnabled: true, effectivePermission: [] };
    } else {
      // No resolvable seat + non-strict → permissive (Phase-1 parity).
      result = { governanceEnabled: true, effectivePermission: null, _permissiveNoSeat: true };
    }
  }

  if (ctx && typeof ctx === "object") {
    try {
      _roleCtxCache.set(ctx, result);
    } catch {
      // ctx not a valid WeakMap key (frozen primitives, etc.) — skip caching.
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// PER-TOOL REQUIRED ACTIONS + PERMISSION CHECK
// ─────────────────────────────────────────────────────────────────────────

/**
 * The required actions for a tool, read from the tool's CO-LOCATED definition
 * (getSchema(name).definition.requiredActions). Returns the array only when it is
 * a non-empty array; otherwise undefined (the tool is UNRESTRICTED). There is no
 * central requirements map — the single source is the tool def itself.
 *
 * @param {string} name — registered tool name
 * @returns {string[]|undefined}
 */
export function getToolRequiredActions(name) {
  const required = getSchema(name)?.definition?.requiredActions;
  return Array.isArray(required) && required.length > 0 ? required : undefined;
}

/**
 * Is a tool permitted under a resolved role-context?
 *
 *   - governance off            → true (every tool permitted; behavior-identical-off).
 *   - tool has no requiredActions → true (UNRESTRICTED — the read/compose resolvers).
 *   - effectivePermission null   → true (permissive no-seat; Phase-1 parity).
 *   - else                       → required.every(a => effectivePermission.includes(a)).
 *
 * @param {string} name — registered tool name
 * @param {object} roleCtx — from resolveRoleContext
 * @returns {boolean}
 */
export function isToolPermitted(name, roleCtx) {
  if (!roleCtx || !roleCtx.governanceEnabled) return true;

  const required = getToolRequiredActions(name);
  if (!required) return true; // unrestricted tool

  const effective = roleCtx.effectivePermission;
  if (effective === null || effective === undefined) return true; // permissive no-seat

  return required.every((action) => effective.includes(action));
}

/**
 * Filter a tools/list catalog down to the tools the role-context permits. With
 * governance off, the catalog is returned UNCHANGED (the full set). Each entry is
 * checked by name against its co-located requiredActions.
 *
 * @param {Array<{ name: string }>} tools
 * @param {object} roleCtx — from resolveRoleContext
 * @returns {Array<{ name: string }>}
 */
export function filterToolsByRoleContext(tools, roleCtx) {
  if (!Array.isArray(tools)) return tools;
  if (!roleCtx || !roleCtx.governanceEnabled) return tools;
  return tools.filter((tool) => isToolPermitted(tool && tool.name, roleCtx));
}

/**
 * Assert a tool may be exposed/called under a role-context, throwing a
 * CAPABILITY_DENIED-tagged Error when it may not. The error carries `.code`
 * (DENIAL_CODES.CAPABILITY_DENIED) so a consumer can machine-distinguish it from
 * the gate's PERMISSION_DENIED / the skill layer's SKILL_LICENSE_DENIED. The
 * tools/call seam uses this as its independent (defense-in-depth) check.
 *
 * @param {string} name — registered tool name
 * @param {object} roleCtx — from resolveRoleContext
 * @throws {Error & { code: string }} when the tool is not permitted
 */
export function assertMcpToolExposed(name, roleCtx) {
  if (isToolPermitted(name, roleCtx)) return;

  const required = getToolRequiredActions(name) || [];
  const seatLabel = roleCtx?.seat?.roleId ? `seat '${roleCtx.seat.roleId}'` : "this seat";
  const err = new Error(
    `${DENIAL_CODES.CAPABILITY_DENIED}: tool '${name}' is not exposed to ${seatLabel} — ` +
      `it requires [${required.join(", ")}] but the seat's effective permission does not grant them.`,
  );
  err.code = DENIAL_CODES.CAPABILITY_DENIED;
  err.tool = name;
  err.requiredActions = required;
  throw err;
}

export default {
  setSessionSeat,
  invalidateSessionPermission,
  clearSessionSeatMap,
  resolveSeatIdentity,
  resolveRoleContext,
  getToolRequiredActions,
  isToolPermitted,
  filterToolsByRoleContext,
  assertMcpToolExposed,
};
