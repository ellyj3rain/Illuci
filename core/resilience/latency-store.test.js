/**
 * illuci — DRL latency store (node:test, hermetic)
 *
 * getP95 = 0 under 2 samples; the (tier + p95) * headroom formula composes
 * correctly with resolveRaceTimeout; EWMA stall-watcher flags a stall when the
 * smoothed inter-delta gap exceeds the threshold.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { recordLatency, getP95, makeStallWatcher, _resetLatency } from "./latency-store.js";
import { resolveRaceTimeout } from "../dispatch/adaptive-fallback.js";

beforeEach(() => {
  _resetLatency();
  delete process.env.ILLUCI_DRL_LATENCY_RING_SIZE;
  delete process.env.ILLUCI_DRL_STALL_EWMA_ALPHA;
  delete process.env.ILLUCI_DRL_STALL_THRESHOLD_MS;
});

test("getP95 returns 0 with zero or one sample (too little signal)", () => {
  assert.equal(getP95("deepseek"), 0);
  recordLatency("deepseek", 500);
  assert.equal(getP95("deepseek"), 0, "one sample is still 0");
});

test("getP95 returns a real percentile with >= 2 samples", () => {
  for (let i = 1; i <= 100; i++) recordLatency("deepseek", i * 10); // 10..1000
  // nearest-rank p95 of 1..100 scaled by 10 -> rank ceil(95) = 95 -> value 950
  assert.equal(getP95("deepseek"), 950);
});

test("the ring is bounded and keeps the most recent samples", () => {
  process.env.ILLUCI_DRL_LATENCY_RING_SIZE = "5";
  for (let i = 1; i <= 20; i++) recordLatency("deepseek", i); // only 16..20 retained
  // p95 of [16,17,18,19,20]: rank = ceil(0.95*5)=5 -> 20
  assert.equal(getP95("deepseek"), 20);
});

test("non-finite / negative latencies are ignored", () => {
  recordLatency("deepseek", 100);
  recordLatency("deepseek", NaN);
  recordLatency("deepseek", -5);
  recordLatency("deepseek", 300);
  assert.equal(getP95("deepseek"), 300, "only the two valid samples count");
});

test("FORMULA: race timeout = (tier + p95) * headroom when seated, p95 default 0 is a no-op", () => {
  // No DRL extension (p95Ms omitted -> 0): byte-identical to the pre-DRL formula.
  assert.equal(
    resolveRaceTimeout({ tierTimeoutMs: 300000, seated: true, headroom: 1.3 }),
    390000, // 300000 * 1.3
  );
  // With an observed p95 of 40000: (300000 + 40000) * 1.3 = 442000.
  assert.equal(
    resolveRaceTimeout({ tierTimeoutMs: 300000, seated: true, headroom: 1.3, p95Ms: 40000 }),
    442000,
  );
  // Unseated: p95 still added to the base, but the headroom factor is 1.
  assert.equal(
    resolveRaceTimeout({ tierTimeoutMs: 300000, seated: false, p95Ms: 40000 }),
    340000,
  );
  // An explicit caller timeout STILL wins as-is, ignoring p95.
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: 600000, tierTimeoutMs: 300000, seated: true, headroom: 1.3, p95Ms: 99999 }),
    600000,
  );
});

test("EWMA stall watcher: smoothed gap over threshold flags a stall", () => {
  process.env.ILLUCI_DRL_STALL_EWMA_ALPHA = "0.5";
  process.env.ILLUCI_DRL_STALL_THRESHOLD_MS = "1000";
  const w = makeStallWatcher("deepseek");
  let t = 0;
  w.tick(t);            // seat baseline
  let r = w.tick((t += 200)); // 200ms gap
  assert.equal(r.stalled, false, "fast deltas are not a stall");
  r = w.tick((t += 200));
  assert.equal(r.stalled, false);
  // a big gap pushes the EWMA over the threshold
  r = w.tick((t += 5000));
  assert.equal(r.stalled, true, "a long smoothed gap is a stall");
  assert.ok(r.ewmaMs > 1000);
});

test("EWMA stall watcher: a steady fast stream never stalls", () => {
  process.env.ILLUCI_DRL_STALL_EWMA_ALPHA = "0.2";
  process.env.ILLUCI_DRL_STALL_THRESHOLD_MS = "5000";
  const w = makeStallWatcher("deepseek");
  let t = 0;
  w.tick(t);
  for (let i = 0; i < 50; i++) {
    const r = w.tick((t += 50)); // 50ms cadence
    assert.equal(r.stalled, false);
  }
});

test("per-canonical stall threshold override beats the global default", () => {
  process.env.ILLUCI_DRL_STALL_THRESHOLD_MS = "5000";
  process.env.ILLUCI_DRL_STALL_THRESHOLD_DEEPSEEK = "100"; // tight override for this model
  const w = makeStallWatcher("deepseek");
  let t = 0;
  w.tick(t);
  const r = w.tick((t += 400)); // 400ms > 100ms override
  assert.equal(r.thresholdMs, 100, "the per-canonical override is in effect");
  assert.equal(r.stalled, true);
  delete process.env.ILLUCI_DRL_STALL_THRESHOLD_DEEPSEEK;
});

test("isStalled checks the live gap without recording a tick", () => {
  process.env.ILLUCI_DRL_STALL_THRESHOLD_MS = "1000";
  const w = makeStallWatcher("deepseek");
  w.tick(0);
  w.tick(100); // seed a small ewma
  assert.equal(w.isStalled(150), false, "small live gap, not stalled");
  assert.equal(w.isStalled(9000), true, "a long live gap reads stalled even with no new tick");
});
