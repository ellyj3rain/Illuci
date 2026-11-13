// Phase F harden — STRESS: a 64-member company pool + a 32-child spawn-storm.
//
// Drives the REAL public orchestration surfaces — runCompany (Phase 4), the TopologyTree
// + makeSpawnTool + getOrCreateTree/disposeTree (Phase 5) — with a hermetic runTopology
// injected via deps (no model/bridge/fs). Read-only on the modules.
//
// Hardened contract asserted:
//   - every member of a 64-wide pool SETTLES (none stranded), the company reaches a
//     terminal aggregate, and completion is BOUNDED (no deadlock);
//   - a 32-child spawn-storm against one TopologyTree completes with the tree's active
//     slots fully released (no leaked slot), cumulative breadth EXACTLY the child count,
//     and the per-session tree disposes cleanly;
//   - an ADVERSARIAL storm (children that throw / halt mid-flight) still releases every
//     reserved slot — the runaway brake never leaks under failure.
//
// The throttle-integrated company (last test) is the fail-now lever: members acquire a
// REAL throttle slot, so against the un-hardened busy-poll the company blows its time
// bound and times acquires out (→ halted members); the hardened wakeup path completes
// fast with zero throttle timeouts. Written to the intended post-harden contract.
//
// node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompany } from "./company.js";
import {
  makeSpawnTool, getOrCreateTree, disposeTree, peekTree, _resetTreesForTest,
} from "./spawn.js";
import {
  acquireSlot, releaseSlot, setLimits, removeLimits,
} from "../throttle/throttle.js";

const POOL = 64;
const allowAll = () => ({ allowed: true }); // inject past the governance enforcement seam

// A hermetic runTopology that records peak concurrency and returns a real-shaped trace.
function makePoolRunner(holdMs = 3) {
  const state = { active: 0, peak: 0, runs: 0 };
  const fn = async (topologyId, lineup, prompt, options, sessionId) => {
    state.active += 1;
    if (state.active > state.peak) state.peak = state.active;
    state.runs += 1;
    await new Promise((r) => setTimeout(r, holdMs));
    state.active -= 1;
    return { runId: `run-${topologyId}`, sessionId, halted: false, phases: {} };
  };
  return { fn, state };
}

test("company: a 64-member pool all settle under one sessionId, bounded, no deadlock", async () => {
  const { fn, state } = makePoolRunner(3);
  const t0 = Date.now();
  const result = await runCompany(
    { topologies: Array.from({ length: POOL }, (_, i) => ({ topologyId: `m-${i}` })), concurrency: POOL },
    { runTopology: fn },
  );
  const elapsed = Date.now() - t0;

  assert.equal(result.status, "complete", "every member completed");
  assert.equal(result.counts.total, POOL, "all 64 members accounted for");
  assert.equal(result.counts.ok, POOL, "all 64 ok");
  assert.equal(result.members.length, POOL, "no member stranded");
  assert.ok(result.members.every((m) => typeof m.runId === "string" && m.runId), "every member captured a real runId");
  // One shared company sessionId across all members — they are bus siblings.
  assert.equal(result.sessionId, result.members[0].trace.sessionId);
  assert.ok(result.members.every((m) => m.trace.sessionId === result.sessionId), "all members share the company sessionId");
  assert.equal(state.runs, POOL, "runTopology invoked exactly once per member");
  assert.ok(elapsed < 5000, `bounded completion, no deadlock (took ${elapsed}ms)`);
});

test("company: a 64-member pool honors a clamped concurrency ceiling", async () => {
  const { fn, state } = makePoolRunner(6);
  const result = await runCompany(
    { topologies: Array.from({ length: POOL }, (_, i) => ({ topologyId: `c-${i}` })), concurrency: 8 },
    { runTopology: fn },
  );
  assert.equal(result.status, "complete");
  assert.ok(state.peak <= 8, `never more than the concurrency limit ran at once (peak ${state.peak})`);
  assert.ok(state.peak >= 1);
});

test("spawn-storm: 32 children complete, every active slot released, breadth exact, tree disposes", async () => {
  _resetTreesForTest();
  const sessionId = "stress-spawn-storm";
  const tree = getOrCreateTree(sessionId, { maxFanOut: 64, maxActive: 64, maxTotalChildren: 64, maxDepth: 3 });
  tree.registerRoot("root-run", "dev-team");

  let runs = 0;
  const runner = async (topologyId, lineup, prompt, options, parentSessionId) => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 2));
    return { runId: `run-${topologyId}-${runs}`, sessionId: parentSessionId, halted: false, phases: {} };
  };
  const tool = makeSpawnTool(
    { sessionId, parentRunId: "root-run", tree, seat: "architect", model: "claude-local" },
    { runTopology: runner, enforceDispatch: allowAll },
  );

  const CHILDREN = 32;
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: CHILDREN }, (_, i) => tool.handler({ topologyId: `child-${i}`, prompt: `task ${i}` })),
  );
  const elapsed = Date.now() - t0;

  assert.equal(results.filter((r) => r.ok).length, CHILDREN, "all 32 children completed ok");
  assert.equal(runs, CHILDREN, "runTopology invoked once per child");
  assert.equal(tree.activeCount, 0, "every reserved active slot was released (no leaked slot)");
  assert.equal(tree.totalChildren, CHILDREN, "cumulative breadth brake equals the child count, exactly");
  assert.ok(elapsed < 5000, `bounded completion, no deadlock (took ${elapsed}ms)`);

  assert.equal(disposeTree(sessionId), undefined); // disposeTree returns void; the assertion is that it does not throw
  assert.equal(peekTree(sessionId), null, "tree disposed — peek finds nothing, no orphan left in the registry");
});

test("spawn-storm: an adversarial throw/halt storm still releases every reserved slot", async () => {
  _resetTreesForTest();
  const sessionId = "stress-spawn-adversarial";
  const tree = getOrCreateTree(sessionId, { maxFanOut: 64, maxActive: 64, maxTotalChildren: 64, maxDepth: 3 });
  tree.registerRoot("root", "dev-team");

  // 1/4 throw, 1/4 halt, 1/2 succeed.
  const runner = async (topologyId) => {
    await new Promise((r) => setTimeout(r, 1));
    if (topologyId.includes("throw")) throw new Error(`boom ${topologyId}`);
    if (topologyId.includes("halt")) return { runId: `r-${topologyId}`, halted: true, haltReason: "Token budget exhausted", phases: {} };
    return { runId: `r-${topologyId}`, halted: false, phases: {} };
  };
  const tool = makeSpawnTool(
    { sessionId, parentRunId: "root", tree, seat: "s", model: "claude-local" },
    { runTopology: runner, enforceDispatch: allowAll },
  );

  const N = 32;
  const specs = Array.from({ length: N }, (_, i) => {
    const kind = i % 4 === 0 ? "throw" : i % 4 === 1 ? "halt" : "ok";
    return `child-${kind}-${i}`;
  });
  // The handler is contracted never to throw — it returns a refusal/non-ok result. allSettled
  // is belt-and-suspenders so a single hypothetical throw cannot strand the assertion.
  const results = await Promise.allSettled(specs.map((id) => tool.handler({ topologyId: id, prompt: "p" })));

  assert.equal(results.length, N, "every spawn settled — none stranded");
  assert.ok(results.every((r) => r.status === "fulfilled"), "the spawn handler never throws, even on a throwing child");
  assert.equal(tree.activeCount, 0, "every reserved slot released despite throws/halts — the runaway brake never leaks");
  // Only the non-throwing children commit to the breadth count; a thrown child rolls its
  // reservation back (release before commit). So breadth is the count of children whose run
  // produced a trace (ok + halt), never more than the storm size.
  assert.ok(tree.totalChildren <= N, `breadth never exceeds the storm size (got ${tree.totalChildren})`);
  assert.ok(tree.totalChildren >= 1, "at least one child committed");

  disposeTree(sessionId);
});

test("company through the REAL throttle: bounded completion, zero throttle timeouts", async () => {
  // FAIL-NOW LEVER. Each member acquires a real throttle slot (limit 4). Against the
  // un-hardened busy-poll, 64 members serialized 4-at-a-time blow the time bound (seconds-
  // to-tens-of-seconds) and, under contention, time acquires out → members halt → the
  // company goes partial. The hardened wakeup path completes fast with zero timeouts and a
  // complete company. Asserted to the post-harden contract.
  const KEY = "stress-company-throttle";
  setLimits(KEY, { concurrencyLimit: 4, requestsPerMinute: 1e9, tokensPerMinute: 1e12, minDelayMs: 0 });

  let peakThrottled = 0;
  let throttled = 0;
  let throttleTimeouts = 0;
  const fn = async (topologyId, lineup, prompt, options, sessionId) => {
    try {
      await acquireSlot(KEY);
    } catch {
      throttleTimeouts += 1;
      return { runId: `run-${topologyId}`, sessionId, halted: true, haltReason: "throttle timeout", phases: {} };
    }
    throttled += 1;
    if (throttled > peakThrottled) peakThrottled = throttled;
    await new Promise((r) => setTimeout(r, 8));
    throttled -= 1;
    releaseSlot(KEY, 1);
    return { runId: `run-${topologyId}`, sessionId, halted: false, phases: {} };
  };

  const t0 = Date.now();
  const result = await runCompany(
    { topologies: Array.from({ length: POOL }, (_, i) => ({ topologyId: `tm-${i}` })), concurrency: POOL },
    { runTopology: fn },
  );
  const elapsed = Date.now() - t0;
  removeLimits(KEY);

  assert.equal(throttleTimeouts, 0, `no member's throttle acquire timed out (had ${throttleTimeouts})`);
  assert.ok(peakThrottled <= 4, `the throttle held the concurrency cap inside the company (peak ${peakThrottled})`);
  assert.equal(result.status, "complete", "all members completed — none halted on a throttle timeout");
  assert.equal(result.counts.ok, POOL, "all 64 throttled members ok");
  assert.ok(elapsed < 6000, `bounded completion through the real throttle (took ${elapsed}ms)`);
});
