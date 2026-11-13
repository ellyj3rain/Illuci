/**
 * Illuci - model delegation composer.
 *
 * Resolves empty topology seats into model selections without overriding explicit
 * operator or org lineup pins. This is the model/delegation seam above the raw
 * capability matrix: it can prefer the active harness inference when that model
 * satisfies the seat's role and phase-effect capability demands.
 */

import { resolveRole, supportsMode } from "../matrix/capability-matrix.js";

const PHASE_EFFECT_CAPABILITY_DEMAND = ["delegate", "execute", "write", "read", "respond"];

function asArray(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function modelToken(selection) {
  if (!selection) return null;
  if (typeof selection === "string") return selection;
  if (typeof selection === "object") return selection.id || selection.model || null;
  return String(selection);
}

export function inferSeatCapabilityDemand(topology) {
  const modesBySeat = new Map();
  for (const phase of topology?.phases || []) {
    const mode = phase.mode || "respond";
    const seatIds = phase.seats || (phase.seat ? [phase.seat] : []);
    for (const seatId of seatIds) {
      if (!modesBySeat.has(seatId)) modesBySeat.set(seatId, new Set());
      modesBySeat.get(seatId).add(mode);
    }
  }

  const demand = new Map();
  for (const [seatId, modes] of modesBySeat) {
    demand.set(seatId, PHASE_EFFECT_CAPABILITY_DEMAND.find((mode) => modes.has(mode)) || "respond");
  }
  return demand;
}

export function composeModelDelegation(topology, lineup = {}, options = {}) {
  const resolveRoleFn = options.resolveRole || resolveRole;
  const supportsModeFn = options.supportsMode || supportsMode;
  const preferHarnessInference = options.preferHarnessInference === true;
  const harnessModel = modelToken(options.harnessModelResource);
  const allowHarnessRoleBypass = options.allowHarnessRoleBypass === true;
  const filled = { ...(lineup || {}) };
  const assigned = new Set(Object.values(filled).flatMap(asArray));
  const seatCapabilityDemand = inferSeatCapabilityDemand(topology);
  const audit = [];

  for (const seat of topology?.seats || []) {
    const explicit = filled[seat.id];
    const requiredMode = seatCapabilityDemand.get(seat.id) || "respond";
    if (explicit) {
      audit.push({ seatId: seat.id, source: "explicit-lineup", selected: asArray(explicit), roleHint: seat.roleHint || null, requiredMode });
      continue;
    }

    const roleHint = seat.roleHint || "analyst";
    let candidates = roleHint ? resolveRoleFn(roleHint) : [];
    if (candidates.length === 0 && roleHint !== "analyst") candidates = resolveRoleFn("analyst");
    if (candidates.length === 0) {
      audit.push({ seatId: seat.id, source: "unfilled", selected: [], roleHint, requiredMode, reason: "no-role-candidates" });
      continue;
    }

    const harnessCandidate = harnessModel
      ? candidates.find((candidate) => candidate.model === harnessModel)
      : null;
    const harnessModeOk = harnessModel ? supportsModeFn(harnessModel, requiredMode) : false;
    const mayUseHarness = preferHarnessInference
      && harnessModel
      && harnessModeOk
      && (harnessCandidate || allowHarnessRoleBypass || requiredMode === "delegate");

    const count = Math.max(seat.min, 1);
    let pool;
    let source;
    if (mayUseHarness) {
      const rest = candidates.filter((candidate) => candidate.model !== harnessModel);
      pool = [{ model: harnessModel }, ...rest];
      source = harnessCandidate ? "harness-role-candidate" : "harness-mode-candidate";
    } else {
      const unassigned = candidates.filter((candidate) => !assigned.has(candidate.model));
      pool = unassigned.length > 0 ? unassigned : candidates;
      source = "role-auto-fill";
    }

    const models = pool.slice(0, count).map((candidate) => candidate.model);
    for (const model of models) assigned.add(model);
    filled[seat.id] = models.length === 1 ? models[0] : models;
    audit.push({
      seatId: seat.id,
      source,
      selected: models,
      roleHint,
      requiredMode,
      harnessModel: mayUseHarness ? harnessModel : null,
      candidateCount: candidates.length,
    });
  }

  return { lineup: filled, audit };
}

export default { inferSeatCapabilityDemand, composeModelDelegation };
