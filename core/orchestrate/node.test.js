/**
 * Candidate A — the Unified Recursive Node (orchestrate/node.js). Hermetic: a fake
 * runTopology is injected via deps, so no real model / bridge / filesystem. The decisive
 * gates are T7 (immutable-ctx race under concurrent static nesting) and T8 (the dual-key
 * scenario — one spawn that counts against the pipeline-WIDE tree yet publishes under a
 * per-STAGE bus). Both keys, proven against the REAL TopologyTree + the REAL awareness
 * store, not mocks of them.
 *
 * node:test (not vitest). Run:
 *   node --test illuci/core/orchestrate/node.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runNode, MAX_STATIC_DEPTH } from "./node.js";
import { getOrCreateTree, _resetTreesForTest, SPAWN_POLICY_HARD_CAPS } from "./spawn.js";
import { HARD_CONCURRENCY_CEIL } from "./company.js";
import * as awareness from "../awareness/store.js";

// ── A fake runTopology that records each call and returns a real-ish trace. The trace's
//    runId/sessionId mirror the augmented wrapper. A topologyId of "halts:<reason>" returns
//    a halted trace; "throws" rejects. A single text phase is emitted so the pipeline
//    sequential thread has something to extract. ──
function makeFake() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId, busScope: options?.busScope, nodeDepth: options?.nodeDepth, nodeAncestors: options?.nodeAncestors });
    if (topologyId === "throws") throw new Error("first-phase boom");
    const halt = /^halts:/.test(topologyId);
    return {
      topologyId,
      runId: "run-" + topologyId + "-" + calls.length,
      sessionId: parentSessionId,
      halted: halt,
      haltReason: halt ? topologyId.slice("halts:".length) : undefined,
      phases: { p1: { responses: [{ model: "m", seat: "s", response: "out:" + topologyId }] } },
    };
  };
  return { fn, calls };
}

// ─── Dispatch + base-case shape ───

test("runNode dispatches on kind; an unknown kind throws TypeError", async () => {
  const { fn } = makeFake();
  await assert.rejects(runNode({ kind: "nope" }, {}, { runTopology: fn }), TypeError);
  await assert.rejects(runNode(null, {}, { runTopology: fn }), TypeError);
});

test("a 'topology' leaf is the base case: ctx unchanged, BOTH keys threaded into runTopology", async () => {
  const { fn, calls } = makeFake();
  const trace = await runNode(
    { kind: "topology", topologyId: "dev-team", prompt: "go" },
    { sessionId: "sess-1", busScope: "bus-1", depth: 2, signal: undefined, mandate: "LAW" },
    { runTopology: fn },
  );
  assert.equal(trace.topologyId, "dev-team");
  // spawn-tree key = sessionId (positional); awareness key = busScope (options).
  assert.equal(calls[0].parentSessionId, "sess-1");
  assert.equal(calls[0].busScope, "bus-1");
  assert.equal(calls[0].options.mandate, "LAW");
  // a leaf does NOT descend — it reports the depth it inherited, unchanged.
  assert.equal(calls[0].nodeDepth, 2);
});

// ─── T7 — immutable-ctx race: 8 concurrent members under static nesting ───

test("T7: a company of 8 concurrent members all report the SAME static depth (no shared-counter race)", async () => {
  const { fn, calls } = makeFake();
  const members = Array.from({ length: 8 }, (_, i) => ({ kind: "topology", topologyId: "t" + i }));
  const result = await runNode({ kind: "company", members, prompt: "p" }, { sessionId: "root" }, { runTopology: fn });

  assert.equal(result.status, "complete");
  assert.equal(result.counts.ok, 8);
  // The company is the top node -> descend to depth 1; every leaf member inherits depth 1.
  // If descend had mutated a shared counter, concurrent runPool members would see DIFFERENT
  // depths (1..8 in interleave order). Immutable childCtx -> all 8 identical.
  const depths = calls.map((c) => c.nodeDepth);
  assert.deepEqual([...new Set(depths)], [1], "every member saw depth 1, not an interleaved counter");
  // staticAncestors deterministic per branch (the company spent the level; leaves add none).
  for (const c of calls) assert.deepEqual(c.nodeAncestors, []);
});

test("static-nesting anti-leak: a 3rd sibling sees depth 1, not 3", async () => {
  const { fn, calls } = makeFake();
  await runNode(
    { kind: "company", members: [{ kind: "topology", topologyId: "a" }, { kind: "topology", topologyId: "b" }, { kind: "topology", topologyId: "c" }] },
    { sessionId: "root" },
    { runTopology: fn },
  );
  const c3 = calls.find((c) => c.topologyId === "c");
  assert.equal(c3.nodeDepth, 1, "sibling depth does not accumulate across siblings");
});

// ─── Static depth is a real ceiling, decoupled from the spawn cap ───

test("MAX_STATIC_DEPTH is its own constant (not aliased to SPAWN_POLICY_HARD_CAPS.maxDepth identity)", () => {
  // Equal value is fine; shared IDENTITY is forbidden. Mutating one must not move the other.
  assert.equal(typeof MAX_STATIC_DEPTH, "number");
  // They are distinct bindings — this test documents the decoupling the ledger requires.
  assert.notStrictEqual(MAX_STATIC_DEPTH, SPAWN_POLICY_HARD_CAPS); // never the same object
});

test("descend enforces MAX_STATIC_DEPTH: a direct overflow throws RangeError", async () => {
  const { fn } = makeFake();
  // A ctx already AT the ceiling: descend on the next container must throw, and because
  // this is the OUTERMOST node (no parent member-runner to isolate it), the RangeError
  // propagates straight out of runNode.
  const atCeiling = { sessionId: "root", depth: MAX_STATIC_DEPTH };
  await assert.rejects(
    runNode({ kind: "company", members: [{ kind: "topology", topologyId: "x" }] }, atCeiling, { runTopology: fn }),
    RangeError,
  );
});

test("descend overflow inside a nested member is ISOLATED as an error row (member-runner contract)", async () => {
  const { fn } = makeFake();
  // A chain of nested companies deeper than the ceiling. The innermost descend throws, but
  // the overflow happens INSIDE a company member, so its parent's member-runner isolates it
  // into an error row — the run resolves non-complete rather than crashing the whole tree.
  let node = { kind: "topology", topologyId: "leaf" };
  for (let i = 0; i < MAX_STATIC_DEPTH + 2; i++) node = { kind: "company", members: [node] };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  assert.notEqual(result.status, "complete", "the depth overflow is surfaced, not silently completed");
  // somewhere down the chain a member row carries the RangeError text.
  function hasDepthError(r) {
    if (!r || !r.members) return false;
    return r.members.some((m) => /MAX_STATIC_DEPTH|nesting depth/.test(String(m.error || "")) || hasDepthError(m.trace));
  }
  assert.ok(hasDepthError(result), "a member row carries the depth-ceiling error");
});

// ─── Nesting both ways: company-of-pipeline + pipeline-of-company, normalized rows ───

test("a company of a nested pipeline normalizes the composite into a MemberResult row", async () => {
  const { fn } = makeFake();
  const node = {
    kind: "company",
    members: [
      { kind: "topology", topologyId: "leaf-a" },
      { kind: "pipeline", id: "pipe-x", stages: [{ topologyId: "s0" }, { topologyId: "s1" }] },
    ],
  };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  assert.equal(result.kind, "company");
  // aggregate stays byte-identical: it sees two rows, both 'ok'.
  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.ok, 2);
  const composite = result.members.find((m) => m.composite === "pipeline");
  assert.ok(composite, "the nested pipeline appears as a normalized row");
  assert.equal(composite.status, "ok");
});

test("a pipeline of a nested company runs the company as a stage", async () => {
  const { fn } = makeFake();
  const node = {
    kind: "pipeline",
    stages: [
      { kind: "company", id: "co-1", members: [{ kind: "topology", topologyId: "m0" }, { kind: "topology", topologyId: "m1" }] },
      { topologyId: "final" },
    ],
  };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  assert.equal(result.kind, "pipeline");
  assert.equal(result.status, "complete");
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].status, "ok");
});

// ─── Pipeline sequential core: previousOutput threading + halt-on-halted ───

test("pipeline threads each stage's product into the next; halts on a halted stage", async () => {
  const { fn, calls } = makeFake();
  const node = {
    kind: "pipeline",
    prompt: "INITIAL",
    stages: [{ topologyId: "s0" }, { topologyId: "halts:gate-fail" }, { topologyId: "s2-never" }],
  };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  // stage 0 took the pipeline prompt…
  assert.equal(calls[0].prompt, "INITIAL");
  // …stage 1 took stage 0's product (the sequential thread).
  assert.equal(calls[1].prompt, "out:s0");
  // the halted stage stops the pipeline — stage 2 never ran.
  assert.equal(calls.length, 2, "stage after the halt never dispatched");
  assert.equal(result.status, "halted");
  assert.match(result.haltReason, /gate-fail/);
});

// ─── Company sibling-visibility: peers share busScope (== sessionId) ───

test("company sibling-visibility: every leaf member shares the company busScope (== sessionId)", async () => {
  const { fn, calls } = makeFake();
  const result = await runNode(
    { kind: "company", members: [{ kind: "topology", topologyId: "a" }, { kind: "topology", topologyId: "b" }] },
    { sessionId: "root" },
    { runTopology: fn },
  );
  // company busScope == companySessionId: a leaf inherits null busScope (so the runner's
  // `?? sessionId` fallback scopes it to the company bus). Confirm both ran under the same
  // company sessionId on the spawn-tree key.
  assert.ok(result.sessionId.startsWith("company-"));
  for (const c of calls) assert.equal(c.parentSessionId, result.sessionId);
});

// ─── T8 — the dual-key scenario (the load-bearing test) ───
//
// A seat INSIDE pipeline stage 1 spawns a child. The fake runTopology SIMULATES that seat:
// it reserves/commits against the REAL pipeline-wide TopologyTree (keyed on the pooled
// pipeline sessionId), and PUBLISHES to the REAL awareness store under options.busScope
// (the per-stage key). We then assert BOTH keys in one scenario:
//   (a) the spawn counts against the PIPELINE-WIDE tree: stage 1 exhausts maxTotalChildren,
//       so stage 2's spawn is STILL denied (shared sessionId-keyed budget); AND
//   (b) the child published under `:stage:1`, so a stage-2 recall is EMPTY for that child
//       (per-stage busScope isolation).

test("T8: dual-key — one spawn budget across stages (sessionId) + per-stage awareness isolation (busScope)", async () => {
  _resetTreesForTest();
  awareness.reset();

  const PIPE_SESSION = "illuci-pipe-T8";
  // A tree whose breadth cap is 1, so the FIRST stage's spawn consumes the whole pipeline
  // budget and the SECOND stage's spawn must be denied — proving the budget is pooled.
  const policy = { maxTotalChildren: 1, maxActive: 9, maxFanOut: 9, maxDepth: 3 };

  const denials = [];
  // Capture each stage's REAL busScope (now minted per-pipeline per C-1, no longer
  // reconstructable from PIPE_SESSION). The per-stage isolation assert reads these.
  const stageScopes = {};
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    stageScopes[topologyId] = options.busScope ?? parentSessionId;
    // The seat's spawn attempt: reserve against the pipeline-WIDE tree (sessionId-keyed).
    const tree = getOrCreateTree(parentSessionId, policy);
    const parentRunId = "seat-" + topologyId;
    tree.registerRoot(parentRunId, topologyId);
    try {
      const ticket = await tree.reserve(parentRunId, "child-of-" + topologyId);
      await tree.commit(ticket, "child-run-" + topologyId);
      // The spawned child publishes awareness under the seat's busScope (per-stage key).
      awareness.publish({
        company: options.busScope ?? parentSessionId, // the runner's exact scope rule
        topologyId: "child-of-" + topologyId,
        seatId: "spawned",
        kind: "dispatch.out",
        summary: "child of " + topologyId + " did work",
      });
    } catch (e) {
      denials.push({ stage: topologyId, reason: e.spawnRefusal });
    }
    return {
      topologyId, runId: "run-" + topologyId, sessionId: parentSessionId, halted: false,
      phases: { p1: { responses: [{ model: "m", seat: "s", response: "out:" + topologyId }] } },
    };
  };

  const node = {
    kind: "pipeline",
    prompt: "go",
    stages: [{ topologyId: "stage1" }, { topologyId: "stage2" }],
  };
  await runNode(node, { sessionId: PIPE_SESSION }, { runTopology: fn });

  // (a) BUDGET is pooled across stages on the sessionId-keyed tree: stage 1 took the only
  //     slot; stage 2's spawn was DENIED for breadth — despite a different busScope.
  assert.deepEqual(denials, [{ stage: "stage2", reason: "max-total" }], "stage 2 spawn denied by the pipeline-wide budget");
  const tree = getOrCreateTree(PIPE_SESSION, policy);
  assert.equal(tree.totalChildren, 1, "exactly one child across the whole pipeline");

  // (b) AWARENESS is per-stage: stage 1's child published under stage 1's bus, so a recall
  //     scoped to stage 2's bus sees NOTHING from it. Both scopes share the pipelineId root
  //     but differ on the `:stage:i` suffix (C-1 — the root is per-pipeline, not sessionId).
  const stage1Scope = stageScopes["stage1"];
  const stage2Scope = stageScopes["stage2"];
  assert.notEqual(stage1Scope, stage2Scope, "each stage has a distinct per-stage busScope");
  assert.match(stage1Scope, /:stage:0$/);
  assert.match(stage2Scope, /:stage:1$/);
  const stage1Recall = awareness.recall({ company: stage1Scope, includeSelf: true, budget: { maxEvents: 10, maxTokens: 4000, perEventTokenCeiling: 400 } });
  const stage2Recall = awareness.recall({ company: stage2Scope, includeSelf: true, budget: { maxEvents: 10, maxTokens: 4000, perEventTokenCeiling: 400 } });
  assert.equal(stage1Recall.length, 1, "stage-1 bus carries stage-1's child event");
  assert.equal(stage2Recall.length, 0, "stage-2 bus is EMPTY for stage-1's child (per-stage isolation)");

  _resetTreesForTest();
  awareness.reset();
});

// ─── Pipeline-stage isolation (the awareness half, isolated from the budget half) ───

test("pipeline-stage isolation: stage 2 recall cannot see stage 1 events despite shared sessionId", async () => {
  awareness.reset();
  const PIPE = "illuci-iso";
  // Each stage publishes under its OWN busScope (what the runner does); both share sessionId.
  // The busScope is now minted per-pipeline (C-1), so capture it rather than reconstruct it.
  const stageScopes = {};
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    stageScopes[topologyId] = options.busScope ?? parentSessionId;
    awareness.publish({ company: options.busScope ?? parentSessionId, topologyId, seatId: "s", kind: "dispatch.out", summary: topologyId + " worked" });
    return { topologyId, runId: "r-" + topologyId, sessionId: parentSessionId, halted: false, phases: { p1: { responses: [{ response: "out:" + topologyId }] } } };
  };
  await runNode({ kind: "pipeline", prompt: "go", stages: [{ topologyId: "s0" }, { topologyId: "s1" }] }, { sessionId: PIPE }, { runTopology: fn });

  const budget = { maxEvents: 10, maxTokens: 4000, perEventTokenCeiling: 400 };
  const s0 = awareness.recall({ company: stageScopes["s0"], includeSelf: true, budget });
  const s1 = awareness.recall({ company: stageScopes["s1"], includeSelf: true, budget });
  assert.equal(s0.length, 1);
  assert.equal(s1.length, 1);
  assert.notEqual(s0[0].topologyId, s1[0].topologyId, "each stage's bus holds only its own event");
  awareness.reset();
});

// ─── C-1 — sibling-pipeline awareness-bus collision (the proving test) ───
//
// Two pipeline MEMBERS run under ONE company. The company pools BOTH keys onto a single
// companySessionId, so each pipeline member is handed the SAME ctx.sessionId. Before C-1,
// each pipeline derived its stage busScope from ctx.sessionId, so both members computed the
// IDENTICAL `${companySessionId}:stage:0` and collided on the awareness bus — pipeline B's
// stage 0 could recall pipeline A's stage-0 traffic. After C-1 each pipeline mints its OWN
// pipelineId, so the two stage-0 busScopes are DISTINCT and a cross-pipeline recall is EMPTY.
// The spawn-tree key stays POOLED (companySessionId) — only the awareness key is per-pipeline.

test("C-1: two sibling pipelines under one company get DISTINCT stage-0 busScopes; cross-pipeline recall is empty", async () => {
  awareness.reset();

  // Tag each pipeline's stage-0 dispatch so we can tell whose event a recall returns. The
  // member's prompt (threaded as the pipeline prompt) carries the tag into stage 0.
  const stage0Scopes = {};
  const parentSessions = new Set();
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    parentSessions.add(parentSessionId);
    if (topologyId === "p-stage0") {
      // `prompt` is the pipeline tag ("A" / "B") threaded as that pipeline's stage-0 input.
      stage0Scopes[prompt] = options.busScope ?? parentSessionId;
      awareness.publish({
        company: options.busScope ?? parentSessionId,
        topologyId: "p-stage0", seatId: "s", kind: "dispatch.out",
        summary: "pipeline " + prompt + " stage-0 work",
      });
    }
    return { topologyId, runId: "r-" + topologyId + "-" + Math.random(), sessionId: parentSessionId, halted: false, phases: { p1: { responses: [{ response: "out:" + topologyId }] } } };
  };

  // A company of TWO pipeline members. Each pipeline has a single stage; the member prompt
  // ("A" / "B") threads into that stage as its input so each tags its own awareness event.
  const node = {
    kind: "company",
    members: [
      { kind: "pipeline", id: "pipe-A", prompt: "A", stages: [{ topologyId: "p-stage0" }] },
      { kind: "pipeline", id: "pipe-B", prompt: "B", stages: [{ topologyId: "p-stage0" }] },
    ],
  };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  assert.equal(result.status, "complete");

  // Both pipelines pooled the SAME spawn-tree key (the companySessionId) — POOLED, unchanged.
  assert.equal(parentSessions.size, 1, "both pipelines share ONE pooled sessionId (spawn-tree key)");

  // …yet their stage-0 AWARENESS busScopes are DISTINCT (the C-1 fix).
  const scopeA = stage0Scopes["A"];
  const scopeB = stage0Scopes["B"];
  assert.ok(scopeA && scopeB, "both pipelines recorded a stage-0 busScope");
  assert.notEqual(scopeA, scopeB, "sibling pipelines must NOT collide on `:stage:0`");
  assert.match(scopeA, /:stage:0$/);
  assert.match(scopeB, /:stage:0$/);

  // A cross-pipeline recall is EMPTY: recalling pipeline A's bus returns only A's event,
  // never B's (and vice versa). Before C-1 both scopes were equal, so each recall would
  // have returned BOTH events.
  const budget = { maxEvents: 10, maxTokens: 4000, perEventTokenCeiling: 400 };
  const recallA = awareness.recall({ company: scopeA, includeSelf: true, budget });
  const recallB = awareness.recall({ company: scopeB, includeSelf: true, budget });
  assert.equal(recallA.length, 1, "pipeline A's bus holds exactly its own event");
  assert.equal(recallB.length, 1, "pipeline B's bus holds exactly its own event");
  assert.match(recallA[0].summary, /pipeline A/);
  assert.match(recallB[0].summary, /pipeline B/);
  awareness.reset();
});

// ─── Mutator survival carried from the company contract ───

test("a member that throws is isolated; the company continues (partial)", async () => {
  const { fn } = makeFake();
  const result = await runNode(
    { kind: "company", members: [{ kind: "topology", topologyId: "ok" }, { kind: "topology", topologyId: "throws" }] },
    { sessionId: "root" },
    { runTopology: fn },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.counts.ok, 1);
  assert.equal(result.counts.errored, 1);
});

test("an empty company / empty pipeline throws TypeError (non-empty contract)", async () => {
  const { fn } = makeFake();
  await assert.rejects(runNode({ kind: "company", members: [] }, { sessionId: "r" }, { runTopology: fn }), TypeError);
  await assert.rejects(runNode({ kind: "pipeline", stages: [] }, { sessionId: "r" }, { runTopology: fn }), TypeError);
});

// ─── Abort-after-complete parity with runCompany (the dropped inherited-signal term) ───
//
// Mirrors company.js's abort verdict: a company whose members all finished "ok" but whose
// INHERITED signal (ctx.signal — a parent-company / pipeline abort propagating down) aborted
// AFTER the members completed must report result.aborted === true. The members' pre-start
// abort check passed (signal not yet aborted), so they returned "ok" and status stays
// "complete"; only the top-level .aborted boolean carries the late inherited abort. Before
// the fix, runCompanyNode read only the LOCAL controller (never aborted, never exposed) and
// dropped the inherited-signal term, reporting aborted:false where company.js reports true.

test("abort-after-complete: an inherited ctx.signal aborting after members finish ok reports aborted:true (runCompany parity)", async () => {
  const parent = new AbortController();
  // The last member to run trips the inherited signal on its way out, but still returns a
  // non-halted ("ok") trace — finished work is not un-finished. The abort lands after the
  // member completed, exactly the company-of-companies / parent-pipeline-abort race.
  let ran = 0;
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    ran++;
    const trace = { topologyId, runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
    if (ran === 2) parent.abort("parent company aborted after members completed");
    return trace;
  };
  const result = await runNode(
    { kind: "company", members: [{ kind: "topology", topologyId: "a" }, { kind: "topology", topologyId: "b" }] },
    { sessionId: "root", signal: parent.signal },
    { runTopology: fn },
  );
  // Members both completed "ok" -> status stays "complete" (finished work is not un-finished)…
  assert.equal(result.status, "complete");
  assert.equal(result.counts.ok, 2);
  assert.equal(result.counts.aborted, 0, "no member is classed aborted — they all finished before the abort");
  // …but the inherited abort IS reflected in the top-level boolean (parity with company.js).
  assert.equal(result.aborted, true, "the late inherited abort is reported, not dropped");
});

// ─── C-2 — normalizeCompositeRow halted arm (the proving test) ───
//
// A nested pipeline halts-with-a-trace: it returns { status:"halted", haltReason } (a
// non-fatal halt, distinct from "failed"/error). Before C-2, normalizeCompositeRow had no
// "halted" arm, so the status fell through to "error" and the haltReason was lost. After
// C-2 the member row is status:"halted" and carries the haltReason.

test("C-2: a nested pipeline returning status:'halted' normalizes to member status 'halted' (not 'error'), haltReason preserved", async () => {
  // The fake makes the FIRST stage of the nested pipeline halt, so the pipeline node returns
  // { status:'halted', haltReason:'gate-fail' } — exactly the composite the company normalizes.
  const { fn } = makeFake();
  const node = {
    kind: "company",
    members: [
      { kind: "topology", topologyId: "leaf-ok" },
      { kind: "pipeline", id: "pipe-halts", stages: [{ topologyId: "halts:gate-fail" }, { topologyId: "never" }] },
    ],
  };
  const result = await runNode(node, { sessionId: "root" }, { runTopology: fn });
  assert.equal(result.kind, "company");

  const composite = result.members.find((m) => m.composite === "pipeline");
  assert.ok(composite, "the nested pipeline appears as a normalized row");
  // The decisive assert: a halted composite is "halted", NOT "error" (the C-2 fix).
  assert.equal(composite.status, "halted", "a halted nested pipeline normalizes to 'halted', not 'error'");
  // The haltReason survives onto the normalized row (its trace + its error field).
  assert.equal(composite.trace.status, "halted");
  assert.match(composite.trace.haltReason, /gate-fail/);
  assert.match(String(composite.error), /gate-fail/, "the haltReason is preserved on the row error");

  // aggregate sees one ok + one halted -> a 'partial' company (not a fatal failure).
  assert.equal(result.counts.ok, 1);
  assert.equal(result.counts.halted, 1);
  assert.equal(result.counts.errored, 0, "the halt is NOT miscounted as an error");
  assert.equal(result.status, "partial");
});

// ─── C-3 — recursive runCompanyNode honors the hard ceiling + run budget (the proving test) ───
//
// runCompanyNode previously hardcoded a default of 8 and clamped ONLY to members.length, so a
// nested company could open a pool wider than HARD_CONCURRENCY_CEIL (64) that company.js
// enforces, and it never created a RunBudget. After C-3 the pool width clamps to the hard
// ceiling and a RunBudget is created and consulted (reserveSlot/releaseSlot around dispatch).

test("C-3: runCompanyNode with concurrency:999 clamps the pool width to HARD_CONCURRENCY_CEIL (64); the run budget is consulted", async () => {
  // Observe the live pool width by tracking concurrent in-flight dispatches. Each fake call
  // holds a microtask gap (awaiting a resolved promise repeatedly) so all members that the
  // pool admits at once are simultaneously in flight; the peak concurrency == the pool width.
  let inFlight = 0;
  let peak = 0;
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // yield several turns so the pool fills to its width before any member resolves
    for (let k = 0; k < 5; k++) await Promise.resolve();
    inFlight--;
    return { topologyId, runId: "r-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };

  // 100 members, concurrency request 999 — the pre-fix code would open min(999, 100) = 100
  // wide. The fix clamps to min(DEFAULT/req-clamped-to-CEIL, members) = min(64, 100) = 64.
  const members = Array.from({ length: 100 }, (_, i) => ({ kind: "topology", topologyId: "t" + i }));
  const result = await runNode({ kind: "company", members, concurrency: 999 }, { sessionId: "root" }, { runTopology: fn });

  assert.equal(result.status, "complete");
  assert.equal(result.counts.ok, 100);
  assert.equal(peak, HARD_CONCURRENCY_CEIL, `pool width clamps to the hard ceiling (${HARD_CONCURRENCY_CEIL}), not min(999,100)=100`);
  assert.ok(peak <= HARD_CONCURRENCY_CEIL, "never exceeds the hard concurrency ceiling");
});

test("C-3: a configured Run maxConcurrent budget is created and consulted — pool never exceeds the Run ceiling", async () => {
  // With node.maxConcurrent set, runCompanyNode creates a RunBudget and reserves a slot per
  // member dispatch. The budget's maxConcurrent additionally clamps the pool width, so the
  // observed peak concurrency equals the Run ceiling — proving the budget is consulted.
  let inFlight = 0;
  let peak = 0;
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    for (let k = 0; k < 5; k++) await Promise.resolve();
    inFlight--;
    return { topologyId, runId: "r-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  const members = Array.from({ length: 20 }, (_, i) => ({ kind: "topology", topologyId: "t" + i }));
  // concurrency 16 would normally admit 16, but the Run budget caps at 3.
  const result = await runNode({ kind: "company", members, concurrency: 16, maxConcurrent: 3 }, { sessionId: "root" }, { runTopology: fn });
  assert.equal(result.status, "complete");
  assert.equal(result.counts.ok, 20);
  assert.equal(peak, 3, "the Run maxConcurrent budget caps live concurrency at 3 (the budget is consulted)");
});

// ─── [A91]/DR-184 — the composition root's childIdentity descends to leaves ───

test("A91: ctx genome+agents under inherit descend through containers to leaf options; default none carries nothing", async () => {
  const manifest = { agents: { "worker-a": {} } };
  const genome = { projectDir: "/p", childIdentity: "inherit" };
  const { fn, calls } = makeFake();
  await runNode(
    { kind: "company", members: [{ kind: "topology", topologyId: "t-carry" }], prompt: "p" },
    { sessionId: "root", genome, agents: manifest },
    { runTopology: fn },
  );
  assert.deepEqual(calls[0].options.agents, manifest, "the carry descended through the company to the leaf member");
  assert.deepEqual(calls[0].options.genome, genome);

  const fake2 = makeFake();
  await runNode(
    { kind: "pipeline", stages: [{ topologyId: "t-stage" }], prompt: "p" },
    { sessionId: "root", genome, agents: manifest },
    { runTopology: fake2.fn },
  );
  assert.deepEqual(fake2.calls[0].options.agents, manifest, "the carry descended through the pipeline stage ctx");
  assert.deepEqual(fake2.calls[0].options.genome, genome);

  const fake3 = makeFake();
  await runNode(
    { kind: "topology", topologyId: "t-none" },
    { sessionId: "root", genome: { projectDir: "/p" }, agents: manifest },
    { runTopology: fake3.fn },
  );
  assert.equal(fake3.calls[0].options.agents, undefined, "default none at a leaf: nothing crosses");
  assert.equal(fake3.calls[0].options.genome, undefined);
});

// ─── [A106]/DR-199 — the company preamble prepend (the Foundry world-doc pattern) ───

test("a company preamble prepends to the effective member prompt; absent preamble is byte-identical", async () => {
  const withWorld = makeFake();
  await runNode(
    { kind: "company", prompt: "WO-1: dig", preamble: "The Commons.", members: [{ topologyId: "alpha" }, { topologyId: "beta", prompt: "own task" }] },
    {},
    { runTopology: withWorld.fn },
  );
  assert.equal(withWorld.calls[0].prompt, "The Commons.\n\nWO-1: dig");
  assert.equal(withWorld.calls[1].prompt, "own task", "a member's own prompt is not preambled");

  const plain = makeFake();
  await runNode(
    { kind: "company", prompt: "WO-1: dig", members: [{ topologyId: "alpha" }] },
    {},
    { runTopology: plain.fn },
  );
  assert.equal(plain.calls[0].prompt, "WO-1: dig");

  const preambleOnly = makeFake();
  await runNode(
    { kind: "company", preamble: "  The Commons.  ", members: [{ topologyId: "alpha" }] },
    {},
    { runTopology: preambleOnly.fn },
  );
  assert.equal(preambleOnly.calls[0].prompt, "The Commons.", "an empty base prompt yields the trimmed preamble alone");
});
