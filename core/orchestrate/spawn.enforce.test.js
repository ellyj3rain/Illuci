/**
 * illuci — Spawn hard-tier policy wiring (Phase 6, node:test, hermetic via deps)
 *
 * The spawn path now runs the dispatch POLICY check (fail-closed, no prompt) after the
 * bounds reserve and before the interactive gate. Proven hermetically: enforceDispatch
 * is injected via deps (no real policy/import touched), runTopology + requestApproval
 * are fakes.
 *
 * Back-compat: with no deps.enforceDispatch injected, the handler lazy-imports the real
 * enforceDispatch, which is INERT under the default policy (allows) — so an existing
 * spawn is byte-identical (proven by spawn.test.js, which passes unchanged).
 *
 * Run: node --test illuci/core/orchestrate/spawn.enforce.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TopologyTree, makeSpawnTool } from "./spawn.js";

function fakeRunTopology() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, prompt, options, parentSessionId });
    return { runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

test("spawn HARD tier: a policy-DENIED spawn fails closed WITHOUT prompting, releases the slot", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const { fn, calls } = fakeRunTopology();
  let gateAsked = false;
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, model: "denied-model", seat: "rogue" },
    {
      runTopology: fn,
      // policy says deny — fail closed, no prompt
      enforceDispatch: () => ({ allowed: false, reason: "spawn dispatch denied by policy" }),
      requestApproval: async () => { gateAsked = true; return { approved: true }; },
    },
  );
  const r = await tool.handler({ topologyId: "dev-team", prompt: "do work" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "policy-denied");
  assert.match(r.detail, /denied by policy/);
  assert.equal(gateAsked, false, "policy denial happens BEFORE (and instead of) the interactive prompt");
  assert.equal(calls.length, 0, "no child ran");
  assert.equal(tree.activeCount, 0, "the reservation was released");
});

test("spawn HARD tier: a policy-ALLOWED spawn proceeds to the gate then the child (unchanged flow)", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, carriedMandate: "OBEY THE GZDS LAW", model: "claude-opus", seat: "architect" },
    {
      runTopology: fn,
      enforceDispatch: () => ({ allowed: true, reason: "permitted" }),
      requestApproval: async () => ({ approved: true }),
    },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "verify the design" });
  assert.equal(r.ok, true);
  assert.equal(r.runId, "run-adversarial-debate");
  // mandate still inherited never-loosened (the carried tier is unaffected by the hard tier),
  // carried ONCE via options.mandate (Condition 5 heal — no prompt-prepend double-inject).
  assert.equal(calls[0].options.mandate, "OBEY THE GZDS LAW");
  assert.doesNotMatch(calls[0].prompt, /OBEY THE GZDS LAW/, "mandate rides options, not the prompt");
});

test("spawn HARD tier: enforceDispatch is keyed on the spawn dispatch kind (spawn:true)", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  let seen = null;
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree, model: "m", seat: "arch" },
    {
      runTopology: fakeRunTopology().fn,
      enforceDispatch: (arg) => { seen = arg; return { allowed: true, reason: "ok" }; },
      requestApproval: async () => ({ approved: true }),
    },
  );
  await tool.handler({ topologyId: "dev-team", prompt: "p" });
  assert.equal(seen.modelId, "m", "the spawn's model is the policy key");
  assert.equal(seen.options.spawn, true, "the dispatch kind is spawn");
  assert.equal(seen.options.seat, "arch");
});

test("spawn BACK-COMPAT: no enforceDispatch injected -> real inert policy allows (unchanged)", async () => {
  // No deps.enforceDispatch -> the handler lazy-imports the real one, which under the
  // default (inert) policy returns allowed:true. This is the byte-identical back-compat path.
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree, model: "claude-opus" }, { runTopology: fn });
  const r = await tool.handler({ topologyId: "dev-team", prompt: "p" });
  assert.equal(r.ok, true, "inert default policy allows the spawn — existing behavior preserved");
  assert.equal(calls.length, 1);
});
