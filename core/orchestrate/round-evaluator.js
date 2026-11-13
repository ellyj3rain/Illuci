/**
 * illuci — company-rounds: the OPTIONAL, ADVISORY round evaluator.
 *
 * adviseEvaluator looks at a round's ClashArtifact and returns advice: "continue" or
 * "stop:<reason>". It writes that string to clash.evaluatorAdvice (the loop does this).
 *
 * ADVISORY ONLY — THIS CAN NEVER HALT. The brakes (brakes.js) are the sole halt authority.
 * The evaluator's "stop:<reason>" is a RECOMMENDATION recorded onto the clash for the
 * operator/observer; the loop reads it for the record, not for control flow. This separation
 * is deliberate: an advisory voice that could halt would be a second, ungoverned brake.
 *
 * It is OPTIONAL: the loop skips it entirely when no evaluator is configured on the
 * AdversarialCompanyConfig. When configured, the default heuristic here is PURE +
 * DETERMINISTIC (it reads the clash's deterministic fields). An evaluator MAY be wired to a
 * real advisory topology via deps.adviseFn for a richer (non-deterministic) opinion; that
 * injected function still cannot halt — its output only ever lands in evaluatorAdvice.
 */

/**
 * @param {object} clash — the round's ClashArtifact (deterministic fields already filled)
 * @param {object} config — the AdversarialCompanyConfig (config.evaluator gates this)
 * @param {object} [deps]
 * @param {Function} [deps.adviseFn] — optional injected advisor (clash,config)=>string.
 *   When provided it REPLACES the default heuristic. It is still advisory: it can never halt.
 * @returns {"continue"|`stop:${string}`} the advice string (also written to evaluatorAdvice)
 */
export function adviseEvaluator(clash, config, deps = {}) {
  // No evaluator configured ⇒ no advice. The loop will not even call this, but guard anyway.
  if (!config || !config.evaluator) return "continue";

  if (typeof deps.adviseFn === "function") {
    const out = deps.adviseFn(clash, config);
    return normalizeAdvice(out);
  }

  // ── Default PURE heuristic: advise "stop" when the round shows no real progress, mirroring
  //    (but never enforcing) the no-progress signal. The bodies stopped meaningfully clashing,
  //    so an advisor would counsel wrapping up. This is a RECOMMENDATION only. ──
  const hunkCount = Array.isArray(clash?.collisionHunks) ? clash.collisionHunks.length : 0;
  const cosmetic = clash?.heterogeneityProof?.cosmetic === true;
  if (hunkCount === 0 && cosmetic) {
    return "stop:no-substantive-divergence";
  }
  return "continue";
}

/** Coerce an injected advisor's return into the {"continue"|"stop:<reason>"} contract. */
function normalizeAdvice(out) {
  if (typeof out !== "string" || out.length === 0) return "continue";
  if (out === "continue") return "continue";
  if (out.startsWith("stop:")) return out;
  if (out === "stop") return "stop:unspecified";
  // Anything else is treated as a stop reason for the record.
  return `stop:${out}`;
}

export default { adviseEvaluator };
