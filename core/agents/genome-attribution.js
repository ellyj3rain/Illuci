// Behavioral attribution — the outcome-grounded direction source (DR-195).
//
// DR-194 shipped `salient` reinforcement with a disclosed limitation: it deepens
// a disposition's expressed poles WITHOUT evidence those poles earned the
// outcome (autocatalysis — "geometry reading geometry"). DR-194 §residual named
// the honest unblock — a grader that conditions learning on real run OUTCOMES —
// and the operator commissioned it. This is `behavioral` v1.
//
// THE HONEST DIFFERENCE FROM SALIENT: behavioral only attributes when the
// persona's expression has ACTUALLY produced good outcomes across accrued runs.
// A balanced arbiter that ruled decisively (substantial, gate-passing output)
// earns reinforcement toward its expressed poles; one that produced thin or
// losing output earns NOTHING — where salient would reinforce it regardless.
// It also requires ACCRUED evidence: the first run has no prior outcomes, so it
// attributes nothing (unlike salient, which fires immediately on the profile).
//
// THE HONEST LIMITATION (disclosed, v1): this is DISPOSITION-level outcome
// conditioning, not per-facet counterfactual discrimination — every salient
// facet shares the run's outcome confidence, because v1 cannot yet isolate
// WHICH facet was load-bearing (that is the counterfactual / feature-signature
// method scoped in design/genome-grader-attribution.md as v2). So confidence is
// CAPPED (correlation, not causation) and RECORDED on every delta; and the step
// stays the kernel's dyadic 1/32 (confidence GATES, it does not scale — dyadic
// exactness preserved; the recorded confidence feeds the DR-176 re-weighting).

export const ATTRIBUTION_SCHEMA = "illuci.genome.behavioral-attribution/1";

// Evidence + confidence gates. Below MIN_OUTCOMES accrued, or below the quality
// FLOOR, behavioral attributes NOTHING (the honest null — no fake director).
export const MIN_OUTCOMES = 2;           // need accrued evidence, like the DR-176 runCount gate
export const CONFIDENCE_FLOOR = 0.5;     // the disposition must have EARNED it
export const CONFIDENCE_CAP = 0.6;       // correlation, not causation — never claim high confidence
export const SUBSTANTIVE_CHARS = 200;    // an output below this is not evidence of engaged expression

/**
 * Score the outcome quality of a persona's accrued runs — the fraction of runs
 * whose expression produced SUBSTANTIVE, gate-passing output, lifted by the
 * engine's own quality signals (marginalValue, systemConfidence) when present.
 * Pure. Returns { quality: 0..1, runs: N, substantive: N, gatePassed: N }.
 *
 * @param {Array<{substantive?:boolean, chars?:number, gatePassed?:boolean|null,
 *   marginalValue?:number|null, systemConfidence?:number|null}>} outcomes
 */
export function scoreOutcomeQuality(outcomes = []) {
  const rows = Array.isArray(outcomes) ? outcomes.filter((o) => o && typeof o === "object") : [];
  if (rows.length === 0) return { quality: 0, runs: 0, substantive: 0, gatePassed: 0 };
  let good = 0;
  let substantive = 0;
  let gatePassed = 0;
  for (const o of rows) {
    const isSub = o.substantive === true || (typeof o.chars === "number" && o.chars >= SUBSTANTIVE_CHARS);
    // A null gate (ungated phase) is not a FAILURE — an ungated substantive
    // output counts; an explicit fail does not.
    const gateOk = o.gatePassed !== false;
    if (isSub) substantive += 1;
    if (gateOk) gatePassed += 1;
    if (isSub && gateOk) {
      // Base credit for a substantive, non-failing run; the engine's quality
      // signals nudge it (bounded), never fabricate it.
      let credit = 0.7;
      if (typeof o.marginalValue === "number") credit += Math.max(-0.2, Math.min(0.2, (o.marginalValue - 0.5) * 0.4));
      if (typeof o.systemConfidence === "number") credit += Math.max(-0.1, Math.min(0.1, (o.systemConfidence - 0.5) * 0.2));
      good += Math.max(0, Math.min(1, credit));
    }
  }
  return { quality: good / rows.length, runs: rows.length, substantive, gatePassed };
}

/**
 * The behavioral lens: outcome-grounded attribution over a persona's salient
 * facets. Returns the lens object (always — the D3 record-completeness rule);
 * `markers` is EMPTY (the honest null) when evidence is insufficient or the
 * quality floor is not met. When markers fire, each carries the disposition-level
 * confidence and the method, and confidence is capped.
 *
 * @param {object} args
 * @param {string[]} args.salientMarkers  the salient lens markers ("C1-Competence↑")
 * @param {Array} args.outcomes           the persona's accrued prior phase outcomes
 * @returns {{ tag:"behavioral", method:string, markers:string[], confidence:number,
 *   quality:number, runs:number, reason:string }}
 */
export function computeBehavioralAttribution({ salientMarkers = [], outcomes = [] } = {}) {
  const score = scoreOutcomeQuality(outcomes);
  const base = { tag: "behavioral", method: "outcome-conditioned/1", markers: [], confidence: 0, quality: score.quality, runs: score.runs };

  if (score.runs < MIN_OUTCOMES) {
    return { ...base, reason: "insufficient-evidence" };
  }
  if (score.quality < CONFIDENCE_FLOOR) {
    // The disposition's expression did NOT earn reinforcement — the honest null
    // that separates behavioral from salient. Do not deepen a losing identity.
    return { ...base, reason: "quality-below-floor" };
  }
  const markers = Array.isArray(salientMarkers) ? salientMarkers.filter((m) => typeof m === "string" && m.length >= 2) : [];
  if (markers.length === 0) {
    return { ...base, reason: "no-candidate-facets" };
  }
  const confidence = Math.min(CONFIDENCE_CAP, score.quality);
  return { ...base, markers, confidence, reason: "attributed" };
}

export default {
  ATTRIBUTION_SCHEMA,
  MIN_OUTCOMES,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CAP,
  SUBSTANTIVE_CHARS,
  scoreOutcomeQuality,
  computeBehavioralAttribution,
};
