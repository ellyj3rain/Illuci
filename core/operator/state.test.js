/**
 * Phase 7 — operator surface lane: pure reducer + live-state builder.
 * Hermetic: synthetic emitter events only, no emitter / tree / company. node:test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduceEvent, buildLiveState } from "./state.js";

const ev = (type, payload, sessionId = "company-1", time = 0) => ({ type, payload, sessionId, time });

test("initialState is a clean, deterministic seed", () => {
  const s = initialState("company-1");
  assert.equal(s.sessionId, "company-1");
  assert.deepEqual(s.phases, { started: 0, complete: 0 });
  assert.deepEqual(s.topologies, {});
  assert.deepEqual(s.gates, []);
  assert.equal(s.eventCount, 0);
  assert.equal(s.budget, null);
});

test("reduceEvent is PURE — it never mutates the previous state", () => {
  const a = initialState("company-1");
  const b = reduceEvent(a, ev("phase_start", { phaseId: "p1" }));
  assert.notEqual(a, b, "returns a new object");
  assert.equal(a.eventCount, 0, "previous untouched");
  assert.equal(a.phases.started, 0, "previous phases untouched");
  assert.equal(b.eventCount, 1);
  assert.equal(b.phases.started, 1);
  // gates array identity is shared until a gate fires (copy-on-write), but mutating b's
  // gates must not appear on a:
  const c = reduceEvent(b, ev("gate_halt", { phaseId: "p1", reason: "needs review" }));
  assert.equal(a.gates.length, 0);
  assert.equal(c.gates.length, 1);
});

test("reduceEvent folds the full emitter vocabulary into the projection", () => {
  let s = initialState("company-1");
  s = reduceEvent(s, ev("topology_start", { topologyId: "dev-team", topologyName: "Dev Team", lineup: {} }));
  assert.equal(s.topologies["dev-team"].status, "running");
  assert.equal(s.topologies["dev-team"].topologyName, "Dev Team");

  s = reduceEvent(s, ev("phase_start", { phaseId: "p1", phaseType: "debate", seats: ["a"] }));
  s = reduceEvent(s, ev("message", { agent: "a:claude", role: "assistant", content: "hello world", tokens: 12 }));
  s = reduceEvent(s, ev("phase_complete", { phaseId: "p1", totalTokens: 100, responseCount: 1 }));
  assert.equal(s.phases.started, 1);
  assert.equal(s.phases.complete, 1);
  // single running team → message + phase tokens attributed to it
  assert.equal(s.topologies["dev-team"].lastMessage, "hello world");
  assert.equal(s.topologies["dev-team"].tokens, 112);
  assert.equal(s.topologies["dev-team"].phasesComplete, 1);
  assert.deepEqual(s.lastMessage, { agent: "a:claude", content: "hello world", tokens: 12 });

  s = reduceEvent(s, ev("budget_update", { spent: 500, limit: 1000 }));
  assert.deepEqual(s.budget, { spent: 500, limit: 1000 });

  s = reduceEvent(s, ev("gate_halt", { phaseId: "p2", reason: "operator review" }, "company-1", 3.5));
  assert.equal(s.gates.length, 1);
  assert.deepEqual(s.gates[0], { phaseId: "p2", reason: "operator review", ts: 3.5 });

  s = reduceEvent(s, ev("topology_complete", { topologyId: "dev-team", topologyName: "Dev Team", halted: false, phaseCount: 1 }));
  assert.equal(s.topologies["dev-team"].status, "complete");
  assert.equal(s.eventCount, 7);
});

test("reduceEvent marks a halted topology and records its reason", () => {
  let s = initialState("company-1");
  s = reduceEvent(s, ev("topology_start", { topologyId: "t", topologyName: "T" }));
  s = reduceEvent(s, ev("topology_complete", { topologyId: "t", halted: true, haltReason: "Token budget exhausted" }));
  assert.equal(s.topologies["t"].status, "halted");
  assert.equal(s.topologies["t"].error, "Token budget exhausted");
});

test("reduceEvent ignores unknown event types but still counts them (forward-compatible)", () => {
  let s = initialState("company-1");
  s = reduceEvent(s, ev("some_future_event", { foo: 1 }));
  s = reduceEvent(s, ev("agent_complete", { name: "T" }));
  assert.equal(s.eventCount, 2);
  assert.deepEqual(s.topologies, {});   // not projected, did not crash
});

test("reduceEvent tolerates a null/garbage event", () => {
  const s = initialState("company-1");
  assert.equal(reduceEvent(s, null), s);
  assert.equal(reduceEvent(s, 42).eventCount ?? 0, 0); // non-object → returns prev unchanged
});

test("buildLiveState folds projection + tree snapshot + nodes + awareness into one shape", () => {
  let s = initialState("company-1");
  s = reduceEvent(s, ev("topology_start", { topologyId: "dev-team", topologyName: "Dev Team" }));
  const snapshot = { sessionId: "company-1", activeCount: 2, totalChildren: 3, nodes: 4 };
  const nodes = [
    { runId: "r1", parentRunId: null, topologyId: "dev-team", active: true, childRunIds: ["r2"] },
    { runId: "r2", parentRunId: "r1", topologyId: "research-swarm", active: true, childRunIds: [] },
  ];
  const awareness = [{ id: "aw-1", company: "company-1", topologyId: "dev-team", kind: "dispatch.out", summary: "looked at the repo" }];
  const live = buildLiveState(s, snapshot, nodes, awareness);
  assert.equal(live.sessionId, "company-1");
  assert.equal(live.tree.activeCount, 2);
  assert.equal(live.tree.totalChildren, 3);
  assert.equal(live.tree.nodeCount, 4);
  assert.equal(live.teams.length, 1);
  assert.equal(live.teams[0].topologyName, "Dev Team");
  assert.equal(live.nodes.length, 2);
  assert.equal(live.awareness.length, 1);
});

test("buildLiveState degrades gracefully with null tree/nodes/awareness", () => {
  const s = initialState("company-1");
  const live = buildLiveState(s, null, null, null);
  assert.equal(live.tree.activeCount, 0);
  assert.deepEqual(live.nodes, []);
  assert.deepEqual(live.awareness, []);
  assert.deepEqual(live.teams, []);
});
