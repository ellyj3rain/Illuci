/**
 * illuci — Facet clamp (the single source of the [0,1] facet algebra)
 *
 * NEO-PI-R facet scores live on the closed interval [0, 1] (see
 * disposition-dimensions.js: 0.50 = population mean, 0.84 ≈ +1σ). Every
 * place a facet value is produced or shifted — preset injection, disposition
 * pulls (composition.js), and the persona-genome ledger fold (persona-memory.js
 * replay) — must keep the value inside that interval.
 *
 * This is DELIBERATELY a different function from the pull-magnitude clamp in
 * composition.js (which clamps a *shift* to [-1, 1], a different algebra). Do
 * not unify the two: they bound different quantities. clampFacet bounds a
 * facet POSITION; the pull clamp bounds a facet DELTA.
 *
 * Extracted as its own module (Phase 0 of persona-genome-v1) so the genome
 * fold and the composer share one byte-identical clamp. The extraction is
 * required to be output-neutral: composeDisposition must be byte-identical before
 * and after (the AM-9 golden test).
 *
 * @module core/agents/clamp-facet
 */

/**
 * Clamp a NEO-PI-R facet value to the closed interval [0, 1].
 *
 * M-1 hardening: a non-finite input (NaN / ±Infinity) would propagate through Math.max/min
 * and yield NaN (Math.max(0, NaN) === NaN). Coerce it to the population mid-point (0.5) so a
 * facet position is always a finite value in [0, 1]. This is OUTPUT-NEUTRAL for every FINITE
 * input — the AM-9 golden (which only ever feeds finite values) stays byte-identical.
 *
 * @param {number} v  a facet position (may be out of range after a shift)
 * @returns {number}  v clamped to [0, 1]; 0.5 for a non-finite input
 */
export function clampFacet(v) {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

export default clampFacet;
