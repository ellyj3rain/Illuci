// Phase F harden — STRESS: the throttle under a concurrent-acquire storm.
//
// Drives the REAL acquireSlot / releaseSlot on one provider key. Two hardened
// contracts are asserted together:
//   (1) INVARIANT — observed inflight never exceeds concurrencyLimit (the property
//       batch 2's worker-thread mutex reuses through the shimmable acquireSlot seam).
//   (2) LIVENESS — under heavy contention ALL acquires complete, with ZERO timeouts,
//       within a tight time bound. The un-hardened acquireSlot polls with a FIXED
//       ~1000ms backoff and a 30-attempt ceiling, so heavy contention both collapses
//       throughput (tens of seconds) AND times acquires out (the loop throws). The
//       hardened reserve/wakeup path clears the bound and never spuriously times out.
//
// (2) is the fail-now lever: against the un-hardened throttle this suite exceeds the
// time bound and records timeouts. Written to the intended post-harden contract.
//
// Each test uses a UNIQUE provider key so the module-private sliding-window state never
// bleeds between tests (the throttle exposes no window reset). node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireSlot, releaseSlot, setLimits, removeLimits, getThrottleStatus } from "./throttle.js";

const UNLIMITED = { requestsPerMinute: 1e9, tokensPerMinute: 1e12, minDelayMs: 0 };

async function drive({ key, limit, n, holdMs, deadlineMs }) {
  setLimits(key, { ...UNLIMITED, concurrencyLimit: limit });

  let inflight = 0;
  let maxInflight = 0;
  let completed = 0;
  let timeouts = 0;

  async function one() {
    try {
      await acquireSlot(key);
    } catch {
      timeouts += 1; // the un-hardened loop throws after maxAttempts
      return;
    }
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
    await new Promise((r) => setTimeout(r, holdMs));
    inflight -= 1;
    releaseSlot(key, 1);
    completed += 1;
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, one));
  const elapsed = Date.now() - t0;

  removeLimits(key);
  return { maxInflight, completed, timeouts, elapsed, deadlineMs };
}

test("throttle: 64 concurrent acquires on one provider never exceed the limit", async () => {
  // 64 acquires, limit 4, ~10ms hold. Ideal serial-by-limit work is ~64*10/4 = 160ms.
  // Hardened: well under the 4s bound, zero timeouts. Un-hardened busy-poll: seconds-to
  // -tens-of-seconds + timeouts → both liveness assertions fail now.
  const r = await drive({ key: "stress-throttle-a", limit: 4, n: 64, holdMs: 10, deadlineMs: 4000 });

  assert.ok(r.maxInflight <= 4, `inflight never exceeded the limit (saw ${r.maxInflight})`);
  assert.ok(r.maxInflight >= 1, "at least one slot was actually taken");
  assert.equal(r.timeouts, 0, `no acquire timed out (had ${r.timeouts})`);
  assert.equal(r.completed, 64, `all 64 acquires completed (had ${r.completed})`);
  assert.ok(r.elapsed < r.deadlineMs, `completed within the bound (took ${r.elapsed}ms, bound ${r.deadlineMs}ms)`);
});

test("throttle: a tighter limit with more pressure still bounds inflight + completes", async () => {
  // Limit 2, 48 acquires, 8ms hold. Tighter cap = more blocked waiters = more busy-poll
  // waves on the un-hardened path. Hardened clears it cleanly.
  const r = await drive({ key: "stress-throttle-b", limit: 2, n: 48, holdMs: 8, deadlineMs: 4000 });

  assert.ok(r.maxInflight <= 2, `inflight never exceeded the limit (saw ${r.maxInflight})`);
  assert.equal(r.timeouts, 0, `no acquire timed out (had ${r.timeouts})`);
  assert.equal(r.completed, 48, `all 48 acquires completed (had ${r.completed})`);
  assert.ok(r.elapsed < r.deadlineMs, `completed within the bound (took ${r.elapsed}ms)`);
});

test("throttle: limit 1 serializes without losing or deadlocking any acquire", async () => {
  // The degenerate cap — strict serialization. Every acquire must still complete, in
  // order-independent total, none stranded.
  const r = await drive({ key: "stress-throttle-c", limit: 1, n: 24, holdMs: 5, deadlineMs: 4000 });

  assert.ok(r.maxInflight <= 1, `strictly serialized (saw ${r.maxInflight})`);
  assert.equal(r.timeouts, 0, "no acquire timed out");
  assert.equal(r.completed, 24, "all 24 acquires completed");
  assert.ok(r.elapsed < r.deadlineMs, `completed within the bound (took ${r.elapsed}ms)`);
});

test("throttle: window settles to zero inflight after the storm (no leaked slot)", async () => {
  const key = "stress-throttle-d";
  const r = await drive({ key, limit: 4, n: 40, holdMs: 6, deadlineMs: 4000 });
  assert.equal(r.completed, 40, "all completed");
  assert.equal(r.timeouts, 0, "no timeouts");
  // After every release, the live window must show zero in-flight — no slot leaked.
  // Re-set the key to read status, then remove it again (drive removed it).
  setLimits(key, { ...UNLIMITED, concurrencyLimit: 4 });
  const status = getThrottleStatus()[key];
  removeLimits(key);
  assert.equal(status.inflight, 0, `no slot leaked after the storm (inflight=${status.inflight})`);
});
