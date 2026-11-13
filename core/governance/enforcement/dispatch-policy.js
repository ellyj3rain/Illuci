/**
 * illuci — Dispatch Policy (the HARD-tier model + dispatch allowlist primitive)
 *
 * The one piece of the enforcement spine that does not exist anywhere else. The
 * per-TOOL gate (gates/policy.js applyPolicy) keys on filePath; this keys on
 * modelId + dispatch-kind. It is a synchronous POLICY verdict — never a per-query
 * operator prompt — consulted before bridge.query on every dispatch.
 *
 * Back-compat is sacred: ships enforce:false with empty lists, so evaluateDispatch
 * always returns "allow" until the operator arms a policy. The GateConfig loader
 * instantiates the (previously never-instantiated) operator-override class.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { GateConfig } from "../../gates/gate-registry.js";
import { resolveIlluciHomeRoot } from "../../bridges/tool-paths.js";

// ─── DEFAULT POLICY (inert — every dispatch allowed until armed) ───
const policy = {
  enforce: false,
  allowModels: [],
  denyModels: [],
  allowDispatchKinds: [],
  denyDispatchKinds: [],
};

// ─── RUN-SCOPED ARM REFCOUNT ───
// orchestrate() arms enforcement for the DURATION of a company run. A single boolean toggle
// races under overlapping runs in one process (the TUI/MCP/ACP surfaces that share this
// entrypoint): if the run that armed it settles first, its disarm() flips enforce:false while
// a SIBLING run is still dispatching — silently de-governing the in-flight run's HARD-tier
// gate. The fix is a process-wide refcount: enforcement stays armed until the LAST overlapping
// run drains. Single-threaded JS makes this torn-read-free (no atomics needed, only correct
// counting).
//   _armCount    — number of live run references holding the gate armed.
//   _armBaseline — the OPERATOR's enforce posture, captured at the 0->1 transition and kept in
//                  sync with any standalone updateDispatchPolicy({enforce}) the operator makes
//                  while runs hold refs, so the final restore never clobbers an operator who
//                  armed the gate independently mid-run.
let _armCount = 0;
let _armBaseline = false;

export function getDispatchPolicy() {
  return { ...policy };
}

/** Update the live policy (operator-arming seam). Returns the new policy. */
export function updateDispatchPolicy(patch = {}) {
  if (Array.isArray(patch.allowModels)) policy.allowModels = patch.allowModels;
  if (Array.isArray(patch.denyModels)) policy.denyModels = patch.denyModels;
  if (Array.isArray(patch.allowDispatchKinds)) policy.allowDispatchKinds = patch.allowDispatchKinds;
  if (Array.isArray(patch.denyDispatchKinds)) policy.denyDispatchKinds = patch.denyDispatchKinds;
  if (typeof patch.enforce === "boolean") {
    policy.enforce = patch.enforce;
    // This is the OPERATOR seam (standalone arming). Whatever the operator sets here becomes
    // the new baseline the run-refcount restores to, so an operator who arms the gate WHILE
    // runs hold references is not clobbered when the last run drains. (When called from within
    // arm/disarm we re-sync _armBaseline explicitly, so this stays consistent there too.)
    _armBaseline = patch.enforce;
  }
  return getDispatchPolicy();
}

/**
 * Acquire a run-scoped reference on dispatch enforcement. On the 0->1 transition, capture the
 * operator's current enforce posture as the baseline and arm the gate (enforce:true). Returns
 * a disarm() that releases the reference exactly once (idempotent); on the final 1->0
 * transition it restores enforce to the captured baseline. Overlapping runs each hold a ref,
 * so the gate stays armed until the last one releases.
 *
 * @returns {{ wasArmed: boolean, disarm: () => void }}
 */
export function acquireDispatchArm() {
  const wasArmed = !!policy.enforce;
  if (_armCount === 0) _armBaseline = !!policy.enforce;
  _armCount++;
  if (!policy.enforce) policy.enforce = true; // armed for the run's duration
  let done = false;
  return {
    wasArmed,
    disarm() {
      if (done) return; // idempotent: a double-disarm for one acquire is a no-op
      done = true;
      _armCount = Math.max(0, _armCount - 1);
      if (_armCount === 0) policy.enforce = _armBaseline; // restore the operator baseline
    },
  };
}

/** Reset to the inert default (test isolation). */
export function _resetDispatchPolicyForTest() {
  policy.enforce = false;
  policy.allowModels = [];
  policy.denyModels = [];
  policy.allowDispatchKinds = [];
  policy.denyDispatchKinds = [];
  _armCount = 0;
  _armBaseline = false;
}

/**
 * Derive the dispatch kind from the options bag. Spawn wins (it is the most
 * privileged path), then raw, then seat, else a plain direct dispatch.
 */
export function dispatchKindOf(options = {}) {
  if (options.spawn) return "spawn";
  if (options.raw) return "raw";
  if (options.seat) return "seat";
  return "direct";
}

/**
 * Synchronous policy verdict for a model + dispatch kind. Fail-closed when armed:
 *   - a denylist match (model or kind)  -> deny
 *   - enforce:true AND a non-empty allowModels AND modelId absent from it -> deny
 *   - enforce:true AND a non-empty allowDispatchKinds AND kind absent      -> deny
 * Otherwise allow. With enforce:false / empty lists, always allow (byte-identical
 * to the prior unguarded path).
 *
 * @returns {{ decision: "allow" | "deny", reason: string, dispatchKind: string }}
 */
export function evaluateDispatch(modelId, options = {}) {
  const kind = dispatchKindOf(options);

  // Denylists apply whenever they are populated (even with enforce:false, a deny
  // is an explicit operator instruction to never run that target).
  if (policy.denyModels.length && policy.denyModels.includes(modelId)) {
    return { decision: "deny", reason: `model "${modelId}" is on the dispatch denylist`, dispatchKind: kind };
  }
  if (policy.denyDispatchKinds.length && policy.denyDispatchKinds.includes(kind)) {
    return { decision: "deny", reason: `dispatch kind "${kind}" is on the denylist`, dispatchKind: kind };
  }

  // Allowlists are fail-closed but only ENFORCED when armed.
  if (policy.enforce) {
    if (policy.allowModels.length && !policy.allowModels.includes(modelId)) {
      return { decision: "deny", reason: `model "${modelId}" is not on the dispatch allowlist`, dispatchKind: kind };
    }
    if (policy.allowDispatchKinds.length && !policy.allowDispatchKinds.includes(kind)) {
      return { decision: "deny", reason: `dispatch kind "${kind}" is not on the allowlist`, dispatchKind: kind };
    }
  }

  return { decision: "allow", reason: "permitted by dispatch policy", dispatchKind: kind };
}

// ─── GateConfig (operator overrides) ───
// The class has existed in gates/gate-registry.js and was never instantiated. The
// spine instantiates it here from a config blob, loaded from ILLUCI_GATE_CONFIG (a JSON
// path) or <illuciHome>/.illuci/gate-config.json. Absent file -> new GateConfig({}) ->
// no trusted agents, no overrides -> never consulted (back-compat).

let _gateConfig = null;

/**
 * Coerce a loaded gate-config blob into the shape GateConfig + checkOverride assume,
 * so an operator typo (trustedAgents written as a string/object, overrides as an array)
 * cannot make isAgentTrusted/checkOverride throw on the dispatch path. A malformed field
 * degrades to its empty form (warn + treat as absent), never an exception.
 */
function normalizeGateConfigBlob(blob) {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    if (blob !== undefined && blob !== null) console.warn("[dispatch-policy] gate-config is not an object; ignoring");
    return {};
  }
  const out = { ...blob };
  for (const key of ["trustedAgents", "trustedPaths"]) {
    if (key in out && !Array.isArray(out[key])) {
      console.warn(`[dispatch-policy] gate-config.${key} is not an array; treating as empty`);
      out[key] = [];
    }
  }
  if ("overrides" in out && (typeof out.overrides !== "object" || out.overrides === null || Array.isArray(out.overrides))) {
    console.warn("[dispatch-policy] gate-config.overrides is not an object; treating as empty");
    out.overrides = {};
  }
  return out;
}

function loadGateConfigBlob() {
  const explicit = process.env.ILLUCI_GATE_CONFIG;
  const candidates = [
    explicit,
    join(resolveIlluciHomeRoot(), ".illuci", "gate-config.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      if (existsSync(path)) return normalizeGateConfigBlob(JSON.parse(readFileSync(path, "utf-8")));
    } catch (err) {
      console.warn(`[dispatch-policy] gate-config load failed (${path}): ${err.message}`);
    }
  }
  return {};
}

export function getGateConfig() {
  if (_gateConfig === null) _gateConfig = new GateConfig(loadGateConfigBlob());
  return _gateConfig;
}

/** Force a reload of the gate config (operator edited it; or test isolation). */
export function reloadGateConfig() {
  _gateConfig = null;
  return getGateConfig();
}

/**
 * Is this dispatch override-whitelisted by the operator's GateConfig? Checks the
 * trustedAgents list (keyed on seat or model) and the per-key overrides map.
 *
 * @returns {{ overridden: boolean, by?: string, ruleId?: string }}
 */
export function checkOverride(modelId, options = {}) {
  const cfg = getGateConfig();
  const seat = options.seat || null;
  if (seat && cfg.isAgentTrusted(seat)) return { overridden: true, by: "gateconfig:trustedAgent", ruleId: seat };
  if (cfg.isAgentTrusted(modelId)) return { overridden: true, by: "gateconfig:trustedAgent", ruleId: modelId };
  if (cfg.overrides && (cfg.overrides[modelId] || (seat && cfg.overrides[seat]))) {
    const key = cfg.overrides[modelId] ? modelId : seat;
    return { overridden: true, by: "gateconfig:override", ruleId: key };
  }
  return { overridden: false };
}

export default {
  getDispatchPolicy, updateDispatchPolicy, acquireDispatchArm, evaluateDispatch, dispatchKindOf,
  getGateConfig, reloadGateConfig, checkOverride, _resetDispatchPolicyForTest,
};
