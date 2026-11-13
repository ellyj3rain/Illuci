/**
 * illuci — Adaptive control cycle: the deterministic routing floor. [A17.4]/[A17.5]
 *
 * The cycle is TAOR (operator vocabulary, DR-114): Think → Act → Observe →
 * Review, with the route edge after R (loop → T | branch | recurse | escalate |
 * exit). A topology definition is a STARTING DISPOSITION, not a cage (operator
 * design law, F-075 lineage): a failed or empty phase is an observation to route
 * on, never an automatic halt. This module is the D2 hybrid's deterministic table —
 * the cheap floor that decides the obvious cases (retry a transiently-failed or
 * all-empty phase, bounded; exit honestly when bounds or budget are spent).
 *
 * [A17.9] Escalation (DR-113 "review-seat model judgment"): where the floor would
 * otherwise BLIND-EXIT a genuinely ambiguous failure (below-confidence, or retries
 * exhausted) with no cheaper authored route, an INDEPENDENT review seat judges it —
 * retry-with-a-directive or honest exit — rather than the table guessing. This is
 * the hybrid's judgment half; the deterministic escalate() ladder decides WHEN to
 * escalate (pure), the runner performs the judgment dispatch (impure, injectable).
 * OFF by default (D1): a run without an enabled reviewer exits exactly as before.
 * The reviewer's directive is DR-114's explicit think-step, homed here — it rides
 * the retried step so the retry acts on the judgment, not a blind re-roll. The
 * fire-control checkpoint (checkpoint.js) is the SEPARATE operator-pacing half.
 *
 * The loop edge re-enters at T, not A ([A17.5], DR-114 proxy-T): a retried
 * phase is never a blind re-roll — the failure observation rides the re-inserted
 * step (buildRetryAnnotation) and is prepended to the retry's input
 * (composeAdaptiveRetryInput), so the acting seats think-then-act INFORMED
 * inside the same dispatch. The explicit think-step (a separate T dispatch
 * producing a revision directive) is homed in the escalation reviewer ([A17.9]):
 * its directive rides the retried step alongside the observation. Run-start T is
 * the conducted agenda mode.
 *
 * D1: adaptive-capable BY DEFAULT with conservative bounds, so a clean run still
 * looks linear (this table is only consulted on a gate FAIL) and a pinned-linear
 * topology (`adaptive: false`, or per-run `options.adaptive: false`) keeps
 * today's halt behavior byte-identical.
 *
 * Distinct from options.adaptiveFallback (core/dispatch/adaptive-fallback.js),
 * which is the DISPATCH-level model/reasoning fallback chain for a single seat
 * call. This module routes at the TOPOLOGY level: whole-phase loop/exit (branch
 * and recurse land in later slices on the cursor/spawn seams).
 *
 * Pure and hermetic: no dispatch graph, no I/O — unit-tested directly, and the
 * runner wiring is guarded lexically (adaptive-route.test.js), mirroring the
 * AMD-8 gate-haltreason pattern.
 */

/** Conservative defaults (D1): one retry per failing phase, two reroutes per run. */
export const ADAPTIVE_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  maxLoopsPerPhase: 1,
  maxTotalReroutes: 2,
});

/** Hard caps a policy object cannot exceed (mirrors SPAWN_POLICY_HARD_CAPS). */
export const ADAPTIVE_POLICY_HARD_CAPS = Object.freeze({
  maxLoopsPerPhase: 3,
  maxTotalReroutes: 8,
});

function clampBound(value, fallback, cap) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.trunc(n), cap));
}

/**
 * Resolve the run's adaptive policy. Precedence: options.adaptive (per-run)
 * beats topology.adaptive (spec disposition) beats ADAPTIVE_POLICY_DEFAULTS.
 * `false` pins the run linear ({enabled:false}); `true` takes the defaults;
 * an object merges its bounds over the defaults, clamped to the hard caps.
 * Anything else (undefined/garbage) falls through to the next rung.
 *
 * @param {object} topology - the resolved topology spec (may carry .adaptive)
 * @param {object} options - the run options (may carry .adaptive)
 * @returns {{enabled: boolean, maxLoopsPerPhase: number, maxTotalReroutes: number}}
 */
export function resolveAdaptivePolicy(topology = {}, options = {}) {
  const source = options?.adaptive !== undefined ? options.adaptive
    : topology?.adaptive !== undefined ? topology.adaptive
    : undefined;
  if (source === false) return { ...ADAPTIVE_POLICY_DEFAULTS, enabled: false };
  if (source === true || source === undefined || source === null || typeof source !== "object") {
    return { ...ADAPTIVE_POLICY_DEFAULTS };
  }
  return {
    enabled: source.enabled !== false,
    maxLoopsPerPhase: clampBound(source.maxLoopsPerPhase, ADAPTIVE_POLICY_DEFAULTS.maxLoopsPerPhase, ADAPTIVE_POLICY_HARD_CAPS.maxLoopsPerPhase),
    maxTotalReroutes: clampBound(source.maxTotalReroutes, ADAPTIVE_POLICY_DEFAULTS.maxTotalReroutes, ADAPTIVE_POLICY_HARD_CAPS.maxTotalReroutes),
  };
}

/**
 * The deterministic routing table. Consumes the ALREADY-classified gate outcome
 * (classifyGateResult's gateStatus/gateReason on phaseResult) and decides the
 * route; it never re-classifies content and never mutates its inputs.
 *
 *   advance — gate passed (or the phase has no gate): proceed as today.
 *   loop    — the phase failed retryably (seat-error / all-empty) and the
 *             bounds allow a retry: the runner re-inserts the phase at the
 *             cursor so the SAME step re-executes next iteration.
 *   branch  — [A17.7, DR-113 "cursor insert"] the phase declares an AUTHORED
 *             alternative (`onFailBranch: <phase-id>`) and the failure is not
 *             recoverable by retry (below-confidence, or the loop bound is
 *             spent): the runner inserts the DECLARED target phase at the
 *             cursor. Deterministic-floor by construction — the route exists
 *             only where the topology authored it; once per phase per run;
 *             counted against the same reroute cap.
 *   escalate— [A17.9, DR-113 "review-seat model judgment"] the failure is
 *             genuinely ambiguous (below-confidence, or retries exhausted) with
 *             no cheaper authored route, AND escalation is enabled for the run
 *             (ctx.escalation): defer the route to an INDEPENDENT review seat
 *             rather than blind-exit. Once per phase, counted against the reroute
 *             cap. OFF by default — without ctx.escalation this case exits exactly
 *             as before, so clean/reviewer-less runs are byte-identical.
 *   exit    — today's honest halt: pinned linear, budget exhausted, bounds
 *             spent, or a non-routable reason with no authored alternative and no
 *             enabled reviewer (the confidence floor stays an operator-meaningful
 *             exit when un-branched and un-escalated).
 *
 * @param {{gateStatus?: string, gateReason?: string}} phaseResult
 * @param {{id?: string, gate?: boolean, onFailBranch?: string, onFailRecurse?: string}} phase
 * @param {{policy?: object, state?: {loopsByPhase?: object, branchesByPhase?: object, recursesByPhase?: object, escalationsByPhase?: object, totalReroutes?: number}, budgetExhausted?: boolean, escalation?: boolean}} ctx
 * @returns {{route: "advance"|"loop"|"branch"|"recurse"|"escalate"|"exit", reason: string|null, target?: string}}
 */
export function classifyPhaseOutcome(phaseResult = {}, phase = {}, ctx = {}) {
  if (!phase.gate || phaseResult.gateStatus !== "fail") {
    return { route: "advance", reason: null };
  }
  const policy = ctx.policy || ADAPTIVE_POLICY_DEFAULTS;
  if (!policy.enabled) return { route: "exit", reason: "adaptive-disabled" };
  if (ctx.budgetExhausted) return { route: "exit", reason: "budget-exhausted" };
  const gateReason = phaseResult.gateReason || "";
  const retryable = gateReason === "seat-error" || gateReason === "all-empty";
  const state = ctx.state || {};
  const reroutesLeft = (state.totalReroutes || 0) < policy.maxTotalReroutes;
  // An authored LATERAL escape: a real, distinct sibling phase, not yet taken this run.
  const branchable =
    typeof phase.onFailBranch === "string" &&
    phase.onFailBranch.length > 0 &&
    phase.onFailBranch !== phase.id &&
    !(state.branchesByPhase?.[phase.id] > 0) &&
    reroutesLeft;
  // [A17.7 → A17.8] An authored DEEPER escape: decompose into a sub-topology run. The
  // target is a topology id (not a phase); recursion cycles/depth are guarded at runtime by
  // the TopologyTree, so the table only needs the once-per-phase + reroute-cap guards.
  const recursable =
    typeof phase.onFailRecurse === "string" &&
    phase.onFailRecurse.length > 0 &&
    !(state.recursesByPhase?.[phase.id] > 0) &&
    reroutesLeft;
  // [A17.9] The JUDGMENT escape: an enabled review seat judges the ambiguous failure
  // when no cheaper authored route applies. Enabled per-run (ctx.escalation); OFF by
  // default so this collapses to today's exit. Once per phase, reroute-capped — a
  // judgment dispatch is as bounded as any other reroute.
  const escalatable =
    ctx.escalation === true &&
    !(state.escalationsByPhase?.[phase.id] > 0) &&
    reroutesLeft;
  // The escalation ladder is deterministic and cost-ordered: retry the same → an authored
  // lateral sibling (branch) → an authored deeper decomposition (recurse) → a review-seat
  // judgment (escalate) → honest exit. Authored routes are preferred over a judgment
  // dispatch (cheaper, deterministic); a phase authoring both branch and recurse prefers
  // branch. The nuanced branch-vs-recurse judgment stays the reviewer's to make, not the
  // floor's — the floor only offers escalate when the author declared no lateral/deeper route.
  const escalate = (reason) => {
    if (branchable) return { route: "branch", reason, target: phase.onFailBranch };
    if (recursable) return { route: "recurse", reason, target: phase.onFailRecurse };
    if (escalatable) return { route: "escalate", reason };
    return { route: "exit", reason };
  };

  if (!retryable) return escalate("below-confidence");
  const loops = state.loopsByPhase?.[phase.id] || 0;
  if (loops >= policy.maxLoopsPerPhase) return escalate("loop-bound-exhausted");
  if (!reroutesLeft) return { route: "exit", reason: "reroute-bound-exhausted" };
  return { route: "loop", reason: gateReason };
}

/** Cap per-failure error detail carried into a retry frame (signal, not a log dump). */
const RETRY_ERROR_SNIPPET_MAX = 200;
const RETRY_FAILURES_MAX = 8;

/**
 * [A17.5] Build the failure observation that rides the re-inserted step — the
 * material the retry's T (think) step reasons over. Compact by construction:
 * per-seat error snippets are truncated and the list is capped, because this
 * lands inside a prompt frame, not a log.
 *
 * @param {{responses?: Array<{model?: string, seat?: string, error?: any, response?: any}>}} phaseResult - the FAILED attempt
 * @param {string} reason - the routed gate reason ("seat-error" | "all-empty")
 * @param {number} attempt - 1-based number of the attempt that just failed
 * @returns {{attempt: number, reason: string, failures: Array<{model: string, detail: string}>}}
 */
export function buildRetryAnnotation(phaseResult = {}, reason = "", attempt = 1) {
  const responses = Array.isArray(phaseResult.responses) ? phaseResult.responses : [];
  const failures = [];
  for (const r of responses) {
    if (failures.length >= RETRY_FAILURES_MAX) break;
    if (!r) continue;
    if (r.error) {
      failures.push({ model: r.model || r.seat || "unknown", detail: String(r.error).slice(0, RETRY_ERROR_SNIPPET_MAX) });
    } else if (reason === "all-empty" && !r.response) {
      failures.push({ model: r.model || r.seat || "unknown", detail: "returned empty output" });
    }
  }
  return { attempt, reason, failures };
}

/**
 * [A17.5] Proxy-T: compose the informed retry input. The [Adaptive Retry] block
 * carries the failure observation and an explicit think-first directive ABOVE
 * the original phase input (preserved verbatim below it), so the acting seats
 * diagnose-then-revise inside the same dispatch instead of blindly re-rolling.
 *
 * [A17.9] When the retry was DIRECTED by an escalation reviewer, annotation.directive
 * carries the reviewer's revision instruction (the explicit think-step, homed): it is
 * rendered as a distinct guidance line. A normal (proxy-T) retry carries no directive,
 * so its frame is byte-identical to before.
 *
 * @param {string} phaseInput - the phase's normally-resolved input
 * @param {{attempt: number, reason: string, failures: Array<{model: string, detail: string}>, directive?: string|null}} annotation
 * @returns {string}
 */
export function composeAdaptiveRetryInput(phaseInput, annotation = {}) {
  const attempt = annotation.attempt || 1;
  const failureLines = (annotation.failures || [])
    .map((f) => `- ${f.model}: ${f.detail}`)
    .join("\n");
  const directiveLines = (typeof annotation.directive === "string" && annotation.directive.trim())
    ? [`Reviewer guidance (escalation): ${annotation.directive.trim()}`]
    : [];
  return [
    "[Adaptive Retry]",
    `This is attempt ${attempt + 1} of this phase. Attempt ${attempt} failed: ${annotation.reason || "unknown"}.`,
    ...(failureLines ? [failureLines] : []),
    ...directiveLines,
    "Think first: diagnose the failure above, then revise your approach — do not repeat the failed attempt verbatim.",
    "",
    String(phaseInput ?? ""),
  ].join("\n");
}

/**
 * [A17.7] Build the observation that rides a BRANCHED step — why the run left
 * the failed phase and took its authored alternative. Same compactness contract
 * as buildRetryAnnotation (frame material, not a log dump); reuses its failure
 * harvest so seat errors travel to the branch target too.
 *
 * @param {{responses?: Array}} phaseResult - the FAILED attempt at the origin phase
 * @param {string} reason - the routed reason ("below-confidence" | "loop-bound-exhausted")
 * @param {string} fromPhaseId - the phase that failed
 * @returns {{from: string, reason: string, failures: Array<{model: string, detail: string}>}}
 */
export function buildBranchAnnotation(phaseResult = {}, reason = "", fromPhaseId = "") {
  const { failures } = buildRetryAnnotation(phaseResult, reason, 1);
  return { from: fromPhaseId, reason, failures };
}

/**
 * [A17.7] Compose the branched step's informed input. The [Adaptive Branch]
 * block states WHY the run routed here (the branch edge re-enters at T, DR-114:
 * the alternative's seats reason over the origin failure, not blind to it),
 * above the target phase's own input preserved verbatim.
 *
 * @param {string} phaseInput - the TARGET phase's normally-resolved input
 * @param {{from: string, reason: string, failures?: Array<{model: string, detail: string}>}} annotation
 * @returns {string}
 */
export function composeAdaptiveBranchInput(phaseInput, annotation = {}) {
  const failureLines = (annotation.failures || [])
    .map((f) => `- ${f.model}: ${f.detail}`)
    .join("\n");
  return [
    "[Adaptive Branch]",
    `Phase "${annotation.from || "unknown"}" could not pass its gate (${annotation.reason || "unknown"}); this phase is its authored alternative route.`,
    ...(failureLines ? [failureLines] : []),
    "Think first: account for that failure, then take a genuinely different approach — do not replay the failed phase's output.",
    "",
    String(phaseInput ?? ""),
  ].join("\n");
}

/**
 * [A17.8] The recurse edge's T seed: the sub-topology run's prompt opens with WHY the
 * parent phase could not resolve, so the child topology attacks the problem informed
 * rather than from a blank slate. Same compactness contract as the branch/retry blocks.
 *
 * @param {string} phaseInput - the recursing phase's normally-resolved input (the problem)
 * @param {{from: string, reason: string, failures?: Array<{model: string, detail: string}>}} annotation
 * @returns {string}
 */
export function composeAdaptiveRecurseInput(phaseInput, annotation = {}) {
  const failureLines = (annotation.failures || [])
    .map((f) => `- ${f.model}: ${f.detail}`)
    .join("\n");
  return [
    "[Adaptive Recurse]",
    `Phase "${annotation.from || "unknown"}" could not resolve this directly (${annotation.reason || "unknown"}); it is being decomposed into this sub-topology run.`,
    ...(failureLines ? [failureLines] : []),
    "Solve the problem below thoroughly; your result becomes that phase's output.",
    "",
    String(phaseInput ?? ""),
  ].join("\n");
}

/** Extract the first balanced JSON object from text (mirrors anchor.js's extractJson). */
function extractFirstJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Cap a reviewer directive carried into a retry frame (signal, not an essay). */
const ESCALATION_DIRECTIVE_MAX = 500;

/**
 * [A17.9] Compose the review seat's escalation prompt: the failure observation +
 * the BOUNDED judgment ask. The reviewer is an INDEPENDENT judgment over an
 * ambiguous failure (below-confidence, or retries exhausted) — it decides the
 * route, it does not re-do the work. Compact by construction (frame material,
 * not a log). Pure.
 *
 * @param {{from?: string, reason?: string, failures?: Array<{model: string, detail: string}>}} observation
 * @param {{id?: string}} phase
 * @param {string} reason - the routed gate reason that triggered escalation
 * @returns {string}
 */
export function composeEscalationPrompt(observation = {}, phase = {}, reason = "") {
  const failureLines = (observation.failures || [])
    .map((f) => `- ${f.model}: ${f.detail}`)
    .join("\n");
  return [
    "[Escalation Review]",
    `Phase "${phase.id || observation.from || "unknown"}" could not pass its gate (${reason || observation.reason || "unknown"}).`,
    ...(failureLines ? ["Observed failures:", failureLines] : []),
    "",
    "You are an INDEPENDENT reviewer of this run. Judge whether the phase should be RETRIED with a concrete fix, or whether the run should EXIT honestly. Do NOT perform the phase's work yourself.",
    "Respond with ONLY a JSON object, one of:",
    '  { "verdict": "retry", "directive": "<one concrete, actionable instruction likely to fix the failure>" }',
    '  { "verdict": "exit" }',
    "Choose retry only when a specific change is likely to succeed within the run's remaining budget; otherwise exit.",
  ].join("\n");
}

/**
 * [A17.9] Interpret a review seat's judgment into a BOUNDED verdict. Authority
 * bounds (DR-110 shape): the reviewer may only pick retry (with an optional
 * revision directive — the explicit think-step homed here, DR-114) or exit.
 * Anything unparseable or out-of-vocabulary falls back to an honest exit, so a
 * garbled judgment never widens the run's authority nor loops it. Gate-overrule
 * ("accept" — proceeding past a failed gate) is deliberately NOT in this
 * vocabulary; overruling a governance gate is a separate, ratification-gated slice.
 *
 * @param {string} raw - the reviewer model's raw text
 * @returns {{verdict: "retry"|"exit", directive: string|null, reason?: string}}
 */
export function interpretEscalationVerdict(raw = "") {
  const text = typeof raw === "string" ? raw : "";
  const clip = (s) => s.trim().slice(0, ESCALATION_DIRECTIVE_MAX);
  // Prefer a structured object if the reviewer emitted one.
  const obj = extractFirstJsonObject(text);
  if (obj && typeof obj.verdict === "string") {
    const v = obj.verdict.trim().toLowerCase();
    if (v === "retry") {
      const d = typeof obj.directive === "string" && obj.directive.trim() ? clip(obj.directive) : null;
      return { verdict: "retry", directive: d };
    }
    if (v === "exit") return { verdict: "exit", directive: null };
  }
  // Fall back to a bare keyword scan (retry wins only if explicitly present).
  if (/\bretry\b/i.test(text)) {
    const m = text.match(/retry\s*[:\-]\s*(.+)/i);
    return { verdict: "retry", directive: m ? clip(m[1]) : null };
  }
  if (/\bexit\b/i.test(text)) return { verdict: "exit", directive: null };
  return { verdict: "exit", directive: null, reason: "unparseable-judgment" };
}

export default {
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
};
