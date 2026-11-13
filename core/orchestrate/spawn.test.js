/**
 * Phase 5 — recursive spawn primitive. Hermetic: a fake runTopology + fake gate are
 * injected via deps. Covers the panopticon-audited design: the concurrency-safe
 * TopologyTree (the upgrade over the anchor — concurrent reserves must not over-allocate),
 * every fail-closed bound, the gate, and mandate-never-loosened inheritance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TopologyTree, makeSpawnTool, validatePolicy, SPAWN_POLICY_HARD_CAPS, conveneChildTopology } from "./spawn.js";

function fakeRunTopology() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId });
    return { runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

// ─── TopologyTree bounds (fail-closed) ───

test("reserve refuses past the depth budget", async () => {
  const tree = new TopologyTree("s", { maxDepth: 0 });
  tree.registerRoot("p", "dev-team");
  await assert.rejects(tree.reserve("p", "adversarial-debate"), (e) => e.spawnRefusal === "max-depth");
});

test("reserve refuses an ancestor-chain cycle", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  await assert.rejects(tree.reserve("p", "dev-team"), (e) => e.spawnRefusal === "cycle");
});

test("reserve refuses an unknown parent", async () => {
  const tree = new TopologyTree("s");
  await assert.rejects(tree.reserve("ghost", "x"), (e) => e.spawnRefusal === "unknown-parent");
});

test("reserve refuses past the Run-wide active cap", async () => {
  const tree = new TopologyTree("s", { maxActive: 1, maxFanOut: 5 });
  tree.registerRoot("p", "root");
  await tree.reserve("p", "a"); // activeCount -> 1
  await assert.rejects(tree.reserve("p", "b"), (e) => e.spawnRefusal === "max-active");
});

test("reserve refuses past the cumulative breadth cap (maxTotalChildren)", async () => {
  const tree = new TopologyTree("s", { maxTotalChildren: 1, maxActive: 9, maxFanOut: 9 });
  tree.registerRoot("p", "root");
  const t = await tree.reserve("p", "a");
  await tree.release(t); // frees active, but totalChildren stays (it was committed-or-rolled-back?) — uncommitted rolls back
  // uncommitted release rolls back totalChildren, so we must commit to keep the breadth count:
  const t2 = await tree.reserve("p", "b");
  await tree.commit(t2, "run-b");
  await tree.release(t2);
  await assert.rejects(tree.reserve("p", "c"), (e) => e.spawnRefusal === "max-total");
});

// ─── Concurrency-safety: the audited upgrade ───

test("concurrent reserves never over-allocate the active cap (serialized tree)", async () => {
  const tree = new TopologyTree("s", { maxActive: 2, maxFanOut: 9, maxTotalChildren: 9 });
  tree.registerRoot("p", "root");
  // Fire 6 reserves at once. Without the serializer they would all read activeCount=0
  // and over-allocate. With it, exactly 2 succeed and the rest hit max-active.
  const settled = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => tree.reserve("p", "child-" + i)),
  );
  const ok = settled.filter((s) => s.status === "fulfilled").length;
  const refused = settled.filter((s) => s.status === "rejected" && s.reason.spawnRefusal === "max-active").length;
  assert.equal(ok, 2, "exactly maxActive reserved");
  assert.equal(refused, 4, "the rest refused, not over-allocated");
  assert.equal(tree.activeCount, 2);
});

// ─── reserve / commit / release accounting ───

test("commit records the child + fan-out; release frees the active slot but keeps breadth", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const t = await tree.reserve("p", "dev-team");
  assert.equal(tree.activeCount, 1);
  assert.equal(tree.totalChildren, 1);
  await tree.commit(t, "run-child");
  assert.equal(tree.nodes.get("p").children.has("run-child"), true);
  assert.equal(tree.nodes.get("run-child").depthRemaining, 2);
  await tree.release(t);
  assert.equal(tree.activeCount, 0, "active slot freed");
  assert.equal(tree.totalChildren, 1, "breadth brake retained");
});

test("releasing an uncommitted reservation rolls back both counts", async () => {
  const tree = new TopologyTree("s");
  tree.registerRoot("p", "root");
  const t = await tree.reserve("p", "x");
  await tree.release(t); // never committed -> full rollback
  assert.equal(tree.activeCount, 0);
  assert.equal(tree.totalChildren, 0);
});

test("validatePolicy clamps requested bounds to the hard caps", () => {
  const p = validatePolicy({ maxDepth: 999, maxFanOut: 999, maxActive: 999, maxTotalChildren: 999 });
  assert.equal(p.maxDepth, SPAWN_POLICY_HARD_CAPS.maxDepth);
  assert.equal(p.maxFanOut, SPAWN_POLICY_HARD_CAPS.maxFanOut);
  assert.equal(p.maxActive, SPAWN_POLICY_HARD_CAPS.maxActive);
  assert.equal(p.maxTotalChildren, SPAWN_POLICY_HARD_CAPS.maxTotalChildren);
});

// ─── makeSpawnTool handler ───

test("spawn handler: reserves, spawns a bus-sibling child, inherits the mandate, releases", async () => {
  const tree = new TopologyTree("sess-1", { maxDepth: 3 });
  tree.registerRoot("parent-run", "dev-team");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool(
    { sessionId: "sess-1", parentRunId: "parent-run", tree, carriedMandate: "OBEY THE GZDS LAW", seat: "architect" },
    { runTopology: fn },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "verify the spawn design" });
  assert.equal(r.ok, true);
  assert.equal(r.runId, "run-adversarial-debate");
  // bus sibling: ran under the company sessionId
  assert.equal(calls[0].parentSessionId, "sess-1");
  assert.equal(calls[0].options.awareness, true);
  // Mandate-convention heal (colosseum Condition 5): the mandate is inherited
  // never-loosened, but carried ONCE — via options.mandate, NOT also prepended into
  // the child's prompt. The runner now honors options.mandate and renders it through
  // the single [Mandate] frame block; prepending it here would double-inject.
  assert.equal(calls[0].options.mandate, "OBEY THE GZDS LAW", "mandate rides options.mandate");
  assert.doesNotMatch(calls[0].prompt, /OBEY THE GZDS LAW/, "mandate is NOT prepended into the prompt (no double-inject)");
  assert.doesNotMatch(calls[0].prompt, /Inherited mandate/, "the old [Inherited mandate] prepend header is retired");
  assert.equal(calls[0].prompt, "verify the spawn design", "the child's prompt is the delegated sub-task ALONE");
  // depth decremented + ancestor chain extended
  assert.equal(calls[0].options.spawnContext.depthRemaining, 2);
  assert.deepEqual(calls[0].options.spawnContext.ancestorTopologyIds, ["dev-team", "adversarial-debate"]);
  // [A90]/DR-182 P1: lineage rides the context — the child's self-registration
  // links the tree, and telemetry outlives the in-memory TopologyTree.
  assert.equal(calls[0].options.spawnContext.parentRunId, "parent-run");
  // slot released, breadth retained
  assert.equal(tree.activeCount, 0);
  assert.equal(tree.totalChildren, 1);
});

test("spawn handler: a bound refusal never invokes runTopology and frees nothing it didn't take", async () => {
  const tree = new TopologyTree("s", { maxDepth: 0 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree }, { runTopology: fn });
  const r = await tool.handler({ topologyId: "x", prompt: "p" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "max-depth");
  assert.equal(calls.length, 0);
  assert.equal(tree.activeCount, 0);
});

test("spawn handler: a denied gate refuses the spawn and releases the slot", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool(
    { sessionId: "s", parentRunId: "p", tree },
    { runTopology: fn, requestApproval: async () => ({ approved: false, reason: "operator said no" }) },
  );
  const r = await tool.handler({ topologyId: "dev-team", prompt: "p" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "gate-denied");
  assert.equal(calls.length, 0, "gate denied before any child ran");
  assert.equal(tree.activeCount, 0, "reservation released");
});

test("spawn handler: a custom descriptor is gated off", async () => {
  const tree = new TopologyTree("s");
  tree.registerRoot("p", "root");
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree }, { runTopology: fakeRunTopology().fn });
  const r = await tool.handler({ topologyId: "x", descriptor: { seats: [] }, prompt: "p" });
  assert.equal(r.refused, true);
  assert.equal(r.reason, "custom-gated");
});

test("spawn handler: a halted child surfaces as a non-ok result, slot still released", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "root");
  const halting = async (topologyId, lineup, prompt, options, parentSessionId) => ({
    runId: "run-x", sessionId: parentSessionId, halted: true, haltReason: "Token budget exhausted", phases: {},
  });
  const tool = makeSpawnTool({ sessionId: "s", parentRunId: "p", tree }, { runTopology: halting });
  const r = await tool.handler({ topologyId: "dev-team", prompt: "p" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "child-halted");
  assert.match(r.haltReason, /budget/i);
  assert.equal(tree.activeCount, 0);
});

// ─── [A17.8] conveneChildTopology — the TAOR recurse executor (awaited, tree-bounded) ───

test("A17.8: conveneChildTopology reserves, runs the child sharing the session, and commits", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const fake = fakeRunTopology();
  const r = await conveneChildTopology({ tree, parentRunId: "p", topologyId: "adversarial-debate", prompt: "solve it", sessionId: "s", runTopologyFn: fake.fn });
  assert.equal(r.ok, true);
  assert.equal(r.childRunId, "run-adversarial-debate");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].topologyId, "adversarial-debate");
  assert.equal(fake.calls[0].parentSessionId, "s", "the child shares the session (tree sibling)");
  assert.equal(fake.calls[0].options.spawn, true, "the child is spawn-bounded so its own seats stay capped");
  assert.equal(fake.calls[0].options.spawnContext.depthRemaining, 2, "depth decremented from the parent");
  assert.deepEqual(fake.calls[0].options.spawnContext.ancestorTopologyIds, ["dev-team", "adversarial-debate"], "the recursing run's topology is in the child's ancestor chain (cycle guard)");
  assert.equal(fake.calls[0].options.spawnContext.parentRunId, "p", "[A90]/DR-182 P1: the recurse edge carries lineage too");
});

test("A17.8: conveneChildTopology fail-closes on a depth refusal — NOTHING runs", async () => {
  const tree = new TopologyTree("s", { maxDepth: 0 });
  tree.registerRoot("p", "dev-team");
  const fake = fakeRunTopology();
  const r = await conveneChildTopology({ tree, parentRunId: "p", topologyId: "x", prompt: "q", sessionId: "s", runTopologyFn: fake.fn });
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, "max-depth");
  assert.equal(fake.calls.length, 0, "a refused recursion never runs a child");
});

test("A17.8: conveneChildTopology fail-closes on an ancestor cycle (a topology cannot recurse into itself)", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const fake = fakeRunTopology();
  const r = await conveneChildTopology({ tree, parentRunId: "p", topologyId: "dev-team", prompt: "q", sessionId: "s", runTopologyFn: fake.fn });
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, "cycle");
  assert.equal(fake.calls.length, 0);
});

test("A17.8: a HALTED sub-run is surfaced honestly (ok:false, halted, carries the child reason)", async () => {
  const tree = new TopologyTree("s", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const fn = async () => ({ runId: "run-x", halted: true, haltReason: "sub-problem unsolved", phases: {} });
  const r = await conveneChildTopology({ tree, parentRunId: "p", topologyId: "x", prompt: "q", sessionId: "s", runTopologyFn: fn });
  assert.equal(r.ok, false);
  assert.equal(r.halted, true);
  assert.equal(r.refusal.reason, "child-halted");
  assert.match(r.refusal.detail, /sub-problem unsolved/);
});

test("A17.8: bad args fail-close without touching the tree", async () => {
  const r = await conveneChildTopology({ topologyId: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, "bad-args");
});

test("[A41]/R1: a seat-spawned child inherits the spawning seat's capability resolution (the anti-laundering binding)", async () => {
  const { TopologyTree, makeSpawnTool } = await import("./spawn.js");
  const tree = new TopologyTree("s-cap", { maxDepth: 3 });
  tree.registerRoot("p-cap", "dev-team");
  const calls = [];
  const fakeRun = async (topologyId, lineup, prompt, opts) => {
    calls.push({ topologyId, opts });
    return { runId: "child-run-cap", halted: false };
  };
  const seatResolution = Object.freeze({ capabilities: { vision: { state: "granted", via: ["g"] } } });
  const tool = makeSpawnTool(
    { sessionId: "s-cap", parentRunId: "p-cap", tree, parentCapabilityResolution: seatResolution },
    { runTopology: fakeRun },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "delegate this" });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.parentCapabilityResolution, seatResolution, "the child run carries the seat's resolution verbatim");
});

// ─── [A91]/DR-184 — the childIdentity carry crosses the spawn seam ───

test("A91: ctx.childCarry spreads into childOptions (inherit); an absent carry changes nothing", async () => {
  const manifest = { agents: { "worker-a": {} }, seatAgents: { builder: "worker-a" } };
  const genome = { projectDir: "/p", childIdentity: "inherit" };
  const tree = new TopologyTree("s-a91", { maxDepth: 3 });
  tree.registerRoot("p", "dev-team");
  const { fn, calls } = fakeRunTopology();
  const tool = makeSpawnTool(
    { sessionId: "s-a91", parentRunId: "p", tree, childCarry: { agents: manifest, genome } },
    { runTopology: fn },
  );
  const r = await tool.handler({ topologyId: "adversarial-debate", prompt: "carry check" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].options.agents, manifest, "the raw manifest crossed the seam");
  assert.deepEqual(calls[0].options.genome, genome, "the genome control crossed (grandchildren inherit)");

  const tree2 = new TopologyTree("s-a91b", { maxDepth: 3 });
  tree2.registerRoot("p", "dev-team");
  const fake2 = fakeRunTopology();
  const tool2 = makeSpawnTool({ sessionId: "s-a91b", parentRunId: "p", tree: tree2 }, { runTopology: fake2.fn });
  await tool2.handler({ topologyId: "adversarial-debate", prompt: "no carry" });
  assert.equal(fake2.calls[0].options.agents, undefined, "none/absent: no manifest crosses");
  assert.equal(fake2.calls[0].options.genome, undefined, "none/absent: no genome crosses");
});

// ─── [A92]/DR-185 — explicit-mode spawn args ───

test('A92: spawn args agents/genome are REFUSED unless childIdentity=explicit, and validated under it', async () => {
  const manifest = { agents: { 'own-a': {} } };
  const tree = new TopologyTree('s-a92', { maxDepth: 3 });
  tree.registerRoot('p', 'dev-team');
  const { fn, calls } = fakeRunTopology();

  // Not explicit -> refused loudly, nothing runs.
  const guarded = makeSpawnTool({ sessionId: 's-a92', parentRunId: 'p', tree, childIdentityState: 'inherit' }, { runTopology: fn });
  const refused = await guarded.handler({ topologyId: 'adversarial-debate', prompt: 'x', agents: manifest });
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, 'identity-not-explicit');
  assert.equal(calls.length, 0, 'nothing ran');

  // Explicit -> args thread; a bad genome arg is fail-closed.
  const tree2 = new TopologyTree('s-a92b', { maxDepth: 3 });
  tree2.registerRoot('p', 'dev-team');
  const fake2 = fakeRunTopology();
  const explicitTool = makeSpawnTool({ sessionId: 's-a92b', parentRunId: 'p', tree: tree2, childIdentityState: 'explicit' }, { runTopology: fake2.fn });
  const bad = await explicitTool.handler({ topologyId: 'adversarial-debate', prompt: 'x', genome: {} });
  assert.equal(bad.refused, true);
  assert.match(bad.detail, /projectDir/);
  const ok = await explicitTool.handler({ topologyId: 'adversarial-debate', prompt: 'x', agents: manifest, genome: { projectDir: '/own', childIdentity: 'none' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(fake2.calls[0].options.agents, manifest, 'the spawn call own manifest crossed');
  assert.equal(fake2.calls[0].options.genome.projectDir, '/own', 'the spawn call own arm crossed');
});
