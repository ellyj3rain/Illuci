/**
 * illuci — Dynamic-Resilience Layer (DRL): latency store
 *
 * Two distinct observed-latency surfaces, both per-canonical (alias-snarl
 * dissolved):
 *
 *   1. A bounded ring of recent dispatch latencies per canonical model, feeding
 *      getP95(key). The race-timeout extension (adaptive-fallback.resolveRaceTimeout)
 *      adds this p95 to the tier ceiling BEFORE the seat headroom multiply, so a
 *      model that is genuinely slow this session is not guillotined by a ceiling
 *      tuned for a faster one. getP95 returns 0 with fewer than 2 samples — too
 *      little signal to trust, and 0 means "add nothing", so the extension is a
 *      no-op until enough samples exist (and the whole layer is flag-gated anyway).
 *
 *   2. An EWMA stall-watcher FACTORY for the streaming path: a long gap between
 *      token deltas (no progress) is a stall even when no wall-clock timeout has
 *      fired. The watcher smooths inter-delta gaps with an EWMA (alpha) and flags
 *      a stall when the smoothed gap exceeds the threshold (global, or a
 *      per-canonical override). It only OBSERVES — acting on a stall is the
 *      caller's choice; the watcher never touches the breaker or the ring.
 *
 * Ring memory is bounded by ILLUCI_DRL_LATENCY_RING_SIZE per canonical key.
 */

import { latencyRingSize, stallConfig } from "./config.js";

/** @type {Map<string, {buf:number[], next:number, count:number, size:number}>} */
const _rings = new Map();

function ringFor(canonicalKey) {
  let ring = _rings.get(canonicalKey);
  const size = latencyRingSize();
  if (!ring) {
    ring = { buf: new Array(size), next: 0, count: 0, size };
    _rings.set(canonicalKey, ring);
  } else if (ring.size !== size) {
    // The ring size knob changed at call time — re-seat into a new buffer,
    // preserving the most recent samples (most-recent-first, capped at the new
    // size). Rare path (a config flip), correctness over speed.
    const recent = getSamples(canonicalKey); // chronological
    const keep = recent.slice(Math.max(0, recent.length - size));
    ring = { buf: new Array(size), next: 0, count: 0, size };
    for (const v of keep) {
      ring.buf[ring.next] = v;
      ring.next = (ring.next + 1) % size;
      ring.count = Math.min(ring.count + 1, size);
    }
    _rings.set(canonicalKey, ring);
  }
  return ring;
}

/** Record one observed dispatch latency (ms) for a canonical key. Non-finite or
 *  negative samples are ignored (a latency must be a real wall-clock figure). */
export function recordLatency(canonicalKey, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const ring = ringFor(canonicalKey);
  ring.buf[ring.next] = latencyMs;
  ring.next = (ring.next + 1) % ring.size;
  ring.count = Math.min(ring.count + 1, ring.size);
}

/** Chronological list of the retained samples for a canonical key. */
function getSamples(canonicalKey) {
  const ring = _rings.get(canonicalKey);
  if (!ring || ring.count === 0) return [];
  const out = [];
  // Oldest retained sample first. When count < size the buffer filled from index
  // 0; once full, `next` points at the oldest.
  const start = ring.count < ring.size ? 0 : ring.next;
  for (let i = 0; i < ring.count; i++) {
    out.push(ring.buf[(start + i) % ring.size]);
  }
  return out;
}

/**
 * The p95 observed latency (ms) for a canonical key. Returns 0 with fewer than 2
 * samples — too little signal to extend a timeout on (and 0 is a safe no-op for
 * the race-timeout extension). Uses the nearest-rank method on the sorted samples.
 * @param {string} canonicalKey
 * @returns {number} p95 latency in ms, or 0 when under 2 samples
 */
export function getP95(canonicalKey) {
  const samples = getSamples(canonicalKey);
  if (samples.length < 2) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(0.95 * n), 1-indexed.
  const rank = Math.ceil(0.95 * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Build an EWMA stall-watcher for one canonical key. Stateful closure; the caller
 * calls tick() on each delta (and once at stream start to seat the baseline).
 *
 *   tick(now?) -> { stalled:boolean, gapMs:number, ewmaMs:number, thresholdMs:number }
 *
 * The first tick seats the timestamp and reports no stall (no gap yet). Each
 * subsequent tick measures the inter-delta gap, folds it into the EWMA, and flags
 * a stall when the SMOOTHED gap exceeds the threshold. isStalled(now?) checks the
 * gap since the last tick WITHOUT recording one (for a watchdog timer that fires
 * between deltas). Pure observation — never touches the breaker or the ring.
 *
 * @param {string} canonicalKey
 * @returns {{tick:(now?:number)=>object, isStalled:(now?:number)=>boolean, ewma:()=>number}}
 */
export function makeStallWatcher(canonicalKey) {
  const { alpha, thresholdMs } = stallConfig(canonicalKey);
  let lastTick = null;
  let ewma = 0;
  let seeded = false;

  function tick(now = Date.now()) {
    if (lastTick === null) {
      lastTick = now;
      return { stalled: false, gapMs: 0, ewmaMs: 0, thresholdMs };
    }
    const gapMs = Math.max(0, now - lastTick);
    lastTick = now;
    if (!seeded) {
      ewma = gapMs;
      seeded = true;
    } else {
      ewma = alpha * gapMs + (1 - alpha) * ewma;
    }
    return { stalled: ewma > thresholdMs, gapMs, ewmaMs: ewma, thresholdMs };
  }

  function isStalled(now = Date.now()) {
    if (lastTick === null) return false;
    // The live gap since the last delta, blended into the current EWMA the same
    // way a tick would, so a watchdog firing mid-gap sees the same verdict.
    const liveGap = Math.max(0, now - lastTick);
    const projected = seeded ? alpha * liveGap + (1 - alpha) * ewma : liveGap;
    return projected > thresholdMs;
  }

  return { tick, isStalled, ewma: () => ewma };
}

/** Test-only: wipe all latency rings. */
export function _resetLatency() {
  _rings.clear();
}

export default { recordLatency, getP95, makeStallWatcher };
