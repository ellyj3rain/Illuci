/**
 * illuci — Fleet reliability metrics (the LEARNED half of seating).
 *
 * The operator's law: "you don't pick random models just because they're there;
 * you test them, see if they work. And then over time you get metrics based on
 * model reliability." Static per-(model,role) priority tables are the DEFECT —
 * this store is the replacement: an observed, time-decayed success rate per
 * (model, role) that the seating engine scores on. Nothing about the fleet is
 * hardcoded; models earn and lose standing by their record.
 *
 * SHAPE (the DRL "dependency-free atom" mold — retry.js / liveness.js): pure
 * scoring functions + an in-process store keyed by `${canonicalModel}␟${role}`.
 * Injectable clock and persistence so it is trivially testable and imports
 * nothing from the dispatch graph. The recorded signal is the SAME taxonomy the
 * breaker consumes (classifyDispatchOutcome): success vs terminal_failure;
 * `ignored` outcomes (transient/aborted/paused/blocked) never touch reliability,
 * exactly as they never touch the breaker.
 *
 * DECAY: each observation ages by an exponential half-life (default 7 days), so a
 * model that failed a week ago is nearly forgiven and a model that returns after
 * a long absence starts from the neutral prior rather than stale glory. NEUTRAL
 * PRIOR: a Beta(priorWeight/2, priorWeight/2)-style regression toward 0.5 means a
 * lane with no evidence scores neutral (never auto-preferred, never auto-condemned)
 * and converges to its true rate as evidence accrues.
 */

const SEP = "␟"; // ␟ unit-separator — safe in a composite key
const DAY_MS = 86400000;

export const DEFAULT_HALF_LIFE_MS = 7 * DAY_MS;
export const DEFAULT_PRIOR_WEIGHT = 2; // two virtual neutral observations
export const NEUTRAL = 0.5;

export function reliabilityKey(model, role) {
  return `${String(model)}${SEP}${String(role)}`;
}

/** Decay a {success, total, ts} cell forward to `now`. Pure. */
export function decayCell(cell, now, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (!cell) return { success: 0, total: 0, ts: now };
  const dt = Math.max(0, now - (cell.ts ?? now));
  if (dt === 0) return { success: cell.success, total: cell.total, ts: cell.ts ?? now };
  const factor = Math.pow(2, -dt / halfLifeMs);
  return { success: cell.success * factor, total: cell.total * factor, ts: now };
}

/**
 * Score a decayed cell into a reliability in [0,1], regressed toward NEUTRAL by
 * the prior. Sparse evidence => ~NEUTRAL; strong evidence => the observed rate.
 */
export function scoreCell(cell, { priorWeight = DEFAULT_PRIOR_WEIGHT } = {}) {
  const success = cell?.success ?? 0;
  const total = cell?.total ?? 0;
  return (success + priorWeight * NEUTRAL) / (total + priorWeight);
}

/**
 * Create a reliability store.
 * @param {{ now?: () => number, halfLifeMs?: number, priorWeight?: number,
 *           load?: () => object, persist?: (snapshot: object) => void }} [opts]
 */
export function createReliabilityStore(opts = {}) {
  const now = opts.now || (() => Date.now());
  const halfLifeMs = opts.halfLifeMs || DEFAULT_HALF_LIFE_MS;
  const priorWeight = opts.priorWeight ?? DEFAULT_PRIOR_WEIGHT;
  const cells = new Map(); // key -> { success, total, ts }
  if (typeof opts.load === "function") {
    const snap = opts.load() || {};
    for (const [k, v] of Object.entries(snap)) {
      if (v && Number.isFinite(v.success) && Number.isFinite(v.total)) {
        cells.set(k, { success: v.success, total: v.total, ts: v.ts ?? now() });
      }
    }
  }
  const flush = () => {
    if (typeof opts.persist !== "function") return;
    const snap = {};
    for (const [k, v] of cells.entries()) snap[k] = { success: v.success, total: v.total, ts: v.ts };
    try { opts.persist(snap); } catch { /* persistence is best-effort; never break a dispatch */ }
  };

  /** Record one observed outcome for a (model, role). success=true|false. */
  function record(model, role, success) {
    const key = reliabilityKey(model, role);
    const t = now();
    const decayed = decayCell(cells.get(key), t, halfLifeMs);
    decayed.total += 1;
    if (success) decayed.success += 1;
    cells.set(key, decayed);
    flush();
    return decayed;
  }

  /** Reliability score in [0,1] for a (model, role) as of now (neutral if unseen). */
  function score(model, role) {
    const key = reliabilityKey(model, role);
    if (!cells.has(key)) return NEUTRAL;
    return scoreCell(decayCell(cells.get(key), now(), halfLifeMs), { priorWeight });
  }

  /** Observation weight (decayed total) — how much evidence backs the score. */
  function evidence(model, role) {
    const key = reliabilityKey(model, role);
    if (!cells.has(key)) return 0;
    return decayCell(cells.get(key), now(), halfLifeMs).total;
  }

  /** Archive (drop) all rows for a model — used when a model leaves the fleet. */
  function forget(model) {
    const prefix = `${String(model)}${SEP}`;
    let dropped = 0;
    for (const k of [...cells.keys()]) if (k.startsWith(prefix)) { cells.delete(k); dropped++; }
    if (dropped) flush();
    return dropped;
  }

  function snapshot() {
    const out = {};
    const t = now();
    for (const [k, v] of cells.entries()) {
      const d = decayCell(v, t, halfLifeMs);
      out[k] = { success: d.success, total: d.total, score: scoreCell(d, { priorWeight }) };
    }
    return out;
  }

  return { record, score, evidence, forget, snapshot, flush };
}

export default { createReliabilityStore, reliabilityKey, decayCell, scoreCell, DEFAULT_HALF_LIFE_MS, NEUTRAL };
