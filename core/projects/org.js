/**
 * illuci — Standing Org (tier 2: the per-project organization)
 *
 * M5 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3 tier 2,
 * §5 memory strata). The standing org is the semi-fixed organizational layer
 * between the charter (fixed) and the per-request agenda (dynamic): which
 * charter this project runs, who sits where, the personas they wear, the
 * fire-control overrides, the anchor binding, and the SESSION KIND policy
 * (fixed | dynamic — which fixity tiers may move mid-session).
 *
 * Personas key on agentSlug, NEVER modelId — a model-seat hotswap preserves
 * identity and accrued memory (ratified). Skills ride the persona binding as
 * data: the skill framework's first lived slot (enforcement at the gate is
 * M6; here they are declared and carried).
 *
 * Storage: `<projectDir>/.illuci/org.json` — the established per-project
 * config home (projects/manager.js). File-based JSON deliberately: the sqlite
 * stores are F-016 landmines (better-sqlite3 static imports crash where the
 * native addon is absent); this module imports none of them.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveProjectConfigDir, resolveProjectConfigFile } from "./config-dir.js";

const ORG_FILE = "org.json";

export const SESSION_KINDS = Object.freeze(["fixed", "dynamic"]);
export const ANCHOR_MODES = Object.freeze(["operator", "delegated"]);

/** Build a new standing org (validated shape, not yet saved). */
export function createOrg({
  charterId,
  kind = "fixed",
  lineup = {},
  agents = {},
  seatAgents = {},
  personas = {},
  fireControl = {},
  anchor = { mode: "operator" },
} = {}) {
  if (!charterId) throw new Error("createOrg: charterId is required");
  return { charterId, kind, lineup, agents, seatAgents, personas, fireControl, anchor, updatedAt: new Date().toISOString() };
}

/**
 * Validate an org against its charter (topology). Structural only — model
 * availability is the capability spine's concern at seat time.
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateOrg(org, topology) {
  const errors = [];
  if (!org || typeof org !== "object") return { valid: false, errors: ["org is not an object"] };
  if (org.charterId !== topology.id) errors.push(`org.charterId "${org.charterId}" does not match charter "${topology.id}"`);
  if (!SESSION_KINDS.includes(org.kind)) errors.push(`org.kind "${org.kind}" invalid (fixed|dynamic)`);
  const seatIds = new Set((topology.seats || []).map((s) => s.id));
  for (const seatId of Object.keys(org.lineup || {})) {
    if (!seatIds.has(seatId)) errors.push(`lineup names unknown seat "${seatId}"`);
  }
  for (const [seatId, p] of Object.entries(org.personas || {})) {
    if (!seatIds.has(seatId)) errors.push(`personas bind unknown seat "${seatId}"`);
    if (p && !p.agentSlug) errors.push(`persona on seat "${seatId}" has no agentSlug (personas key on identity, never model)`);
    if (p && p.skills && !Array.isArray(p.skills)) errors.push(`persona on seat "${seatId}" skills must be an array`);
    // Additive, NON-required: a persona may carry a model-resource overlay (a selection
    // string like "claude.sonnet.medium" or an object {family,...}|{id,...}). Absent by
    // default; when present it must be a string or object (the selection shapes select()
    // accepts). Personas still key on agentSlug — this never perturbs identity binding.
    if (p && p.modelResource != null && typeof p.modelResource !== "string" && typeof p.modelResource !== "object") {
      errors.push(`persona on seat "${seatId}" modelResource must be a selection string or object`);
    }
  }
  for (const [agentId, agent] of Object.entries(org.agents || {})) {
    if (!agent || typeof agent !== "object") {
      errors.push(`agent "${agentId}" must be an object`);
      continue;
    }
    if (agent.agentSlug != null && typeof agent.agentSlug !== "string") errors.push(`agent "${agentId}" agentSlug must be a string`);
    if (agent.skills != null && !Array.isArray(agent.skills)) errors.push(`agent "${agentId}" skills must be an array`);
    if (agent.modelResource != null && typeof agent.modelResource !== "string" && typeof agent.modelResource !== "object") {
      errors.push(`agent "${agentId}" modelResource must be a selection string or object`);
    }
  }
  for (const [seatId, refs] of Object.entries(org.seatAgents || {})) {
    if (!seatIds.has(seatId)) errors.push(`seatAgents bind unknown seat "${seatId}"`);
    for (const ref of (Array.isArray(refs) ? refs : [refs])) {
      if (typeof ref === "string" && org.agents && Object.keys(org.agents).length && !org.agents[ref]) {
        errors.push(`seatAgents on seat "${seatId}" reference unknown agent "${ref}"`);
      }
      if (ref != null && typeof ref !== "string" && typeof ref !== "object") {
        errors.push(`seatAgents on seat "${seatId}" must be agent ids or objects`);
      }
    }
  }
  if (org.anchor && !ANCHOR_MODES.includes(org.anchor.mode)) {
    errors.push(`anchor.mode "${org.anchor.mode}" invalid (operator|delegated)`);
  }
  if (org.anchor?.mode === "delegated" && !org.anchor.modelId) {
    errors.push("anchor.mode 'delegated' requires an explicit modelId (DR-110 bounds)");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Extract a persona's model-resource overlay (the selection that, absent an explicit
 * caller lineup value, the runner uses to seat this persona's seat). Greenfield + additive:
 * a persona without `modelResource` returns null, so the runner's precedence ladder falls
 * through to the topology/org autofill default (every on-disk org.json is a no-op).
 *
 * Returns the selection (string like "claude.sonnet.medium" OR object {family,...}|{id,...})
 * or null when absent/empty. Validation of the selection's resolvability is the runner's
 * resolveSeatModel concern (it warns + falls back on an unresolvable value); here we only
 * read the field.
 *
 * @param {object|null} persona
 * @returns {string|object|null}
 */
export function extractPersonaModelResource(persona) {
  if (!persona) return null;
  const mr = persona.modelResource;
  if (mr == null) return null;
  if (typeof mr === "string") return mr.trim() ? mr : null;
  if (typeof mr === "object") return mr;
  return null;
}

export function extractAgentModelResource(agent) {
  return extractPersonaModelResource(agent);
}

/** Load the standing org for a project dir, or null when absent/unreadable. */
export function loadOrg(projectDir) {
  const path = resolveProjectConfigFile(projectDir, ORG_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Save the standing org (creates .illuci/ if needed). Returns the saved org. */
export function saveOrg(projectDir, org) {
  const dir = resolveProjectConfigDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const next = { ...org, updatedAt: new Date().toISOString() };
  writeFileSync(join(dir, ORG_FILE), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/**
 * SESSION-KIND POLICY (the fixity contract, ratified §5):
 * fixed   — tiers 1-2 pinned: the arrangement is locked; conducted replanning
 *           is NOT available (downgrades to derived, recorded); personas
 *           re-enter as last left.
 * dynamic — tiers 1-2 may move under fire-control; conducted allowed.
 *
 * @returns {{agendaMode: string, downgraded: boolean, reason: string|null}}
 */
export function applyKindPolicy(kind, requestedAgendaMode) {
  if (kind === "fixed" && requestedAgendaMode === "conducted") {
    return {
      agendaMode: "derived",
      downgraded: true,
      reason: "session kind 'fixed' pins the arrangement: conducted replanning downgraded to derived (recorded)",
    };
  }
  return { agendaMode: requestedAgendaMode, downgraded: false, reason: null };
}

export default { createOrg, validateOrg, loadOrg, saveOrg, applyKindPolicy, extractPersonaModelResource, extractAgentModelResource, SESSION_KINDS, ANCHOR_MODES };
