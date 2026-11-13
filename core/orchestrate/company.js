// Phase 4 — the concurrent composer: run N topologies side by side as a company.
//
// runCompany runs each member topology via runTopology() CONCURRENTLY under ONE
// shared sessionId, so members are siblings on the Phase 3 awareness bus and can
// see one another's work mid-run; each still gets its own runId (Phase 0 isolation).
// This is the AGENT-LESS orchestrator: no orchestrator agent is required. An optional
// orchestrator-seat (Phase 4b) is a bonus caller of the same primitive, never a
// dependency. It reuses runTopology wholesale — it never rewrites phase execution.
//
// Design hardened through a darwinian cycle (2026-06-17): the mutation/fitness pass
// caught that pre-minting a member runId desyncs from runTopology's real scope, so we
// capture the runId off the returned trace (the wrapper now surfaces it). Every
// mutator perturbation is handled: a member that throws is isolated (status "error",
// company continues); an operator abort propagates to all peers via composeSignals;
// not-yet-started members short-circuit to "aborted"; a degenerate company of 1 and
// an empty/invalid member lineup both run without crashing; a member that spawns a
// child (Phase 5) shares the sessionId and stays visible on the bus.

import { runTopology as realRunTopology } from "../topologies/runner.js";
import { nextRunId } from "../events/emitter.js";
import { createRunBudget } from "./run-budget.js";
import { carryChildIdentity } from "./child-identity.js";

export const DEFAULT_CONCURRENCY = 8;
export const HARD_CONCURRENCY_CEIL = 64;

function isAbortSignal(x) {
  return !!x && typeof x === "object" && typeof x.aborted === "boolean" && typeof x.addEventListener === "function";
}

/** A signal that aborts when EITHER input aborts. undefined when neither is a signal. */
export function composeSignals(a, b) {
  const sigs = [a, b].filter(isAbortSignal);
  if (sigs.length === 0) return undefined;
  if (sigs.length === 1) return sigs[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    try { return AbortSignal.any(sigs); } catch { /* fall through to manual */ }
  }
  const ctrl = new AbortController();
  const trip = (reason) => { if (!ctrl.signal.aborted) ctrl.abort(reason); };
  for (const s of sigs) {
    if (s.aborted) { trip(s.reason); break; }
    s.addEventListener("abort", () => trip(s.reason), { once: true });
  }
  return ctrl.signal;
}

/**
 * Bounded worker pool: run fn over items with at most `limit` concurrent, results
 * kept in input order. `cursor++` is atomic under JS cooperative concurrency (no
 * await between read and write), so workers never claim the same index.
 */
export async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // Defense in depth — fn (runMember) is contracted never to throw, but a
        // pool worker must not die and strand the company.
        results[i] = { index: i, topologyId: items[i]?.topologyId ?? null, runId: null, status: "error", trace: null, error: String(err?.message || err) };
      }
    }
  }
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Run one member topology. NEVER throws — always resolves a MemberResult. */
async function runMember(spec, index, ctx) {
  const { companySessionId, companySignal, companyPrompt, mandate, awareness, runTopology, childCarry = null } = ctx;
  const base = { index, topologyId: spec?.topologyId ?? null, runId: null, status: "failed", trace: null, error: null };

  if (!spec || typeof spec.topologyId !== "string" || !spec.topologyId) {
    return { ...base, error: "invalid member: a string topologyId is required" };
  }
  // The company aborted before this member got a slot — never start work.
  if (companySignal?.aborted) {
    return { ...base, status: "aborted", error: "company aborted before this member started" };
  }

  const prompt = spec.prompt != null ? spec.prompt : companyPrompt;
  const options = {
    // [A91]/DR-184: the company-level childIdentity carry seeds the member's
    // options FIRST so an explicit member spec.options always wins.
    ...(childCarry && typeof childCarry === "object" ? childCarry : {}),
    ...(spec.options || {}),
    awareness: spec.options?.awareness ?? awareness, // members are mutually aware by default
    signal: composeSignals(companySignal, spec.options?.signal),
    ...(mandate != null ? { mandate } : {}),
  };

  try {
    const trace = await runTopology(spec.topologyId, spec.lineup || {}, prompt ?? "", options, companySessionId);
    // A returned trace reached a terminal. runTopology HALTS-with-a-trace (it does
    // not throw) on budget / gate / operator-abort-checkpoint, setting trace.halted +
    // a haltReason (verified contract: "Operator aborted at fire-control checkpoint" /
    // "Token budget exhausted" / "Gate check failed"). So: classify a halt by its real
    // reason (abort-ish -> "aborted", else -> "halted"); a COMPLETED (non-halted) member
    // stays "ok" even if the company aborts afterward — finished work is not un-finished.
    // (adversarial-debate council finding, 2026-06-17: the old `haltReason === "aborted"`
    // guess never matched the real reason and silently mislabeled aborted members "ok".)
    let status = "ok";
    let error = null;
    if (trace && trace.halted) {
      const reason = String(trace.haltReason || "halted");
      status = (companySignal?.aborted || /abort/i.test(reason)) ? "aborted" : "halted";
      error = reason;
    }
    return {
      index,
      topologyId: spec.topologyId,
      runId: (trace && trace.runId) || null, // the REAL run scope id, captured not pre-minted
      status,
      trace: trace || null,
      error,
    };
  } catch (err) {
    const aborted = !!companySignal?.aborted || err?.name === "AbortError";
    return {
      index,
      topologyId: spec.topologyId,
      runId: null,
      status: aborted ? "aborted" : "error",
      trace: null,
      error: String(err?.message || err),
    };
  }
}

function aggregate(members, companySessionId, companyAborted) {
  const ok = members.filter((m) => m.status === "ok").length;
  const errored = members.filter((m) => m.status === "error").length;
  const aborted = members.filter((m) => m.status === "aborted").length;
  const halted = members.filter((m) => m.status === "halted").length;
  let status;
  if (members.length > 0 && ok === members.length) status = "complete";
  else if (ok === 0 && aborted > 0 && errored === 0 && halted === 0) status = "aborted";
  else if (ok === 0 && aborted === 0) status = "failed"; // all error / halted / invalid, none ok
  else status = "partial";
  return {
    ok: status === "complete",
    status,
    sessionId: companySessionId,
    counts: { total: members.length, ok, errored, aborted, halted },
    aborted: !!companyAborted || aborted > 0,
    members,
  };
}

/**
 * Run a company of topologies concurrently.
 *
 * @param {object} config
 * @param {Array<{topologyId:string, lineup?:object, prompt?:string, options?:object}>} config.topologies
 * @param {string} [config.prompt]      — default task for members that don't specify one
 * @param {*} [config.mandate]          — carried into each member (Phase 6 wires enforcement)
 * @param {number} [config.concurrency] — max concurrent members (default 8, hard cap 64)
 * @param {boolean} [config.awareness]  — members mutually aware (default true)
 * @param {AbortSignal} [config.signal] — external (operator) abort
 * @param {object} [deps]               — { runTopology } injection seam for hermetic tests
 * @returns {Promise<CompanyResult> & { abort(reason):void, signal:AbortSignal, sessionId:string }}
 */
export function runCompany(config = {}, deps = {}) {
  const { topologies, prompt = "", mandate = null, concurrency = DEFAULT_CONCURRENCY, awareness = true, signal: externalSignal, genome = null, agents = null } = config;
  if (!Array.isArray(topologies) || topologies.length === 0) {
    throw new TypeError("runCompany: topologies must be a non-empty array");
  }
  if (externalSignal != null && !isAbortSignal(externalSignal)) {
    throw new TypeError("runCompany: signal must be an AbortSignal");
  }
  const runTopology = deps.runTopology || realRunTopology;

  const companySessionId = nextRunId("company"); // company-<ts>-<seq>: the shared bus key
  const controller = new AbortController();
  const companySignal = composeSignals(controller.signal, externalSignal) || controller.signal;
  const reqLimit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY;
  const limit = Math.max(1, Math.min(reqLimit, HARD_CONCURRENCY_CEIL));

  // Phase F — the Run-wide governor. One budget per company Run; default UNLIMITED, so an
  // un-configured run is byte-identical. A run-level maxConcurrent additionally clamps the
  // pool width so members never exceed the Run ceiling; threaded into each member so the
  // spawn gate + dispatch token charge can consult the SAME budget (members + children
  // sharing one pool — that cross-path consultation lands with batch 2's spawn work).
  // Exposed on the promise for the operator surface.
  const runBudget = createRunBudget({ maxConcurrent: config.maxConcurrent, tokenCeiling: config.tokenCeiling });
  const budgetCap = runBudget.snapshot().maxConcurrent;
  const poolWidth = budgetCap != null ? Math.max(1, Math.min(limit, budgetCap)) : limit;

  // [A91]/DR-184: the childIdentity carry at the COMPANY seam — the company
  // config is the members' parent context; under `inherit` every member's
  // options gain the shared agents manifest + the genome control (a member's
  // own spec.options still win). {} under `none` — byte-identical.
  const childCarry = carryChildIdentity({ genome, agentManifest: agents });

  const promise = (async () => {
    const members = await runPool(topologies, poolWidth, (spec, index) =>
      runMember(spec, index, { companySessionId, companySignal, companyPrompt: prompt, mandate, awareness, runTopology, runBudget, childCarry }),
    );
    return aggregate(members, companySessionId, controller.signal.aborted || !!externalSignal?.aborted);
  })();

  // Augment the promise with a control handle the ACP adapter / operator surface use.
  promise.abort = (reason) => { if (!controller.signal.aborted) controller.abort(reason ?? "operator-abort"); };
  promise.signal = companySignal;
  promise.sessionId = companySessionId;
  promise.runBudget = runBudget;
  return promise;
}

export default { runCompany, runPool, composeSignals, DEFAULT_CONCURRENCY, HARD_CONCURRENCY_CEIL };
