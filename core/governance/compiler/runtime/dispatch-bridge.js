// illuci/core/governance/compiler/runtime/dispatch-bridge.js
//
// The dispatch-time counterpart of floor-bridge: run the APPLICABLE compiled hard GATE enforcers
// (pre-dispatch / session-init: repo-authority, scope, MCP-boundary, sovereignty) over a dispatch
// context. "Applicable" reuses the same fact-availability gate - a gate enforcer fires only when
// the dispatch context supplies the facts its predicate references, so it stays inert until those
// facts are plumbed through the dispatch path. enforce.js (enforceDispatchBill) calls this.

import { loadCompiled } from "./load-compiled.js";
import { applicable } from "./floor-bridge.js";
let checkCreationFit = null;
try {
  ({ check: checkCreationFit } = await import("../../compiled/gate/std-14.modularity.creation-fit.js"));
} catch { /* ordinary work retains the existing compiled-Bill fault behavior */ }

const text = (value) => typeof value === "string" && value.trim().length > 0;

/** Gather the selected creation decision from the existing scope/work record. */
export function gatherCreationFacts(options = {}, scopeRecord = null) {
  const decision = options.creationDecision ?? scopeRecord?.creationDecision ?? null;
  const consequential = options.consequentialAddition === true ||
    scopeRecord?.consequentialAddition === true || (decision !== null &&
      !["reuse", "repair", "assess", "delegate"].includes(decision?.action));
  const analysis = decision?.existingSystem;
  const surfaces = analysis?.surfaces;
  const grounded = decision?.action === "create" && text(decision.record) &&
    text(decision.requirement) && Array.isArray(surfaces) && surfaces.length > 0 &&
    surfaces.every((surface) => surface &&
      [surface.surface, surface.revision, surface.owner, surface.responsibilities,
        surface.contracts, surface.demonstratedBehavior, surface.reason].every(text) &&
      typeof surface.adequate === "boolean");
  const insufficient = grounded && surfaces.every((surface) => surface.adequate === false) &&
    text(decision.gap) && text(decision.boundary) && text(decision.owner);
  return {
    consequential_addition: consequential,
    existing_fit_analysis_recorded: grounded === true,
    existing_responsibilities_insufficient: insufficient === true,
  };
}

/** Native creation consumers force applicability before writing a new owned surface. */
export function checkCreationDecision(creationDecision, context = {}) {
  if (typeof checkCreationFit !== "function") {
    return { ok: false, reason: "consequential creation requires the registered existing-system fit gate" };
  }
  return checkCreationFit({ ...context,
    ...gatherCreationFacts({ consequentialAddition: true, creationDecision }) });
}

/**
 * @param {object} ctx  the dispatch context (facts: dispatched_branch, scope_record, ...)
 * @returns {Promise<{ok:boolean, blocking:Array<{obligation,reason}>}>}
 */
export async function runCompiledGate(ctx = {}) {
  if (ctx.consequential_addition === true) {
    ctx = { ...ctx,
      existing_fit_analysis_recorded: ctx.existing_fit_analysis_recorded === true,
      existing_responsibilities_insufficient: ctx.existing_responsibilities_insufficient === true };
  }
  const { gate } = await loadCompiled();
  const blocking = [];
  if (ctx.consequential_addition === true &&
      !gate.some((m) => m.OBLIGATION_ID === "std-14.modularity.creation-fit")) {
    blocking.push({ obligation: "std-14.modularity.creation-fit",
      reason: "consequential creation requires the registered existing-system fit gate" });
  }
  for (const m of gate) {
    if (typeof m.check !== "function" || !applicable(m, ctx)) continue;
    const v = m.check(ctx);
    if (!v.ok) blocking.push({ obligation: m.OBLIGATION_ID, reason: v.reason });
  }
  return { ok: blocking.length === 0, blocking };
}

export default { runCompiledGate };
