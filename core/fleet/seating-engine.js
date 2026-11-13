/**
 * illuci — Seating engine (the DELEGATED selection path).
 *
 * The operator's four laws, made mechanism:
 *   1. Seating is OPERATOR-MEDIATED by default. This engine runs ONLY when the
 *      operator delegates selection (no explicit seat map / strategy: delegated).
 *      It never overrides an explicit operator choice.
 *   2. When delegated, selection is INTELLIGENT: a candidate is seatable only if
 *      it passes a live-health gate (isHealthy) — presence-plus-breaker, never a
 *      hardcoded "installed => available" assertion. Then candidates are ranked by
 *      LEARNED reliability (reliabilityScore), not a static priority table.
 *   3. Reliability is learned/decayed data (core/fleet/reliability-store.js), so
 *      NOTHING about the fleet is hardcoded here — this module names no model.
 *   4. NO role has EXCLUSIVE candidates. A role whose HEALTHY candidate pool has
 *      fewer than MIN_CANDIDATES distinct models is a data bug; the engine reports
 *      it (never silently seats the lone survivor as if it were a valid plan).
 *
 * Pure + dependency-injected: the caller passes the candidate list (models that
 * DECLARE the role), an isHealthy(model) predicate (the honest availability gate),
 * and a reliabilityScore(model) function. The engine does no I/O and imports
 * nothing from the dispatch graph.
 */

export const MIN_CANDIDATES = 2;

/**
 * Rank the healthy candidates for a role by reliability, and report invariant state.
 *
 * @param {object} req
 * @param {string} req.role
 * @param {string[]} req.candidates      models that declare `role` (registry-derived)
 * @param {(model:string) => boolean} req.isHealthy   honest live-health gate
 * @param {(model:string) => number} req.reliabilityScore  [0,1] learned score
 * @param {number} [req.minCandidates=MIN_CANDIDATES]
 * @param {(model:string) => number} [req.tiebreak]  deterministic tiebreak weight
 *   (default 0 for all — callers vary by index/seed to avoid deterministic lock-in)
 * @returns {{ role, seated: string|null, ranked: {model,score}[],
 *   healthy: string[], unhealthy: string[],
 *   invariant: { ok: boolean, code: string|null, healthyCount: number, declaredCount: number } }}
 */
export function seatRole(req) {
  const {
    role,
    candidates = [],
    isHealthy = () => true,
    reliabilityScore = () => 0.5,
    minCandidates = MIN_CANDIDATES,
    tiebreak = () => 0,
  } = req || {};

  const declared = [...new Set(candidates.filter((m) => typeof m === "string" && m))];
  const healthy = declared.filter((m) => {
    try { return !!isHealthy(m); } catch { return false; }
  });
  const unhealthy = declared.filter((m) => !healthy.includes(m));

  const ranked = healthy
    .map((model) => ({ model, score: clamp01(reliabilityScore(model)), _t: tiebreak(model) }))
    .sort((a, b) => (b.score - a.score) || (b._t - a._t) || a.model.localeCompare(b.model))
    .map(({ model, score }) => ({ model, score }));

  // The no-exclusive-candidates invariant is evaluated on DECLARED breadth (a role
  // that only ONE model can ever fill is a data bug) AND surfaced against healthy
  // breadth (a role starved to one live lane right now is an operational shortfall).
  let code = null;
  if (declared.length < minCandidates) code = "exclusive-candidate";        // data bug: role declared by <2 models
  else if (healthy.length === 0) code = "no-healthy-candidate";              // nothing live can fill it
  else if (healthy.length < minCandidates) code = "single-healthy-candidate"; // degraded: one live survivor

  return {
    role,
    seated: ranked.length ? ranked[0].model : null,
    ranked,
    healthy,
    unhealthy,
    invariant: {
      ok: code === null,
      code,
      healthyCount: healthy.length,
      declaredCount: declared.length,
    },
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export default { seatRole, MIN_CANDIDATES };
