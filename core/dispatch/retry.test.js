/**
 * illuci — Dispatch Resilience tests (node:test)
 *
 * Core-loop remediation 2: proves the audit's "one transient error is fatal"
 * and "errors unclassified" findings are closed.
 *
 * Run: node --test illuci/core/dispatch/retry.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyError, isRetryable, withRetry } from "./retry.js";

const noSleep = async () => {}; // deterministic: no real backoff wait

test("classifyError distinguishes aborted / permanent / transient", () => {
  assert.equal(classifyError(new Error("ABORTED")), "aborted");
  assert.equal(classifyError(Object.assign(new Error("x"), { name: "AbortError" })), "aborted");
  assert.equal(classifyError(new Error("401 unauthorized")), "permanent");
  assert.equal(classifyError(new Error("Unknown model: zzz")), "permanent");
  assert.equal(classifyError(new Error("ECONNRESET")), "transient");
  assert.equal(classifyError(new Error("Ollama 500: Internal Server Error")), "transient");
  assert.equal(classifyError(new Error("529 overloaded")), "transient");
  assert.equal(classifyError(new Error("fetch failed")), "transient");
  // a timeout is NOT retried at the dispatch level (tier-fallback owns it)
  assert.notEqual(classifyError(new Error("TIMEOUT")), "transient");
});

test("isRetryable is true only for transient", () => {
  assert.equal(isRetryable(new Error("ECONNRESET")), true);
  assert.equal(isRetryable(new Error("401")), false);
  assert.equal(isRetryable(new Error("ABORTED")), false);
});

test("withRetry succeeds on a later attempt after transient failures", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error("ECONNRESET");
    return "ok";
  }, { maxAttempts: 3, sleep: noSleep, jitter: false });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry never retries a permanent error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("401 unauthorized"); }, { maxAttempts: 5, sleep: noSleep }),
    /401/,
  );
  assert.equal(calls, 1);
});

test("withRetry never retries an abort", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("ABORTED"); }, { maxAttempts: 5, sleep: noSleep }),
    /ABORTED/,
  );
  assert.equal(calls, 1);
});

test("withRetry exhausts maxAttempts then throws the last error", async () => {
  let calls = 0;
  const retries = [];
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("503 service unavailable"); }, {
      maxAttempts: 3, sleep: noSleep, jitter: false, onRetry: (i) => retries.push(i.nextAttempt),
    }),
    /503/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(retries, [2, 3]); // two retries logged before the final throw
});

test("withRetry stops immediately on an already-aborted signal", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; return "never"; }, { signal: ctrl.signal, sleep: noSleep }),
    /ABORTED/,
  );
  assert.equal(calls, 0);
});

test("an unknown error is retried at most once", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("weird unrecognized failure"); }, { maxAttempts: 5, sleep: noSleep }),
  );
  assert.equal(calls, 2); // first attempt + one cautious retry, then give up
});

test('withRetry honors explicit uncertain-outcome and no-retry markers', async () => {
  for (const marker of [{retrySafe:false},{outcome:'unknown'}]) {
    let calls=0;
    await assert.rejects(withRetry(async()=>{calls++;throw Object.assign(Error('ECONNRESET'),marker);},{maxAttempts:3,sleep:noSleep}),/ECONNRESET/);
    assert.equal(calls,1);
  }
});
