/**
 * illuci — company-rounds: the BRAKES — the ONLY things that may halt the rounds loop.
 *
 * PURE FUNCTIONS. evaluateBrakes reads the round number, the ceiling, the (real) session
 * RunBudget, the current + prior clash artifacts, the StopCondition, and the running stall
 * count, and returns a halt verdict + the reason + the updated stall count. It NEVER
 * dispatches, NEVER mutates the budget, NEVER touches a clock or randomness.
 *
 * THE THREE BRAKES, in precedence order (the first that fires wins the brakeTriggered tag):
 *   1. "round-ceiling"  — round >= roundCeiling.maxRounds. The HARD outer bound. At the
 *                         default maxRounds:1 this fires on round 1, so the loop runs exactly
 *                         once (byte-identical to a plain orchestrate pass).
 *   2. "budget"         — the session RunBudget is exhausted (runBudget.isHalted()). The
 *                         loop reads the REAL budget API; it does not re-implement exhaustion.
 *   3. "no-progress"    — the TRIPLE-GATE, persisted for stallRounds consecutive rounds:
 *                           (a) carriedForward hash unchanged from the prior clash, AND
 *                           (b) clash.collisionHunks.length < minCollisionHunks, AND
 *                           (c) clash.heterogeneityProof.cosmetic === true.
 *                         ALL THREE must hold to count this round as a stall. The stall must
 *                         PERSIST for stallRounds consecutive rounds before the brake fires.
 *                         ANY real disagreement (any one gate not held) RESETS stallCount to 0.
 *
 * The evaluator (round-evaluator.js) is ADVISORY ONLY — it writes clash.evaluatorAdvice and
 * is read nowhere here. The brakes are the sole halt authority.
 */

/**
 * @param {object} args
 * @param {number} args.round — 1-based current round
 * @param {object} args.roundCeiling — { maxRounds }
 * @param {object} args.runBudget — the REAL session RunBudget (run-budget.js); read-only here
 * @param {object} args.clash — this round's ClashArtifact
 * @param {object|null} args.priorClash — the previous round's ClashArtifact (null on round 1)
 * @param {object} args.stopCondition — normalized StopCondition
 * @param {number} args.stallCount — consecutive-stall count carried INTO this round (>=0)
 * @returns {{ halt:boolean, brakeTriggered:("round-ceiling"|"budget"|"no-progress"|null), stallCount:number }}
 */
export function evaluateBrakes({ round, roundCeiling, runBudget, clash, priorClash, stopCondition, stallCount = 0 }) {
  const sc = stopCondition || {};
  const minCollisionHunks = Number.isInteger(sc.minCollisionHunks) ? sc.minCollisionHunks : 1;
  const stallRounds = Number.isInteger(sc.stallRounds) && sc.stallRounds >= 1 ? sc.stallRounds : 1;

  // ── Gate (3) inputs: is THIS round a stall? (computed first so stallCount stays honest
  //    regardless of which brake fires) ──
  const hashUnchanged = !!priorClash && clash?.carriedForward === priorClash?.carriedForward;
  const hunkCount = Array.isArray(clash?.collisionHunks) ? clash.collisionHunks.length : 0;
  const belowHunkFloor = hunkCount < minCollisionHunks;
  const cosmetic = clash?.heterogeneityProof?.cosmetic === true;
  const isStall = hashUnchanged && belowHunkFloor && cosmetic; // TRIPLE-GATE: all three

  // ANY real disagreement (not a full triple-gate stall) RESETS the stall counter. A stall
  // round increments it. This is the persistence accumulator the no-progress brake reads.
  const nextStallCount = isStall ? stallCount + 1 : 0;

  // ── Brake (1): the HARD round ceiling. Highest precedence. ──
  const maxRounds = Number.isInteger(roundCeiling?.maxRounds) && roundCeiling.maxRounds > 0 ? roundCeiling.maxRounds : 1;
  if (round >= maxRounds) {
    return { halt: true, brakeTriggered: "round-ceiling", stallCount: nextStallCount };
  }

  // ── Brake (2): the session budget, via the REAL RunBudget API. ──
  if (runBudget && typeof runBudget.isHalted === "function" && runBudget.isHalted()) {
    return { halt: true, brakeTriggered: "budget", stallCount: nextStallCount };
  }

  // ── Brake (3): no-progress — the triple-gate, persisted for stallRounds rounds. ──
  if (nextStallCount >= stallRounds) {
    return { halt: true, brakeTriggered: "no-progress", stallCount: nextStallCount };
  }

  return { halt: false, brakeTriggered: null, stallCount: nextStallCount };
}

export default { evaluateBrakes };
