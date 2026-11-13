/**
 * illuci — company-rounds: the HETEROGEILLUCIUS-ADVERSARIAL company loop (the legislature-ratified
 * "company-rounds" capability).
 *
 * WHAT THIS IS. A round driver over the GOVERNED orchestrate() entrypoint. Each round is
 * EXACTLY ONE orchestrate() call running the two adversarial bodies (commune + devStructure)
 * as a company on one shared awareness bus. Between rounds, a DETERMINISTIC clash artifact is
 * assembled from the round's company result, an OPTIONAL advisory evaluator annotates it, and
 * the PURE brakes decide whether to stop. The loop carries the prior clash forward so the
 * next round's bodies collide against the last round's settled content.
 *
 * THE LOAD-BEARING INVARIANTS.
 *   1. ONE orchestrate() PER ROUND. The loop body makes exactly one orchestrate() call per
 *      iteration. A defensive counter asserts this and THROWS if violated — a second dispatch
 *      in a round would be an un-budgeted, un-governed fleet call.
 *   2. maxRounds:1 ⇒ BYTE-IDENTICAL. The default round ceiling is 1, so the loop runs once,
 *      returns the round-1 company result UNCHANGED (the clash is additive metadata recorded
 *      ALONGSIDE it, never folded into it), and the only difference from a bare orchestrate()
 *      call is the wrapper's clashHistory/finalClash record.
 *   3. THE CLASH + BRAKES ARE PURE. No LLM, no embeddings, no clock, no randomness in the
 *      determinism path. The ONLY non-deterministic thing the loop does is call orchestrate
 *      (the real fleet) — and that is fully injectable via deps.orchestrate for hermetic tests.
 *   4. THE BUDGET IS REAL + SESSION-WIDE. createRunBudget is called ONCE; the session budget
 *      is threaded into each round (as the orchestrate token ceiling) AND charged from each
 *      round's actual token spend, so the "budget" brake reads a REAL exhausted-budget verdict
 *      (runBudget.isHalted()), not a re-implementation.
 */

import { orchestrate as realOrchestrate } from "./orchestrate.js";
import { createRunBudget } from "./run-budget.js";
import { makeAdversarialCompanyConfig, validate } from "./stop-condition.js";
import { assembleClashArtifact } from "./clash-artifact.js";
import { evaluateBrakes } from "./brakes.js";
import { adviseEvaluator } from "./round-evaluator.js";

/**
 * Build the company spec for ONE orchestrate() pass: the two adversarial bodies as company
 * members (commune at index 0, devStructure at index 1), carrying the prior round's clash as
 * context so the bodies collide against the last settled content. Threads the session budget's
 * token ceiling so a round respects the run-wide ceiling.
 *
 * @param {string} task — the operator's ask
 * @param {object} config — normalized AdversarialCompanyConfig
 * @param {object|null} priorClash — the previous round's ClashArtifact (null on round 1)
 * @param {object} runBudget — the session RunBudget (for its token ceiling)
 * @returns {object} the orchestrate() args object
 */
export function buildSinglePassSpec(task, config, priorClash, runBudget) {
  const { commune, devStructure } = config;

  // The prior clash, rendered as a compact context note appended to each body's prompt. On
  // round 1 there is no prior clash, so the prompt is the bare task (byte-identical to a
  // plain orchestrate pass over these two members).
  const priorContext = priorClash
    ? `\n\n[prior round ${priorClash.round} clash — tension: ${priorClash.tension}; carried-forward ${priorClash.carriedForward}]`
    : "";

  const memberPrompt = `${task}${priorContext}`;

  const topologies = [
    {
      topologyId: commune.topologyId,
      ...(commune.lineup ? { lineup: commune.lineup } : {}),
      prompt: memberPrompt,
      ...(commune.mandate != null ? { options: { mandate: commune.mandate } } : {}),
    },
    {
      topologyId: devStructure.topologyId,
      ...(devStructure.lineup ? { lineup: devStructure.lineup } : {}),
      prompt: memberPrompt,
      ...(devStructure.mandate != null ? { options: { mandate: devStructure.mandate } } : {}),
    },
  ];

  // The session budget's token ceiling rides through to runCompany's config so each round
  // dispatches under the run-wide ceiling. Null (unlimited) by default ⇒ byte-identical.
  const snap = typeof runBudget?.snapshot === "function" ? runBudget.snapshot() : {};
  const tokenCeiling = snap.tokenCeiling != null ? snap.tokenCeiling : undefined;

  return {
    topologies,
    prompt: task,
    awareness: true,
    ...(tokenCeiling !== undefined ? { tokenCeiling } : {}),
  };
}

/** Sum the actual token spend across every phase of every member in a company result. */
function sumRoundTokens(companyResult) {
  const members = Array.isArray(companyResult?.members) ? companyResult.members : [];
  let total = 0;
  for (const m of members) {
    const phases = m?.trace?.phases && typeof m.trace.phases === "object" ? m.trace.phases : {};
    for (const phaseId of Object.keys(phases)) {
      const t = phases[phaseId]?.totalTokens;
      if (Number.isFinite(t)) total += t;
    }
  }
  return total;
}

/**
 * runCompanyRounds — the heterogeneous-adversarial company loop.
 *
 * @param {string} task — the operator's ask
 * @param {object} adversarialConfig — a raw or normalized AdversarialCompanyConfig
 * @param {object} [deps]
 * @param {Function} [deps.orchestrate] — INJECTION SEAM. Defaults to the real orchestrate.
 *   A test passes a fake returning a stub company result so the loop is hermetic (no fleet).
 * @param {Function} [deps.adviseFn] — optional advisor injected into the evaluator (advisory).
 * @returns {Promise<{ status, clashHistory, finalClash, runBudget }>}
 */
export async function runCompanyRounds(task, adversarialConfig, deps = {}) {
  const config = makeAdversarialCompanyConfig(adversarialConfig);
  const check = validate(config);
  if (!check.valid) {
    throw new TypeError(`runCompanyRounds: invalid AdversarialCompanyConfig — ${check.errors.join("; ")}`);
  }

  const orchestrate = deps.orchestrate || realOrchestrate;
  const { roundCeiling, stopCondition, evaluator } = config;

  // ── INVARIANT 4: the session budget is created ONCE here and threaded into every round. ──
  const runBudget = createRunBudget({ tokenCeiling: stopCondition.tokenCeiling });

  const clashHistory = [];
  let priorClash = null;
  let stallCount = 0;
  let finalBrake = null;

  for (let round = 1; round <= roundCeiling.maxRounds; round++) {
    // ── INVARIANT 1: the defensive ONE-orchestrate-per-round counter. ──
    let orchestrateCalls = 0;
    const guardedOrchestrate = (args, oDeps) => {
      orchestrateCalls += 1;
      return orchestrate(args, oDeps);
    };

    const spec = buildSinglePassSpec(task, config, priorClash, runBudget);
    // EXACTLY ONE orchestrate() call per iteration (the loop body).
    const companyResult = await guardedOrchestrate(spec);

    if (orchestrateCalls !== 1) {
      throw new Error(
        `runCompanyRounds: invariant violated — orchestrate was invoked ${orchestrateCalls} times in round ${round} (must be exactly 1)`,
      );
    }

    // Charge the session budget from this round's REAL token spend, so the "budget" brake
    // reads an honest exhausted-budget verdict on the next evaluateBrakes.
    const spent = sumRoundTokens(companyResult);
    if (spent > 0 && typeof runBudget.charge === "function") runBudget.charge(spent);

    // ── INVARIANT 3 (clash + brakes are PURE). Assemble the deterministic clash from the
    //    round's company result — additive metadata, the company result itself untouched. ──
    const sessionId = companyResult?.sessionId ?? null;
    const clash = assembleClashArtifact(companyResult, priorClash, stopCondition, round, sessionId);

    // OPTIONAL advisory evaluator — writes evaluatorAdvice, can NEVER halt.
    if (evaluator) {
      clash.evaluatorAdvice = adviseEvaluator(clash, config, deps);
    }

    // The PURE brakes decide. They are the sole halt authority.
    const brakes = evaluateBrakes({ round, roundCeiling, runBudget, clash, priorClash, stopCondition, stallCount });
    clash.brakeTriggered = brakes.brakeTriggered;

    // Carry the round's company result alongside the clash for the caller's record. This is
    // additive — it never alters the company result object.
    clash.companyResult = companyResult;
    clashHistory.push(clash);
    finalBrake = brakes.brakeTriggered;

    if (brakes.halt) break;

    // Advance: this round's clash becomes the prior for the next; carry the stall count.
    priorClash = clash;
    stallCount = brakes.stallCount;
  }

  const finalClash = clashHistory.length > 0 ? clashHistory[clashHistory.length - 1] : null;

  return {
    // status names WHY the loop ended (the brake that fired on the last round). When the
    // ceiling was the natural terminator this is "round-ceiling"; an early stop names its brake.
    status: finalBrake || "completed",
    clashHistory,
    finalClash,
    runBudget: typeof runBudget.snapshot === "function" ? runBudget.snapshot() : null,
  };
}

export default { runCompanyRounds, buildSinglePassSpec };
