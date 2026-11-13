/**
 * illuci — orchestrate(): the single GOVERNED entrypoint over the company layer.
 *
 * THE GAP THIS CLOSES (Option 2). runCompany (./company.js) is a real, working
 * substrate primitive — concurrent multi-topology orchestration on one shared
 * awareness bus — but the ONLY way to reach it was to import the engine directly
 * and hand-wire a root-level `.mjs` driver (see /_compose.mjs, kept as the parity
 * reference). Those drivers run in raw Node and answer to NO gate: every dispatch
 * underneath them passes through enforceDispatch (dispatch.js), but enforceDispatch
 * is INERT until a dispatch policy is ARMED, and a hand-written driver never arms it.
 *
 * orchestrate() is the governed verb. It ARMS the dispatch enforcement posture
 * before delegating to runCompany, so a routed company run does NOT execute with
 * the HARD-tier policy gate inert. It is the one place the CLI `illuci company` verb
 * (and, later, the TUI/MCP surfaces) call — a single generic entrypoint, not a
 * second copy of the company runner.
 *
 * ── THE ARMING (minimal + correct) ──
 * enforceDispatch consults the dispatch policy (governance/enforcement/dispatch-policy.js).
 * That policy ships `enforce:false` with empty allow/deny lists, so evaluateDispatch
 * returns "allow" unconditionally and the gate is byte-identically inert. orchestrate
 * flips `enforce:true` via updateDispatchPolicy. The posture this sets, precisely:
 *   - The HARD-tier policy gate is now ARMED (active on every dispatch on the routed
 *     path), not inert — enforceDispatch's verdict is a real verdict, not a no-op pass.
 *   - With empty allow/deny lists, an armed policy STILL allows every model + dispatch
 *     kind (allowlists bite only when populated; denylists only when populated), so a
 *     governed run is not blocked. Arming changes the POSTURE (the gate is live), not
 *     the OUTCOME for an unconfigured fleet — exactly the seam an operator later tightens
 *     by populating allowModels / denyModels / *DispatchKinds (or a GateConfig override).
 * This is additive and reversible: orchestrate restores the prior `enforce` flag in a
 * `finally`, so a governed run does not silently leave the global policy armed for an
 * unrelated later caller in the same process. The dispatch-policy module owns the live
 * policy; orchestrate only toggles the posture for the duration of the run.
 *
 * ── RESERVED NO-OP HOOKS (forward-contract seams) ──
 * personaState and typingValidator are part of the signature TODAY but are NOT yet
 * consumed — they are reserved so the later slices plug in without a contract break:
 *   - personaState   → the per-persona-memory engine (persona-genome, Option 1). When
 *                      live, it threads durable persona identity/history into each seat.
 *   - typingValidator→ the semantic model-typing layer (Option 3). When live, it
 *                      validates/admits a seat's model against a typed contract.
 * Both are accepted, documented, validated-shallow, and otherwise ignored. Passing them
 * is a no-op now and a forward-compatible call later.
 */

import { runCompany } from "./company.js";
import { acquireDispatchArm } from "../governance/enforcement/dispatch-policy.js";

// company-rounds — the heterogeneous-adversarial company loop (a round driver OVER this
// governed entrypoint). A thin re-export so the rounds capability is reachable from the same
// module surface as orchestrate(); this adds NO internal logic to orchestrate() itself.
export { runCompanyRounds } from "./company-rounds.js";

/**
 * Arm the dispatch enforcement posture for the duration of ONE run and return a
 * disarm() that releases this run's reference.
 *
 * Reference-counted (acquireDispatchArm in dispatch-policy.js): the gate stays armed
 * until the LAST overlapping run releases, so a sibling run is never silently de-governed
 * when an earlier run settles first. The disarm() restores the OPERATOR baseline (the
 * enforce posture captured at the first acquire), never force-disarming a policy the
 * operator armed independently. disarm() is idempotent (a double-call is a no-op).
 *
 * A refcount-free boolean toggle here was the bug: under two concurrent orchestrate()
 * calls (the TUI/MCP/ACP surfaces this entrypoint is built to share), the run that armed
 * the gate would flip enforce:false on its own completion while a sibling run was still
 * dispatching members against the now-INERT HARD-tier gate.
 *
 * @returns {{ wasArmed: boolean, disarm: () => void }}
 */
export function armDispatchEnforcement() {
  return acquireDispatchArm();
}

/**
 * orchestrate — the governed wrapper over runCompany.
 *
 * @param {object} args
 * @param {Array<{topologyId:string, lineup?:object, prompt?:string, options?:object}>} args.topologies
 *        — the company member set (forwarded to runCompany unchanged).
 * @param {string} [args.prompt]        — default task for members that omit one.
 * @param {object} [args.lineup]        — a DEFAULT seat→model lineup applied to any member
 *                                        spec that does not carry its own `lineup` (the
 *                                        simple single-cast case; per-member lineup wins).
 * @param {boolean} [args.awareness]    — members mutually aware on the bus (default true).
 * @param {number} [args.concurrency]   — max concurrent members (runCompany default 8).
 * @param {object|null} [args.personaState=null]      — RESERVED no-op hook (persona-genome).
 * @param {Function|null} [args.typingValidator=null] — RESERVED no-op hook (model-typing).
 * @param {object} [dispatchOpts]       — any remaining run-level config (mandate, signal,
 *                                        maxConcurrent, tokenCeiling, ...) forwarded to
 *                                        runCompany's config.
 * @param {object} [deps]               — { runTopology } injection seam for hermetic tests,
 *                                        forwarded to runCompany.
 * @returns {Promise<import('./company.js').CompanyResult>} runCompany's result, augmented
 *          with the same { abort, signal, sessionId, runBudget } control handle.
 */
export function orchestrate(
  { topologies, prompt = "", lineup = null, awareness = true, concurrency, personaState = null, typingValidator = null, ...dispatchOpts } = {},
  deps = {},
) {
  if (!Array.isArray(topologies) || topologies.length === 0) {
    throw new TypeError("orchestrate: topologies must be a non-empty array");
  }

  // ── RESERVED hooks: shallow-validate the shape so a malformed forward-call fails
  //    LOUD here (at the contract boundary) rather than silently later, but otherwise
  //    do nothing with them — they are seams, inert until their owning slice lands. ──
  if (personaState != null && typeof personaState !== "object") {
    throw new TypeError("orchestrate: personaState must be an object or null (reserved no-op hook)");
  }
  if (typingValidator != null && typeof typingValidator !== "function") {
    throw new TypeError("orchestrate: typingValidator must be a function or null (reserved no-op hook)");
  }

  // Apply the default lineup to any member that did not bring its own. Per-member
  // lineup always wins (a member is more specific than the company default).
  const members = lineup
    ? topologies.map((spec) => (spec && spec.lineup ? spec : { ...spec, lineup }))
    : topologies;

  const config = {
    ...dispatchOpts, // mandate / signal / maxConcurrent / tokenCeiling — run-level passthrough
    topologies: members,
    prompt,
    awareness,
    ...(concurrency != null ? { concurrency } : {}),
  };

  // ── ARM the gate BEFORE the run, restore AFTER. runCompany returns a promise
  //    augmented with the control handle; we await it inside so the finally can
  //    restore the posture once every member has terminated, then re-expose the
  //    handle on the returned promise so callers keep { abort, signal, sessionId }. ──
  const arm = armDispatchEnforcement();
  let inner;
  try {
    inner = runCompany(config, deps);
  } catch (err) {
    // runCompany validates synchronously (empty company / bad signal). A synchronous
    // throw must NOT leak the armed posture — restore it before re-throwing.
    arm.disarm();
    throw err;
  }
  const wrapped = (async () => {
    let result;
    try {
      result = await inner;
      return result;
    } finally {
      arm.disarm();
      // ── [A16.2] Datastore capture (dark behind ILLUCI_DATASTORE_ENABLED). Persists the
      //    company-level manifest + synthesis — the datum lost today. Per-member seat
      //    outputs land via the runTopology seam (run-writer), linked by the shared
      //    sessionId. Non-fatal: a failed write never fails the run. ──
      try {
        // Cheap env pre-gate: disabled (default) → ZERO imports, byte-identical.
        if (result !== undefined &&
            /^(1|true|on|yes)$/i.test(String(process.env.ILLUCI_DATASTORE_ENABLED || "").trim())) {
          const { datastoreEnabled } = await import("../datastore/index.js");
          if (datastoreEnabled()) {
            (await import("../datastore/company-writer.js")).persistCompany(result);
          }
        }
      } catch { /* persistence never fails a run */ }
    }
  })();
  // Preserve the operator/ACP control surface runCompany exposes on its promise.
  wrapped.abort = (reason) => inner.abort(reason);
  wrapped.signal = inner.signal;
  wrapped.sessionId = inner.sessionId;
  wrapped.runBudget = inner.runBudget;
  return wrapped;
}

export default { orchestrate, armDispatchEnforcement };
