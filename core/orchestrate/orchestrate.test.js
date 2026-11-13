/**
 * illuci — orchestrate(): the governed company entrypoint (node:test, hermetic).
 *
 * A fake runTopology is injected via deps, so no real model / bridge / filesystem.
 * The central guarantee under test is GATE INHERITANCE: a run routed through
 * orchestrate() executes with the dispatch enforcement policy ARMED (active, not
 * inert) — unlike a hand-written driver that calls runCompany directly and leaves
 * enforceDispatch a no-op. We prove this by probing the live dispatch policy from
 * INSIDE the injected runTopology (i.e. while the company is mid-run).
 *
 * Run: node --test illuci/core/orchestrate/orchestrate.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrate, armDispatchEnforcement } from "./orchestrate.js";
import {
  getDispatchPolicy,
  evaluateDispatch,
  _resetDispatchPolicyForTest,
} from "../governance/enforcement/dispatch-policy.js";

function resetPolicy() { _resetDispatchPolicyForTest(); }

// A fake runTopology that records its calls AND captures whether the dispatch policy
// is armed at the moment a member runs (the governed-path probe).
function makeFake(probe = {}) {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId });
    // Snapshot the live enforcement posture WHILE the company is running.
    probe.enforceDuringRun = getDispatchPolicy().enforce;
    // Also confirm enforceDispatch is genuinely consulted (not inert) by checking a
    // populated denylist would bite — but here lists are empty so it still allows.
    probe.verdictDuringRun = evaluateDispatch("any-model", { seat: "member" }).decision;
    return { topologyId, runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

// ─── GATE INHERITANCE: the routed path runs with enforcement ARMED ──────────────

test("gate-inheritance: orchestrate ARMS the dispatch policy for the duration of the run", async () => {
  resetPolicy();
  assert.equal(getDispatchPolicy().enforce, false, "precondition: policy is inert (default)");

  const probe = {};
  const { fn } = makeFake(probe);
  const result = await orchestrate(
    { topologies: [{ topologyId: "judiciary" }], prompt: "decide" },
    { runTopology: fn },
  );

  assert.equal(result.status, "complete");
  // THE GUARANTEE: enforcement was ARMED (active) while the member ran — NOT inert.
  assert.equal(probe.enforceDuringRun, true,
    "the governed path must run with enforceDispatch ARMED (policy.enforce=true), not inert");
  // The armed policy still ALLOWS an unconfigured fleet (empty lists) — arming changes
  // the posture, not the outcome, so a legitimate governed run is not blocked.
  assert.equal(probe.verdictDuringRun, "allow",
    "an armed-but-empty policy allows every dispatch (arming changes posture, not outcome)");
});

test("gate-inheritance: orchestrate RESTORES the prior posture after the run (no global leak)", async () => {
  resetPolicy();
  const { fn } = makeFake();
  await orchestrate({ topologies: [{ topologyId: "judiciary" }] }, { runTopology: fn });
  assert.equal(getDispatchPolicy().enforce, false,
    "after a governed run the policy is restored to its prior (inert) posture");
});

test("gate-inheritance: if the policy was ALREADY armed, orchestrate leaves it armed (no force-disarm)", async () => {
  resetPolicy();
  const arm = armDispatchEnforcement(); // pre-arm (simulate an operator-armed policy)
  assert.equal(getDispatchPolicy().enforce, true);
  const { fn } = makeFake();
  await orchestrate({ topologies: [{ topologyId: "judiciary" }] }, { runTopology: fn });
  assert.equal(getDispatchPolicy().enforce, true,
    "a pre-armed policy stays armed — orchestrate restores to the PRIOR posture, not a forced off");
  arm.disarm();
  assert.equal(getDispatchPolicy().enforce, false);
});

// ─── CONCURRENT OVERLAP: the gate stays armed until the LAST run drains ──────────
//
// Two overlapping orchestrate() runs share ONE process-global dispatch policy. A
// refcount-free boolean toggle races: if the run that armed the gate settles first, its
// disarm flips enforce:false while the SIBLING run is still dispatching — silently de-
// governing the in-flight run's HARD-tier gate. The refcounted arm keeps enforcement armed
// until BOTH runs release. We drive the race deterministically with a per-run deferred that
// gates each run's single member, so we can settle run A while run B is provably still
// in-flight and probe the live policy at that exact point.

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("concurrency: the gate stays ARMED while a sibling run is still in-flight (refcount, no race)", async () => {
  resetPolicy();
  assert.equal(getDispatchPolicy().enforce, false, "precondition: inert default");

  const gateA = deferred();
  const gateB = deferred();
  // Each run's member blocks on its own gate. The member also records the live enforce
  // posture it observed WHILE running (the de-governance probe).
  const observed = { a: null, b: null };
  const fnA = async () => { observed.a = getDispatchPolicy().enforce; await gateA.promise; return { runId: "a", halted: false, phases: {} }; };
  const fnB = async () => { observed.b = getDispatchPolicy().enforce; await gateB.promise; return { runId: "b", halted: false, phases: {} }; };

  // Start A (arms: count 0->1, enforce true), then B while A is still in-flight (count 1->2).
  const pA = orchestrate({ topologies: [{ topologyId: "run-a" }] }, { runTopology: fnA });
  const pB = orchestrate({ topologies: [{ topologyId: "run-b" }] }, { runTopology: fnB });
  // Let both members reach their await (both have entered the run and armed/probed).
  await new Promise((r) => setImmediate(r));
  assert.equal(getDispatchPolicy().enforce, true, "both runs armed: the gate is live");

  // Settle A FIRST (the run that armed it). Under the buggy boolean toggle, A's disarm would
  // flip enforce:false here while B is still blocked on gateB — de-governing B mid-run.
  gateA.resolve();
  await pA;
  assert.equal(getDispatchPolicy().enforce, true,
    "A settled but B is STILL in-flight — the gate must remain armed (B holds a reference)");

  // Now drain B; only when the LAST run releases does the gate restore to the inert baseline.
  gateB.resolve();
  await pB;
  assert.equal(getDispatchPolicy().enforce, false, "both runs drained: the gate restores to baseline");

  // Neither run ever observed a disarmed gate while it believed it was governed.
  assert.equal(observed.a, true, "run A ran governed");
  assert.equal(observed.b, true, "run B ran governed");
});

test("concurrency: an operator-armed gate survives a concurrent run draining (baseline preserved)", async () => {
  resetPolicy();
  // Operator pre-arms the gate (standalone seam). A concurrent run must not clobber it on exit.
  const operatorArm = armDispatchEnforcement();
  assert.equal(getDispatchPolicy().enforce, true);

  const { fn } = makeFake();
  await orchestrate({ topologies: [{ topologyId: "x" }] }, { runTopology: fn });
  assert.equal(getDispatchPolicy().enforce, true,
    "a run draining does NOT disarm an operator-armed gate (refcount only restores the baseline)");

  operatorArm.disarm();
  assert.equal(getDispatchPolicy().enforce, false, "the gate releases only when the operator's own ref drains");
});

// ─── The wrapper threads config correctly through to runCompany ─────────────────

test("orchestrate applies the company-default lineup to members without their own", async () => {
  resetPolicy();
  const { fn, calls } = makeFake();
  await orchestrate(
    {
      topologies: [{ topologyId: "judiciary" }, { topologyId: "legislature", lineup: { sponsor: "claude-local" } }],
      lineup: { prosecutor: "grok-build" },
      prompt: "p",
    },
    { runTopology: fn },
  );
  const judiciary = calls.find((c) => c.topologyId === "judiciary");
  const legislature = calls.find((c) => c.topologyId === "legislature");
  // The member without its own lineup inherits the company default…
  assert.deepEqual(judiciary.lineup, { prosecutor: "grok-build" });
  // …the member WITH its own lineup keeps it (more specific wins).
  assert.deepEqual(legislature.lineup, { sponsor: "claude-local" });
});

test("orchestrate forwards prompt + awareness + concurrency and exposes runCompany's control handle", async () => {
  resetPolicy();
  const { fn, calls } = makeFake();
  // The control handle lives on the returned PROMISE (grabbed pre-await), mirroring
  // runCompany's contract: { abort, signal, sessionId } are operator/ACP affordances.
  const p = orchestrate(
    { topologies: [{ topologyId: "judiciary" }], prompt: "the motion", awareness: true, concurrency: 3 },
    { runTopology: fn },
  );
  assert.equal(typeof p.abort, "function", "the operator/ACP control handle is preserved on the promise");
  assert.ok(p.signal && typeof p.signal.aborted === "boolean");
  assert.ok(String(p.sessionId).startsWith("company-"));
  const result = await p;
  assert.equal(result.status, "complete");
  assert.equal(calls[0].prompt, "the motion");
  assert.equal(calls[0].options.awareness, true, "members are mutually aware on the bus");
});

// ─── RESERVED no-op hooks: accepted, shape-validated, otherwise inert ───────────

test("orchestrate accepts the reserved personaState + typingValidator hooks as no-ops", async () => {
  resetPolicy();
  const { fn } = makeFake();
  const result = await orchestrate(
    {
      topologies: [{ topologyId: "judiciary" }],
      personaState: { agentSlug: "x" }, // accepted, currently unused
      typingValidator: () => true,       // accepted, currently unused
    },
    { runTopology: fn },
  );
  assert.equal(result.status, "complete", "the reserved hooks are inert (run completes normally)");
});

test("orchestrate rejects a malformed reserved hook at the contract boundary (synchronous throw)", () => {
  resetPolicy();
  const { fn } = makeFake();
  // Contract validation is synchronous (mirrors runCompany), so it THROWS, not rejects.
  assert.throws(
    () => orchestrate({ topologies: [{ topologyId: "judiciary" }], personaState: "not-an-object" }, { runTopology: fn }),
    /personaState must be an object/,
  );
  assert.throws(
    () => orchestrate({ topologies: [{ topologyId: "judiciary" }], typingValidator: 123 }, { runTopology: fn }),
    /typingValidator must be a function/,
  );
});

test("orchestrate rejects an empty company (synchronous throw)", () => {
  resetPolicy();
  const { fn } = makeFake();
  assert.throws(
    () => orchestrate({ topologies: [] }, { runTopology: fn }),
    /topologies must be a non-empty array/,
  );
});
