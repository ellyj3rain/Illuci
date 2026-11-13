/**
 * Phase F — the spawn-gate bounded-wait. A never-arriving operator approval must FAIL
 * CLOSED within the timeout (release the ticket, refuse the spawn), never hang the seat
 * forever. Hermetic: a hanging gate + a fake runTopology injected via deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TopologyTree, makeSpawnTool } from "./spawn.js";

const POLICY = { maxDepth: 3, maxActive: 8, maxFanOut: 8, maxTotalChildren: 16 };

test("a never-arriving approval fails CLOSED within the timeout, never hangs; no leaked slot", async () => {
  const tree = new TopologyTree("gate-timeout-s", POLICY);
  tree.registerRoot("p", "dev-team");
  let spawned = false;
  const tool = makeSpawnTool(
    { sessionId: "gate-timeout-s", parentRunId: "p", tree, gateTimeoutMs: 50 },
    {
      requestApproval: () => new Promise(() => {}),   // the operator never answers
      runTopology: async () => { spawned = true; return { runId: "x" }; },
    },
  );
  const start = Date.now();
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "x", lineup: {} });
  assert.ok(Date.now() - start < 2000, "must fail within the bound, not hang");
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.detail, /timed out/);
  assert.equal(spawned, false);                   // fail-closed: the child is never spawned
  assert.equal(tree.snapshot().activeCount, 0);   // the reserved ticket was released — no leak
});

test("a prompt approval still spawns — the timeout never interferes with a normal answer", async () => {
  const tree = new TopologyTree("gate-ok-s", POLICY);
  tree.registerRoot("p", "dev-team");
  let spawned = false;
  const tool = makeSpawnTool(
    { sessionId: "gate-ok-s", parentRunId: "p", tree, gateTimeoutMs: 5000 },
    { requestApproval: async () => ({ approved: true }), runTopology: async () => { spawned = true; return { runId: "child-1", halted: false, phases: {} }; } },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "x", lineup: {} });
  assert.ok(r && r.refused !== true, "an approved spawn is not refused");
  assert.equal(spawned, true);
});

test("a denied approval is refused (gate-denied), unaffected by the timeout wrapper", async () => {
  const tree = new TopologyTree("gate-deny-s", POLICY);
  tree.registerRoot("p", "dev-team");
  const tool = makeSpawnTool(
    { sessionId: "gate-deny-s", parentRunId: "p", tree, gateTimeoutMs: 5000 },
    { requestApproval: async () => ({ approved: false, reason: "operator said no" }), runTopology: async () => ({ runId: "x" }) },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "x", lineup: {} });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.reason, "gate-denied");
  assert.equal(tree.snapshot().activeCount, 0);
});
