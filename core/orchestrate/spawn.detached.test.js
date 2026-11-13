/**
 * Phase 7 — the detached branch of makeSpawnTool. Hermetic: the SAME fake-runTopology
 * harness the awaited spawn.test.js uses, extended to the detached path (the injected
 * runTopology seam is preserved, so detached closes over the same fake).
 *
 * Proves:
 *  - BACK-COMPAT / no-op: with detached unset, the handler takes the awaited else branch
 *    byte-for-byte (returns the trace, no childRunId, no registry touched)
 *  - detached:true returns { ok, detached, childRunId, status:'running' } IMMEDIATELY,
 *    before the child run settles
 *  - TopologyTree commit/release move into the runner's settle: the active slot is held
 *    while running and freed exactly once on settle (no desync, no double-free)
 *  - a detached run that REJECTS releases the slot (not commit) and the registry snapshot
 *    carries the failure
 *  - a missing registry while detached is requested fails closed (detached-misconfigured)
 *    and releases the reservation
 *
 * vitest-incompatible (node:test). Run:
 *   node --test illuci/core/orchestrate/spawn.detached.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TopologyTree, makeSpawnTool } from "./spawn.js";
import { DetachedRunRegistry } from "./detached-registry.js";

// A fake runTopology whose settlement the test controls, so we can observe the IMMEDIATE
// return of a detached spawn before the child resolves.
function controllableRunTopology() {
  const calls = [];
  let resolveNext, rejectNext;
  const fn = (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId });
    return new Promise((res, rej) => { resolveNext = res; rejectNext = rej; });
  };
  return { fn, calls, resolve: (...a) => resolveNext(...a), reject: (...a) => rejectNext(...a) };
}

function instantRunTopology() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId });
    return { runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

// ─── BACK-COMPAT: detached unset -> the awaited else branch, byte-identical ───

test("BACK-COMPAT: no detached -> awaited path, returns the trace, registry untouched", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = instantRunTopology();
  const registry = new DetachedRunRegistry("s");
  // detached is NOT set on ctx -> defaults false. registry is present but must NOT be used.
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree, registry }, { runTopology: fn });
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "go" });
  assert.equal(r.ok, true);
  assert.equal(r.detached, undefined, "no detached flag on the awaited result");
  assert.equal(r.runId, "run-adversarial-debate", "the trace runId is returned, not a childRunId");
  assert.equal(r.childRunId, undefined);
  assert.equal(calls.length, 1);
  assert.equal(registry.snapshot().running, 0, "registry was never touched");
  assert.equal(registry.snapshot().settled, 0);
  assert.equal(tree.activeCount, 0, "slot committed + released on the awaited path");
  assert.equal(tree.totalChildren, 1);
});

// ─── detached: immediate return, slot held while running, freed on settle ───

test("detached returns childRunId IMMEDIATELY (before the child settles); slot held meanwhile", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const rt = controllableRunTopology();
  const registry = new DetachedRunRegistry("s");
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, detached: true, registry, carriedMandate: "OBEY THE LAW" },
    { runTopology: rt.fn },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "verify" });
  // returned WITHOUT awaiting the child
  assert.equal(r.ok, true);
  assert.equal(r.detached, true);
  assert.equal(r.status, "running");
  assert.match(r.childRunId, /^child-adversarial-debate-/);
  // the run was kicked, mandate inherited never-loosened, carried ONCE via options.mandate
  // (Condition 5 heal — the child prompt is the delegated sub-task alone, no prepend).
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0].prompt, "verify", "the child prompt is the delegated sub-task ALONE");
  assert.doesNotMatch(rt.calls[0].prompt, /OBEY THE LAW/, "mandate is not prepended into the prompt");
  assert.equal(rt.calls[0].options.mandate, "OBEY THE LAW");
  // slot is HELD while the child runs (commit/release deferred to settle)
  assert.equal(tree.activeCount, 1, "active slot held while detached run is in flight");
  assert.equal(registry.poll(r.childRunId).status, "running");
  // settle the child -> commit + release fire in the runner's .then
  rt.resolve({ runId: "real-run-9", sessionId: "s", halted: false, phases: {} });
  const snap = await registry.await(r.childRunId, { timeoutMs: 200 });
  assert.equal(snap.status, "done");
  assert.equal(snap.result.runId, "real-run-9", "the REAL runId rides the trace, distinct from childRunId");
  assert.equal(tree.activeCount, 0, "slot freed exactly once on settle");
  assert.equal(tree.totalChildren, 1, "breadth retained (committed)");
});

test("a detached run that REJECTS releases the slot (not commit); the snapshot carries the failure", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const rt = controllableRunTopology();
  const registry = new DetachedRunRegistry("s");
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, detached: true, registry },
    { runTopology: rt.fn },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "p" });
  assert.equal(tree.activeCount, 1);
  rt.reject(new Error("dispatch exploded"));
  const snap = await registry.await(r.childRunId, { timeoutMs: 200 });
  assert.equal(snap.status, "failed");
  assert.match(snap.error, /dispatch exploded/);
  assert.equal(tree.activeCount, 0, "slot freed on the rejection path");
  // never committed -> breadth rolls back (the uncommitted-release path)
  assert.equal(tree.totalChildren, 0);
});

test("detached requested but no registry -> fails closed (detached-misconfigured), releases the reservation", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = instantRunTopology();
  // detached:true but registry omitted
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree, detached: true }, { runTopology: fn });
  const r = await tool.handler({ topologyId: "x", prompt: "p" });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.reason, "detached-misconfigured");
  assert.equal(calls.length, 0, "no child kicked");
  assert.equal(tree.activeCount, 0, "reservation released");
  assert.equal(tree.totalChildren, 0);
});

test("detached still honors the bounds: a depth-exhausted reserve refuses BEFORE registering", async () => {
  const tree = new TopologyTree("s", { maxDepth: 0 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = instantRunTopology();
  const registry = new DetachedRunRegistry("s");
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree, detached: true, registry }, { runTopology: fn });
  const r = await tool.handler({ topologyId: "x", prompt: "p" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "max-depth");
  assert.equal(calls.length, 0);
  assert.equal(registry.snapshot().running, 0, "nothing registered on a bound refusal");
});

test("detached honors the gate: a denied gate refuses and releases, nothing registered", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const { fn, calls } = instantRunTopology();
  const registry = new DetachedRunRegistry("s");
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, detached: true, registry },
    { runTopology: fn, requestApproval: async () => ({ approved: false, reason: "no" }) },
  );
  const r = await tool.handler({ topologyId: "dev-team", prompt: "p" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "gate-denied");
  assert.equal(calls.length, 0);
  assert.equal(registry.snapshot().running, 0);
  assert.equal(tree.activeCount, 0);
});
