/**
 * Phase 7 — collect_topology, the collect side of the detached spawn. Hermetic: the tool is
 * driven against a real DetachedRunRegistry seeded with a controllable fake runner; no real
 * dispatch, no seat loop. Exercises the registry lane's collectTopologyTool factory in
 * runner.js directly.
 *
 * Proves:
 *  - a still-running run reports status:'running' (non-blocking poll)
 *  - waitMs>0 awaits the run and returns its trace on completion
 *  - a terminal read RELEASES the entry from the registry (the lifecycle-leak guard)
 *  - a failed run surfaces ok:false + the error; a halted child surfaces child-halted
 *  - an unknown childRunId is reported, not thrown
 *  - omitting childRunId lists this parent's detached runs (roster mode)
 *  - the childRunId key and the real trace.runId are distinct and both surfaced
 *
 * vitest-incompatible (node:test). Run:
 *   node --test illuci/core/topologies/runner.collect-topology.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTopologyTool } from "./runner.js";
import { DetachedRunRegistry } from "../orchestrate/detached-registry.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("collect: a running run reports status 'running' (non-blocking poll)", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", topologyId: "dev-team", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  const r = await tool.handler({ childRunId: "c1" });
  assert.equal(r.ok, true);
  assert.equal(r.status, "running");
  assert.equal(r.topologyId, "dev-team");
});

test("collect: waitMs awaits and returns the trace; the real runId is distinct from childRunId", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", topologyId: "dev-team", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  d.resolve({ runId: "real-run-42", halted: false, phases: {} });
  const r = await tool.handler({ childRunId: "c1", waitMs: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.status, "done");
  assert.equal(r.childRunId, "c1", "the registry key");
  assert.equal(r.runId, "real-run-42", "the real run id, surfaced separately");
  assert.equal(r.trace.runId, "real-run-42");
});

test("collect: a terminal read RELEASES the entry (lifecycle-leak guard)", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  d.resolve({ runId: "r", halted: false });
  await tool.handler({ childRunId: "c1", waitMs: 200 });
  assert.equal(reg.poll("c1").status, "unknown", "freed from the registry on the terminal read");
  assert.equal(reg.snapshot().settled, 0);
});

test("collect: a failed run surfaces ok:false + the error and releases", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  d.reject(new Error("kaboom"));
  const r = await tool.handler({ childRunId: "c1", waitMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.status, "failed");
  assert.match(r.error, /kaboom/);
  assert.equal(reg.poll("c1").status, "unknown", "freed on the terminal read");
});

test("collect: a halted child surfaces child-halted (ok:false) with the trace", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  d.resolve({ runId: "r", halted: true, haltReason: "Token budget exhausted" });
  const r = await tool.handler({ childRunId: "c1", waitMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.status, "done");
  assert.equal(r.reason, "child-halted");
  assert.match(r.haltReason, /budget/i);
});

test("collect: an unknown childRunId is reported, not thrown", async () => {
  const reg = new DetachedRunRegistry("s");
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  const r = await tool.handler({ childRunId: "ghost" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-child");
});

test("collect: omitting childRunId lists this parent's detached runs (roster mode)", async () => {
  const reg = new DetachedRunRegistry("s");
  reg.register({ childRunId: "c1", parentRunId: "p", runner: () => deferred().promise });
  reg.register({ childRunId: "c2", parentRunId: "p", runner: () => deferred().promise });
  reg.register({ childRunId: "c3", parentRunId: "other", runner: () => deferred().promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  const r = await tool.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.runs.length, 2, "only this parent's runs");
  assert.deepEqual(r.runs.map((x) => x.childRunId).sort(), ["c1", "c2"]);
});

test("collect: no registry -> ok:false no-registry (defensive)", async () => {
  const tool = collectTopologyTool({ registry: null, parentRunId: "p" });
  const r = await tool.handler({ childRunId: "c1" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-registry");
});

test("collect: waitMs<=0 is a pure non-blocking poll of a running run", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", parentRunId: "p", runner: () => d.promise });
  const tool = collectTopologyTool({ registry: reg, parentRunId: "p" });
  const r = await tool.handler({ childRunId: "c1", waitMs: 0 });
  assert.equal(r.status, "running");
  // still in the registry (not released — non-terminal)
  assert.equal(reg.poll("c1").status, "running");
});
