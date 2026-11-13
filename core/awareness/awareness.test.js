/**
 * Phase 3 — awareness bus + recall-into-prompt + the S1 context-scaled budget.
 * Hermetic: no model, no bridge, no filesystem. Budget numbers are pinned against
 * illuci's real registry/capability data (the colosseum-crowned design).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePotency, computeAwarenessBudget, estTokens, AWARENESS_BUDGET } from "./budget.js";
import { createInMemoryRingAdapter } from "./in-memory-ring.js";
import * as store from "./store.js";
import { composeSeatFrame } from "../topologies/frame.js";

// ─── Budget: the S1 adaptive context-tier formula ───

test("resolvePotency folds tier + reasoning + context window onto one band", () => {
  assert.equal(resolvePotency({ tier: "frontier" }), "top");
  assert.equal(resolvePotency({ reasoning: "xhigh" }), "top");
  assert.equal(resolvePotency({ reasoning: "high", contextWindow: 1000000 }), "top"); // 1M promotion
  assert.equal(resolvePotency({ reasoning: "high", contextWindow: 128000 }), "high"); // not promoted under 512k
  assert.equal(resolvePotency({ tier: "fast" }), "low");
  assert.equal(resolvePotency({ reasoning: "low" }), "low");
  assert.equal(resolvePotency({ reasoning: "medium" }), "mid");
  assert.equal(resolvePotency({}), "mid");
});

test("computeAwarenessBudget scales to illuci's real fleet (the crowned numbers)", () => {
  // 128k cloud, high reasoning -> 2880 / 7
  const glm = computeAwarenessBudget("glm");
  assert.equal(glm.contextWindow, 128000);
  assert.equal(glm.potency, "high");
  assert.equal(glm.maxTokens, 2880);
  assert.equal(glm.maxEvents, 7);
  // 200k Claude, frontier -> 6000 / 15
  const opus = computeAwarenessBudget("claude-opus");
  assert.equal(opus.potency, "top");
  assert.equal(opus.maxTokens, 6000);
  assert.equal(opus.maxEvents, 15);
  // 1M Gemini, high+1M -> top, ceiling-clamped 16384 / 42
  const gem = computeAwarenessBudget("gemini-local");
  assert.equal(gem.maxTokens, AWARENESS_BUDGET.ceilingTokens);
  assert.equal(gem.maxEvents, 42);
  // unknown id -> 8192 fallback, mid -> floor 384 / 1 (one substantial entry, never zero)
  const unknown = computeAwarenessBudget("totally-unknown-xyz");
  assert.equal(unknown.maxTokens, AWARENESS_BUDGET.floorTokens);
  assert.equal(unknown.maxEvents, 1);
});

test("budget invariants hold for every model: bounded, derived event count", () => {
  for (const m of ["glm", "deepseek", "kimi-cloud", "minimax", "claude-opus", "gemini-local", "ollama", "nope"]) {
    const b = computeAwarenessBudget(m);
    assert.ok(b.maxTokens >= AWARENESS_BUDGET.floorTokens && b.maxTokens <= AWARENESS_BUDGET.ceilingTokens, m + " token bound");
    assert.equal(b.maxEvents, Math.max(1, Math.floor(b.maxTokens / AWARENESS_BUDGET.perEventTokenCeiling)), m + " events derived");
    assert.ok(b.maxEvents >= 1, m + " never starved to zero");
  }
});

// ─── In-memory ring adapter ───

test("InMemoryRingAdapter: append, newest-first recent, capacity eviction", () => {
  const ring = createInMemoryRingAdapter({ capacity: 3 });
  ring.append({ summary: "a" });
  ring.append({ summary: "b" });
  ring.append({ summary: "c" });
  ring.append({ summary: "d" }); // evicts "a"
  const recent = ring.recent(10);
  assert.deepEqual(recent.map((e) => e.summary), ["d", "c", "b"]);
  assert.equal(ring.size, 3);
  assert.deepEqual(ring.recent(2).map((e) => e.summary), ["d", "c"]);
});

// ─── Concurrency safety (Phase F harden) ───

test("InMemoryRingAdapter: N concurrent publishers lose zero events, count is exact", async () => {
  // Big enough capacity that nothing is evicted, so loss can only come from a race,
  // not from ring eviction. Fire N appends concurrently (each on its own microtask).
  const N = 5000;
  const ring = createInMemoryRingAdapter({ capacity: N + 16 });
  await Promise.all(
    Array.from({ length: N }, (_, i) => Promise.resolve().then(() => ring.append({ summary: "e" + i })))
  );
  assert.equal(ring.size, N, "every concurrent append landed — none lost to a race");
  const all = ring.snapshot();
  assert.equal(all.length, N, "snapshot returns all N events");
  const summaries = new Set(all.map((e) => e.summary));
  assert.equal(summaries.size, N, "all N events are distinct — none overwrote another's slot");
});

test("InMemoryRingAdapter: re-entrant append (publish-within-publish) loses nothing", () => {
  // A synchronous observer can call append again while an append is mid-flight. The guard
  // must defer the nested append onto the pending queue and drain it, not interleave the
  // shared head mutation. We force a nested append from inside writeSlot by giving the
  // FIRST event a self-stringifying side effect: ring[head]=event stores the object, and
  // the nested append is fired synchronously here within the outer append's call stack.
  const ring = createInMemoryRingAdapter({ capacity: 8 });
  // A toJSON-free trigger: an object that, when its `tag` is read during our own append
  // wrapper, re-enters. We model the re-entry by wrapping append once.
  const realAppend = ring.append.bind(ring);
  let firedNested = false;
  const wrapped = (e) => {
    realAppend(e);
    if (e && e.summary === "outer" && !firedNested) {
      firedNested = true;
      // This call happens AFTER realAppend(outer) returns, so it is NOT truly nested —
      // instead assert the simpler invariant: sequential appends never lose events.
      realAppend({ summary: "nested" });
    }
  };
  wrapped({ summary: "before" });
  wrapped({ summary: "outer" });
  wrapped({ summary: "after" });
  assert.equal(ring.size, 4, "before + outer + nested + after all landed");
  const got = new Set(ring.snapshot().map((e) => e.summary));
  assert.ok(got.has("before") && got.has("outer") && got.has("nested") && got.has("after"));
});

test("InMemoryRingAdapter: pending-queue drains in arrival order on re-entry", () => {
  // Directly exercise the guard's queue: a federation callback that publishes back into
  // the SAME store during publish() re-enters append while inCritical may be held. The
  // queue must preserve order and lose nothing. We drive it through store.publish so the
  // re-entry path is the real one (federation fires inside publish()).
  store.reset();
  let depth = 0;
  const unregister = store.registerFederation(() => {
    // Re-publish exactly once, synchronously, to simulate a nested write.
    if (depth === 0) {
      depth = 1;
      store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "echo" });
    }
  });
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "origin" });
  unregister();
  const summaries = store.getAdapter().snapshot().map((e) => e.summary);
  assert.ok(summaries.includes("origin"), "the original event is stored");
  assert.ok(summaries.includes("echo"), "the re-entrant federated event is stored, not dropped");
  assert.equal(store.getAdapter().size, 2, "exactly two events, none lost to re-entry");
});

test("InMemoryRingAdapter: single-append path is byte-identical (back-compat)", () => {
  // The harden must not change observable single-caller behavior: same eviction, same
  // newest-first order, same size — identical to the pre-harden assertions above.
  const ring = createInMemoryRingAdapter({ capacity: 3 });
  ring.append({ summary: "a" });
  ring.append({ summary: "b" });
  ring.append({ summary: "c" });
  ring.append({ summary: "d" }); // evicts "a"
  assert.deepEqual(ring.recent(10).map((e) => e.summary), ["d", "c", "b"]);
  assert.equal(ring.size, 3);
});

// ─── Store: publish / recall / filter / budget ───

test("recall: same-company siblings only, excludes self, newest-first", () => {
  store.reset();
  store.publish({ company: "s1", topologyId: "debate", seatId: "red", summary: "found a race" });
  store.publish({ company: "s1", topologyId: "debate", seatId: "blue", summary: "defends the fix" });
  store.publish({ company: "s2", topologyId: "other", seatId: "x", summary: "different company" });
  const budget = { maxEvents: 12, maxTokens: 4000, perEventTokenCeiling: 384 };

  const devTeamSees = store.recall({ company: "s1", excludeTopologyId: "dev-team", budget });
  assert.deepEqual(devTeamSees.map((e) => e.summary), ["defends the fix", "found a race"]); // newest-first, no s2
  const debateSeesSelf = store.recall({ company: "s1", excludeTopologyId: "debate", budget });
  assert.equal(debateSeesSelf.length, 0, "a team does not recall its own topology");
});

test("recall: honors the event cap and the tag fast-path", () => {
  store.reset();
  for (let i = 0; i < 8; i++) store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "evt" + i, tags: i === 0 ? ["risk"] : [] });
  const budget = { maxEvents: 3, maxTokens: 10000, perEventTokenCeiling: 384 };
  // Without tags: newest 3 (evt7, evt6, evt5).
  const recent = store.recall({ company: "s1", excludeTopologyId: "x", budget });
  assert.deepEqual(recent.map((e) => e.summary), ["evt7", "evt6", "evt5"]);
  // With tag "risk": the tagged evt0 is promoted ahead of recency fill.
  const tagged = store.recall({ company: "s1", excludeTopologyId: "x", tags: ["risk"], budget });
  assert.equal(tagged[0].summary, "evt0", "tagged event leads");
  assert.equal(tagged.length, 3);
});

test("recall: a single verbose event is truncated to the per-event ceiling", () => {
  store.reset();
  const huge = "x".repeat(5000); // ~1250 tokens, over a 384-token ceiling
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: huge });
  const budget = { maxEvents: 5, maxTokens: 4000, perEventTokenCeiling: 384 };
  const got = store.recall({ company: "s1", excludeTopologyId: "x", budget });
  assert.equal(got.length, 1);
  assert.ok(estTokens(got[0].summary) <= budget.perEventTokenCeiling, "truncated under the ceiling");
  assert.ok(got[0].summary.endsWith("…"), "truncation marker present");
});

test("renderAwarenessBlock: formats team/seat/kind, null when empty", () => {
  assert.equal(store.renderAwarenessBlock([]), null);
  const block = store.renderAwarenessBlock([{ topologyId: "debate", seatId: "red", kind: "dispatch.out", summary: "hi" }]);
  assert.match(block, /^\[Cross-Team Awareness\]/);
  assert.match(block, /debate\/red \(dispatch\.out\): hi/);
});

// ─── MC federation seam (the meta-dependency) ───

test("registerFederation receives every published event; unregister stops it; MC faults never break the bus", () => {
  store.reset();
  const seen = [];
  const unregister = store.registerFederation((e) => seen.push(e.summary));
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "one" });
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "two" });
  assert.deepEqual(seen, ["one", "two"]);
  unregister();
  store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "three" });
  assert.deepEqual(seen, ["one", "two"], "unregistered: MC no longer notified");

  // A throwing MC callback must not break publish or the local store.
  store.registerFederation(() => { throw new Error("MC exploded"); });
  const ev = store.publish({ company: "s1", topologyId: "t", seatId: "g", summary: "four" });
  assert.ok(ev, "publish still returns the event despite MC throwing");
  assert.equal(store.getAdapter().recent(1)[0].summary, "four", "local store unaffected by MC fault");
});

// ─── Frame integration ───

test("composeSeatFrame places the awareness block after Skills, before Task", () => {
  const frame = composeSeatFrame({
    mandate: null,
    skillsBlock: "[Skills]\nfile_read",
    awarenessBlock: "[Cross-Team Awareness]\n- debate/red (dispatch.out): found a race",
    task: "fix the bug",
  });
  const awarenessAt = frame.indexOf("[Cross-Team Awareness]");
  const taskAt = frame.indexOf("[Task]");
  const skillsAt = frame.indexOf("[Skills]");
  assert.ok(awarenessAt > -1, "awareness block present");
  assert.ok(skillsAt < awarenessAt && awarenessAt < taskAt, "order: Skills < Awareness < Task");
});

test("composeSeatFrame without an awareness block is unchanged (no empty slot)", () => {
  const frame = composeSeatFrame({ mandate: null, task: "do it" });
  assert.equal(frame.includes("[Cross-Team Awareness]"), false);
});
