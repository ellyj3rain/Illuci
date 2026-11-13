/**
 * illuci — [A17.4] Adaptive control cycle: the deterministic routing floor (node:test, hermetic)
 *
 * classifyPhaseOutcome consumes the ALREADY-classified gate outcome and decides
 * advance / loop / exit under the resolved policy + per-run state. Pure — tested
 * directly with no dispatch graph. The runner wiring (route decided once between
 * gate-classify and the emit, loop re-inserts at the cursor, exit preserves the
 * AMD-8 halt contract) is guarded lexically against runner.js source, mirroring
 * runner.gate-haltreason.test.js.
 *
 * Run: node --test core/topologies/adaptive-route.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ADAPTIVE_POLICY_DEFAULTS,
  ADAPTIVE_POLICY_HARD_CAPS,
  resolveAdaptivePolicy,
  classifyPhaseOutcome,
  buildRetryAnnotation,
  composeAdaptiveRetryInput,
  buildBranchAnnotation,
  composeAdaptiveBranchInput,
  composeAdaptiveRecurseInput,
  composeEscalationPrompt,
  interpretEscalationVerdict,
} from "./adaptive-route.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "runner.js"), "utf-8");
const LIVE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ─── Policy resolution: options beat topology beat conservative defaults ────────

test("A17.4: default policy is adaptive-capable with conservative bounds (D1)", () => {
  const p = resolveAdaptivePolicy({}, {});
  assert.deepEqual(p, { enabled: true, maxLoopsPerPhase: 1, maxTotalReroutes: 2 });
  assert.equal(ADAPTIVE_POLICY_DEFAULTS.enabled, true);
});

test("A17.4: adaptive:false pins the run linear — at either rung", () => {
  assert.equal(resolveAdaptivePolicy({ adaptive: false }, {}).enabled, false);
  assert.equal(resolveAdaptivePolicy({}, { adaptive: false }).enabled, false);
});

test("A17.4: options.adaptive beats topology.adaptive (per-run pin over spec disposition)", () => {
  assert.equal(resolveAdaptivePolicy({ adaptive: false }, { adaptive: true }).enabled, true);
  assert.equal(resolveAdaptivePolicy({ adaptive: true }, { adaptive: false }).enabled, false);
});

test("A17.4: an object policy merges over defaults and clamps to the hard caps", () => {
  const p = resolveAdaptivePolicy({}, { adaptive: { maxLoopsPerPhase: 99, maxTotalReroutes: 99 } });
  assert.equal(p.maxLoopsPerPhase, ADAPTIVE_POLICY_HARD_CAPS.maxLoopsPerPhase);
  assert.equal(p.maxTotalReroutes, ADAPTIVE_POLICY_HARD_CAPS.maxTotalReroutes);
  // negative / garbage bounds fall back safely
  const q = resolveAdaptivePolicy({}, { adaptive: { maxLoopsPerPhase: -3, maxTotalReroutes: "junk" } });
  assert.equal(q.maxLoopsPerPhase, 0);
  assert.equal(q.maxTotalReroutes, ADAPTIVE_POLICY_DEFAULTS.maxTotalReroutes);
});

// ─── The routing table: advance / loop / exit ──────────────────────────────────

const POLICY = { enabled: true, maxLoopsPerPhase: 1, maxTotalReroutes: 2 };
const FRESH = () => ({ loopsByPhase: {}, totalReroutes: 0 });

test("A17.4: a passing gate (and a gateless phase) always advances", () => {
  assert.equal(classifyPhaseOutcome({ gateStatus: "pass" }, { id: "p", gate: true }, { policy: POLICY, state: FRESH() }).route, "advance");
  assert.equal(classifyPhaseOutcome({ gateStatus: "fail", gateReason: "all-empty" }, { id: "p", gate: false }, { policy: POLICY, state: FRESH() }).route, "advance");
});

test("A17.4: a retryable fail (all-empty / seat-error) within bounds routes LOOP with the gate reason", () => {
  for (const gateReason of ["all-empty", "seat-error"]) {
    const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason }, { id: "build", gate: true }, { policy: POLICY, state: FRESH() });
    assert.equal(r.route, "loop");
    assert.equal(r.reason, gateReason);
  }
});

test("A17.4: pinned-linear exits exactly like today (adaptive-disabled)", () => {
  const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason: "all-empty" }, { id: "p", gate: true }, { policy: { ...POLICY, enabled: false }, state: FRESH() });
  assert.deepEqual(r, { route: "exit", reason: "adaptive-disabled" });
});

test("A17.4: an exhausted budget is never spent on a retry", () => {
  const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason: "seat-error" }, { id: "p", gate: true }, { policy: POLICY, state: FRESH(), budgetExhausted: true });
  assert.deepEqual(r, { route: "exit", reason: "budget-exhausted" });
});

test("A17.4/A17.9: the confidence floor exits when escalation is disabled (default)", () => {
  const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason: "systemConfidence 0.31 < min 0.6" }, { id: "p", gate: true }, { policy: POLICY, state: FRESH() });
  assert.deepEqual(r, { route: "exit", reason: "below-confidence" });
});

test("A17.4: the per-phase loop bound terminates the retry (loop-bound-exhausted)", () => {
  const state = { loopsByPhase: { build: 1 }, totalReroutes: 1 };
  const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason: "all-empty" }, { id: "build", gate: true }, { policy: POLICY, state });
  assert.deepEqual(r, { route: "exit", reason: "loop-bound-exhausted" });
});

test("A17.4: the whole-run reroute bound terminates cross-phase ping-pong (reroute-bound-exhausted)", () => {
  const state = { loopsByPhase: { other: 2 }, totalReroutes: 2 };
  const r = classifyPhaseOutcome({ gateStatus: "fail", gateReason: "seat-error" }, { id: "build", gate: true }, { policy: POLICY, state });
  assert.deepEqual(r, { route: "exit", reason: "reroute-bound-exhausted" });
});

test("A17.4: the table is pure — inputs are never mutated", () => {
  const phaseResult = Object.freeze({ gateStatus: "fail", gateReason: "all-empty" });
  const phase = Object.freeze({ id: "p", gate: true });
  const state = Object.freeze({ loopsByPhase: Object.freeze({}), totalReroutes: 0 });
  assert.doesNotThrow(() => classifyPhaseOutcome(phaseResult, phase, { policy: POLICY, state }));
});

// ─── [A17.5] Proxy-T: the loop edge re-enters at T, not A ──────────────────────

test("A17.5: buildRetryAnnotation captures erroring seats with truncated detail", () => {
  const phaseResult = {
    responses: [
      { model: "deepseek", response: "fine" },
      { model: "kimi", error: "TIMEOUT after 300s " + "x".repeat(400) },
    ],
  };
  const a = buildRetryAnnotation(phaseResult, "seat-error", 1);
  assert.equal(a.attempt, 1);
  assert.equal(a.reason, "seat-error");
  assert.equal(a.failures.length, 1);
  assert.equal(a.failures[0].model, "kimi");
  assert.ok(a.failures[0].detail.length <= 200, "error detail must be truncated for the frame");
});

test("A17.5: buildRetryAnnotation on all-empty lists the empty seats", () => {
  const phaseResult = { responses: [{ model: "a", response: "" }, { model: "b", response: null }] };
  const a = buildRetryAnnotation(phaseResult, "all-empty", 1);
  assert.deepEqual(a.failures.map((f) => f.model), ["a", "b"]);
  assert.match(a.failures[0].detail, /empty/);
});

test("A17.5: buildRetryAnnotation caps the failure list and tolerates garbage", () => {
  const many = { responses: Array.from({ length: 20 }, (_, i) => ({ model: `m${i}`, error: "boom" })) };
  assert.equal(buildRetryAnnotation(many, "seat-error", 2).failures.length, 8);
  assert.deepEqual(buildRetryAnnotation(null || {}, "seat-error", 1).failures, []);
  assert.doesNotThrow(() => buildRetryAnnotation({ responses: [null, undefined] }, "all-empty", 1));
});

test("A17.5: composeAdaptiveRetryInput opens with the observation + think-first directive, original input verbatim below", () => {
  const original = "Build the deploy pipeline.\nUse the repo conventions.";
  const composed = composeAdaptiveRetryInput(original, {
    attempt: 1,
    reason: "seat-error",
    failures: [{ model: "kimi", detail: "TIMEOUT" }],
  });
  assert.ok(composed.startsWith("[Adaptive Retry]"), "the retry frame must open with the observation block");
  assert.match(composed, /attempt 2 of this phase/);
  assert.match(composed, /Attempt 1 failed: seat-error/);
  assert.match(composed, /- kimi: TIMEOUT/);
  assert.match(composed, /Think first/);
  assert.ok(composed.endsWith(original), "the original phase input must be preserved verbatim below the block");
});

test("A17.5: composeAdaptiveRetryInput tolerates a failure-less annotation and null input", () => {
  const composed = composeAdaptiveRetryInput(null, { attempt: 1, reason: "all-empty", failures: [] });
  assert.match(composed, /Attempt 1 failed: all-empty/);
  assert.doesNotMatch(composed, /^- /m, "no failure lines when there are none");
});

// ─── The runner wiring contract (lexical, mirrors the AMD-8 source-grep guard) ──

test("A17.4/A17.5: the runner routes ONCE, loops via an ANNOTATED re-insert, and informs the retry input", () => {
  assert.match(LIVE, /classifyPhaseOutcome\(\s*phaseResult\s*,\s*phase\s*,/,
    "the runner must route the classified gate outcome through classifyPhaseOutcome");
  assert.match(LIVE, /resolveAdaptivePolicy\(\s*topology\s*,\s*options\s*\)/,
    "the policy must resolve options-over-topology-over-defaults at run setup");
  // [A17.5] The loop route re-inserts an annotated COPY (same id + adaptiveRetry),
  // never the bare phase — the loop edge re-enters at T, not A.
  assert.match(LIVE, /cursor\.insert\(\s*\{\s*\.\.\.phase\s*,\s*adaptiveRetry:\s*buildRetryAnnotation\(/,
    "the loop route must re-insert the phase annotated with the failure observation");
  assert.doesNotMatch(LIVE, /cursor\.insert\(\s*phase\s*\)/,
    "a bare (blind) phase re-insert must not exist");
  // [A17.5] The retry's input is composed THROUGH the observation.
  assert.match(LIVE, /if\s*\(\s*phase\.adaptiveRetry\s*\)\s*\{\s*phaseInput\s*=\s*composeAdaptiveRetryInput\(\s*phaseInput\s*,\s*phase\.adaptiveRetry\s*\)/,
    "a retried phase's input must open with the failure observation");
  // The exit route preserves the AMD-8 halt contract verbatim.
  assert.match(LIVE, /trace\.haltReason\s*=\s*phaseResult\.gateReason\s*\|\|\s*["']Gate check failed["']/);
  // The gate-halt emit fires only on an exit route — a looped retry is not a halt.
  assert.match(LIVE, /if\s*\(\s*routed\.route\s*===\s*["']exit["']\s*\)\s*\{\s*emitGateHalt/,
    "emitGateHalt must be conditioned on the exit route");
  // The old unconditional fail-halt is gone (no bare gateStatus-fail break remains).
  assert.doesNotMatch(LIVE, /if\s*\(\s*phase\.gate\s*&&\s*phaseResult\.gateStatus\s*===\s*["']fail["']\s*\)\s*\{\s*trace\.halted/,
    "the unconditional gate-fail halt must be replaced by the routed switch");
});

// ─── [A17.7] Branch: the authored alternative route (DR-113 "cursor insert") ────

const FAIL_CONF = { gateStatus: "fail", gateReason: "belowConfidence(0.4<0.6)" };
const FAIL_EMPTY = { gateStatus: "fail", gateReason: "all-empty" };
const BR_PHASE = { id: "draft", gate: true, onFailBranch: "revise" };

test("A17.7: a non-retryable fail with an AUTHORED alternative routes BRANCH with the target", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, BR_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(r, { route: "branch", reason: "below-confidence", target: "revise" });
});

test("A17.7: without a declaration the confidence floor still exits (no invented routes)", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, { id: "draft", gate: true }, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(r, { route: "exit", reason: "below-confidence" });
});

test("A17.7: a retryable fail prefers LOOP; branch takes over only when the loop bound is spent", () => {
  const fresh = classifyPhaseOutcome(FAIL_EMPTY, BR_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.equal(fresh.route, "loop", "retry first — branch is not a shortcut past the retry");
  const spent = classifyPhaseOutcome(FAIL_EMPTY, BR_PHASE, {
    policy: ADAPTIVE_POLICY_DEFAULTS,
    state: { loopsByPhase: { draft: 1 } },
  });
  assert.deepEqual(spent, { route: "branch", reason: "loop-bound-exhausted", target: "revise" });
});

test("A17.7: branch fires ONCE per phase per run (no branch ping-pong)", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, BR_PHASE, {
    policy: ADAPTIVE_POLICY_DEFAULTS,
    state: { branchesByPhase: { draft: 1 } },
  });
  assert.deepEqual(r, { route: "exit", reason: "below-confidence" });
});

test("A17.7: branch respects the whole-run reroute cap and the budget/pin gates", () => {
  const capped = classifyPhaseOutcome(FAIL_CONF, BR_PHASE, {
    policy: ADAPTIVE_POLICY_DEFAULTS,
    state: { totalReroutes: ADAPTIVE_POLICY_DEFAULTS.maxTotalReroutes },
  });
  assert.equal(capped.route, "exit");
  const pinned = classifyPhaseOutcome(FAIL_CONF, BR_PHASE, { policy: { ...ADAPTIVE_POLICY_DEFAULTS, enabled: false }, state: {} });
  assert.deepEqual(pinned, { route: "exit", reason: "adaptive-disabled" });
  const broke = classifyPhaseOutcome(FAIL_CONF, BR_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {}, budgetExhausted: true });
  assert.deepEqual(broke, { route: "exit", reason: "budget-exhausted" });
});

test("A17.7: a self-referential onFailBranch is not a branch (that would be a disguised loop)", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, { id: "draft", gate: true, onFailBranch: "draft" }, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(r, { route: "exit", reason: "below-confidence" });
});

test("A17.7: buildBranchAnnotation carries origin, reason, and the seat failures", () => {
  const a = buildBranchAnnotation(
    { responses: [{ model: "m1", error: "boom" }, { model: "m2", response: "ok" }] },
    "below-confidence",
    "draft",
  );
  assert.equal(a.from, "draft");
  assert.equal(a.reason, "below-confidence");
  assert.deepEqual(a.failures, [{ model: "m1", detail: "boom" }]);
});

test("A17.7: composeAdaptiveBranchInput opens with the branch observation, target input verbatim below", () => {
  const out = composeAdaptiveBranchInput("Revise the draft per the spec.", {
    from: "draft",
    reason: "below-confidence",
    failures: [{ model: "m1", detail: "boom" }],
  });
  assert.match(out, /^\[Adaptive Branch\]/);
  assert.match(out, /Phase "draft" could not pass its gate \(below-confidence\)/);
  assert.match(out, /- m1: boom/);
  assert.match(out, /Think first/);
  assert.ok(out.endsWith("Revise the draft per the spec."), "target input preserved verbatim at the end");
});

test("A17.7: the runner branches via an ANNOTATED insert of the AUTHORED target, and a missing target halts honestly", () => {
  // The branch route inserts the DECLARED target annotated with the origin failure.
  assert.match(LIVE, /cursor\.insert\(\s*\{\s*\.\.\.branchTarget\s*,\s*adaptiveBranch:\s*buildBranchAnnotation\(/,
    "the branch route must insert the authored target annotated with the origin failure");
  // The target resolves from the topology's AUTHORED phases only.
  assert.match(LIVE, /topology\.phases\s*\|\|\s*\[\]\)\.find\(/,
    "the branch target must resolve from the authored phase list");
  // A branched-in step's input opens with the branch observation.
  assert.match(LIVE, /else\s+if\s*\(\s*phase\.adaptiveBranch\s*\)\s*\{\s*phaseInput\s*=\s*composeAdaptiveBranchInput\(/,
    "a branched step's input must open with the branch observation");
  // A missing target is an honest halt carrying the route reason.
  assert.match(LIVE, /branch-target-missing/,
    "a missing branch target must halt honestly, never advance silently");
  // Branch state is tracked per phase (the once-per-phase guard's substrate).
  assert.match(LIVE, /branchesByPhase/, "the runner must track branches per phase");
});

// ─── [A17.8] Recurse: the authored deeper decomposition (DR-113 "recurse (spawn/tree)") ──

const RC_PHASE = { id: "spec", gate: true, onFailRecurse: "dev-team" };

test("A17.8: a non-retryable fail with an authored onFailRecurse routes RECURSE with the topology target", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, RC_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(r, { route: "recurse", reason: "below-confidence", target: "dev-team" });
});

test("A17.8: recurse takes over only when the loop bound is spent (retry stays preferred)", () => {
  const fresh = classifyPhaseOutcome(FAIL_EMPTY, RC_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.equal(fresh.route, "loop");
  const spent = classifyPhaseOutcome(FAIL_EMPTY, RC_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { loopsByPhase: { spec: 1 } } });
  assert.deepEqual(spent, { route: "recurse", reason: "loop-bound-exhausted", target: "dev-team" });
});

test("A17.8: branch is preferred over recurse when a phase authors BOTH (cost-ordered floor)", () => {
  const both = { id: "spec", gate: true, onFailBranch: "revise", onFailRecurse: "dev-team" };
  const r = classifyPhaseOutcome(FAIL_CONF, both, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(r, { route: "branch", reason: "below-confidence", target: "revise" });
});

test("A17.8: recurse fires ONCE per phase per run and respects the reroute cap", () => {
  const once = classifyPhaseOutcome(FAIL_CONF, RC_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { recursesByPhase: { spec: 1 } } });
  assert.deepEqual(once, { route: "exit", reason: "below-confidence" });
  const capped = classifyPhaseOutcome(FAIL_CONF, RC_PHASE, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { totalReroutes: ADAPTIVE_POLICY_DEFAULTS.maxTotalReroutes } });
  assert.equal(capped.route, "exit");
});

test("A17.8: composeAdaptiveRecurseInput opens with the recurse observation, the problem verbatim below", () => {
  const out = composeAdaptiveRecurseInput("Design the belt-status verb.", { from: "spec", reason: "below-confidence", failures: [{ model: "m1", detail: "too shallow" }] });
  assert.match(out, /^\[Adaptive Recurse\]/);
  assert.match(out, /Phase "spec" could not resolve this directly \(below-confidence\)/);
  assert.match(out, /- m1: too shallow/);
  assert.match(out, /your result becomes that phase's output/);
  assert.ok(out.endsWith("Design the belt-status verb."), "the problem is preserved verbatim");
});

test("A17.8: the runner recurses via conveneChildTopology, folds the child product, and advances (no re-insert)", () => {
  // The recurse arm calls the injectable executor (default conveneChildTopology).
  assert.match(LIVE, /const recurse\s*=\s*options\.recurseFn\s*\|\|\s*conveneChildTopology/,
    "the runner must route recurse through the injectable conveneChildTopology executor");
  // The child seed opens with the origin failure (T re-entry).
  assert.match(LIVE, /composeAdaptiveRecurseInput\(\s*phaseInput\s*,\s*buildBranchAnnotation\(/,
    "the child seed must open with the origin-failure observation");
  // The recursing run is a tree node (depth/cycle bounded), registered idempotently.
  assert.match(LIVE, /if\s*\(\s*!tree\.nodes\.has\(runId\)\s*\)\s*tree\.registerRoot\(runId, topologyId\)/,
    "the recursing run must be a tree node so reserve() can find it, registered idempotently");
  // The folded result substitutes for the phase and the run advances (no cursor.insert on recurse).
  assert.match(LIVE, /trace\.phases\[phase\.id\]\s*=\s*folded/,
    "the sub-run's product must become the phase's result");
  assert.match(LIVE, /recursed:\s*\{\s*topologyId:\s*routed\.target/,
    "the folded result must carry recursion provenance");
  // A refusal or halted sub-run is an honest halt, not a silent advance.
  assert.match(LIVE, /recurse-refused:/,
    "a refused/halted recursion must halt honestly");
  assert.match(LIVE, /recursesByPhase/, "the runner must track recursions per phase (the once-per-phase substrate)");
});

// ─── [A17.9] Escalation: the review-seat judgment layer (DR-113 "review-seat model judgment") ──

const ESC_ON = { policy: ADAPTIVE_POLICY_DEFAULTS, state: {}, escalation: true };
const PLAIN_GATED = { id: "assess", gate: true }; // no authored branch/recurse

test("A17.9: an ambiguous fail with escalation ENABLED and no authored route routes ESCALATE", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, ESC_ON);
  assert.deepEqual(r, { route: "escalate", reason: "below-confidence" });
});

test("A17.9: escalation is OFF by default — the same case exits byte-identically (D1)", () => {
  const off = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {} });
  assert.deepEqual(off, { route: "exit", reason: "below-confidence" });
  const explicitlyOff = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {}, escalation: false });
  assert.deepEqual(explicitlyOff, { route: "exit", reason: "below-confidence" });
});

test("A17.9: authored routes are preferred over a judgment dispatch (branch/recurse before escalate)", () => {
  const branched = classifyPhaseOutcome(FAIL_CONF, { id: "assess", gate: true, onFailBranch: "revise" }, ESC_ON);
  assert.deepEqual(branched, { route: "branch", reason: "below-confidence", target: "revise" });
  const recursed = classifyPhaseOutcome(FAIL_CONF, { id: "assess", gate: true, onFailRecurse: "dev-team" }, ESC_ON);
  assert.deepEqual(recursed, { route: "recurse", reason: "below-confidence", target: "dev-team" });
});

test("A17.9: a retryable fail still LOOPS first — escalation is not a shortcut past the retry", () => {
  const r = classifyPhaseOutcome(FAIL_EMPTY, PLAIN_GATED, ESC_ON);
  assert.equal(r.route, "loop");
});

test("A17.9: retries exhausted with escalation on escalates the give-up (loop-bound-exhausted)", () => {
  const r = classifyPhaseOutcome(FAIL_EMPTY, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { loopsByPhase: { assess: 1 } }, escalation: true });
  assert.deepEqual(r, { route: "escalate", reason: "loop-bound-exhausted" });
});

test("A17.9: escalation fires ONCE per phase per run (no judgment ping-pong)", () => {
  const r = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { escalationsByPhase: { assess: 1 } }, escalation: true });
  assert.deepEqual(r, { route: "exit", reason: "below-confidence" });
});

test("A17.9: escalation cannot override the hard exits (pin / budget / reroute cap)", () => {
  const pinned = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: { ...ADAPTIVE_POLICY_DEFAULTS, enabled: false }, state: {}, escalation: true });
  assert.deepEqual(pinned, { route: "exit", reason: "adaptive-disabled" });
  const broke = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: {}, escalation: true, budgetExhausted: true });
  assert.deepEqual(broke, { route: "exit", reason: "budget-exhausted" });
  const capped = classifyPhaseOutcome(FAIL_CONF, PLAIN_GATED, { policy: ADAPTIVE_POLICY_DEFAULTS, state: { totalReroutes: ADAPTIVE_POLICY_DEFAULTS.maxTotalReroutes }, escalation: true });
  assert.equal(capped.route, "exit");
});

test("A17.9: interpretEscalationVerdict parses a structured retry-with-directive and a bare exit", () => {
  assert.deepEqual(
    interpretEscalationVerdict('The output is thin. {"verdict":"retry","directive":"cite the spec section for each claim"}'),
    { verdict: "retry", directive: "cite the spec section for each claim" },
  );
  assert.deepEqual(interpretEscalationVerdict('{"verdict":"exit"}'), { verdict: "exit", directive: null });
});

test("A17.9: interpretEscalationVerdict falls back to keywords, then to an honest exit", () => {
  assert.deepEqual(interpretEscalationVerdict("RETRY: tighten the acceptance criteria"), { verdict: "retry", directive: "tighten the acceptance criteria" });
  assert.deepEqual(interpretEscalationVerdict("I recommend we EXIT this run."), { verdict: "exit", directive: null });
  assert.deepEqual(interpretEscalationVerdict("some unparseable prose with no verdict"), { verdict: "exit", directive: null, reason: "unparseable-judgment" });
  assert.deepEqual(interpretEscalationVerdict(null), { verdict: "exit", directive: null, reason: "unparseable-judgment" });
});

test("A17.9: interpretEscalationVerdict clips an overlong directive and tolerates a non-string directive", () => {
  const long = interpretEscalationVerdict(JSON.stringify({ verdict: "retry", directive: "x".repeat(1000) }));
  assert.equal(long.verdict, "retry");
  assert.ok(long.directive.length <= 500, "directive must be clipped for the frame");
  const bad = interpretEscalationVerdict(JSON.stringify({ verdict: "retry", directive: 42 }));
  assert.deepEqual(bad, { verdict: "retry", directive: null });
});

test("A17.9: composeEscalationPrompt frames the failure + the BOUNDED judgment ask", () => {
  const out = composeEscalationPrompt(
    { from: "assess", reason: "below-confidence", failures: [{ model: "m1", detail: "too shallow" }] },
    { id: "assess" },
    "below-confidence",
  );
  assert.match(out, /^\[Escalation Review\]/);
  assert.match(out, /Phase "assess" could not pass its gate \(below-confidence\)/);
  assert.match(out, /- m1: too shallow/);
  assert.match(out, /INDEPENDENT reviewer/);
  assert.match(out, /"verdict": "retry"/);
  assert.match(out, /"verdict": "exit"/);
});

test("A17.9: composeAdaptiveRetryInput renders a reviewer directive, and is byte-identical without one", () => {
  const base = { attempt: 1, reason: "below-confidence", failures: [{ model: "m1", detail: "thin" }] };
  const directed = composeAdaptiveRetryInput("Do the thing.", { ...base, directive: "cite the spec" });
  assert.match(directed, /Reviewer guidance \(escalation\): cite the spec/);
  // Without a directive the frame must match today's proxy-T output exactly.
  const plain = composeAdaptiveRetryInput("Do the thing.", base);
  const plainNullDirective = composeAdaptiveRetryInput("Do the thing.", { ...base, directive: null });
  assert.equal(plain, plainNullDirective, "a null/absent directive must not change the retry frame");
  assert.doesNotMatch(plain, /Reviewer guidance/);
});

test("A17.9: the runner performs the escalate route via an injectable reviewer, homes the directive, and exits honestly", () => {
  // The escalate arm dispatches through the injectable reviewer (default = escalationDispatch).
  assert.match(LIVE, /const escalateFn\s*=\s*options\.escalateFn/,
    "the reviewer dispatch must be injectable via options.escalateFn");
  assert.match(LIVE, /escalationDispatch\(modelId, prompt\)/,
    "the default reviewer executor must be a raw meta-dispatch");
  // The raw judgment is interpreted through the pure bounded interpreter.
  assert.match(LIVE, /verdict\s*=\s*interpretEscalationVerdict\(raw\)/,
    "the reviewer's raw judgment must pass through interpretEscalationVerdict");
  // A retry verdict re-inserts the phase carrying the reviewer's directive (the explicit think-step).
  assert.match(LIVE, /adaptiveRetry:\s*\{\s*\.\.\.buildRetryAnnotation\([^)]*\),\s*directive:\s*verdict\.directive\s*\}/,
    "a retry verdict must re-insert the phase with the reviewer's directive homed on the retry");
  // An exit verdict halts honestly, carrying the judgment as the route reason.
  assert.match(LIVE, /escalation-exit:/,
    "an exit verdict must halt honestly with the judgment as the route reason");
  // Escalation state is tracked per phase (the once-per-phase substrate) and threaded to the classifier.
  assert.match(LIVE, /escalationsByPhase/, "the runner must track escalations per phase");
  assert.match(LIVE, /escalation:\s*escalationEnabled/, "the enablement flag must reach classifyPhaseOutcome");
  // Enablement is OFF by default: gated on an explicit opt-in AND a resolvable reviewer (default = anchor).
  assert.match(LIVE, /escalationReviewer\s*=\s*options\.escalationReviewer\s*\|\|\s*anchorModelId/,
    "the reviewer must default to the run's anchor model");
  assert.match(LIVE, /escalationEnabled\s*=\s*\(options\.escalate === true\s*\|\|\s*!!options\.escalationReviewer\)/,
    "escalation must be off unless explicitly opted into for the run");
});
