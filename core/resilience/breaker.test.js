/**
 * illuci — DRL breaker state machine (node:test, hermetic)
 *
 * closed -> open (failureThreshold) -> half-open (cooldown) -> closed
 * (successThreshold), with halfOpenMax = 1. Every test resets state and pins the
 * thresholds via env so it is deterministic and order-independent. A controllable
 * `now` is threaded through every breaker call so no test sleeps.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isBreakerOpen,
  assertBreakerAllowsDispatch,
  recordBreakerOutcome,
  setOnBreakerOpen,
  getBreakerEntry,
  _resetBreakers,
} from "./breaker.js";

beforeEach(() => {
  _resetBreakers();
  setOnBreakerOpen(null);
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "5";
  process.env.ILLUCI_DRL_BREAKER_COOLDOWN_MS = "30000";
  process.env.ILLUCI_DRL_BREAKER_SUCCESS_THRESHOLD = "2";
});

test("a never-seen model has no entry and reads closed/allowed", () => {
  assert.equal(isBreakerOpen("claude-fable"), false);
  assert.deepEqual(assertBreakerAllowsDispatch("claude-fable"), { allowed: true });
  // a READ must never materialize an entry
  assert.equal(getBreakerEntry("claude-fable"), null);
});

test("closed -> open after exactly failureThreshold consecutive terminal failures", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) recordBreakerOutcome("deepseek", true, t0);
  assert.equal(isBreakerOpen("deepseek", t0), false, "4 < threshold(5) stays closed");
  recordBreakerOutcome("deepseek", true, t0); // the 5th
  assert.equal(isBreakerOpen("deepseek", t0), true, "5th consecutive failure opens");
});

test("a success resets the consecutive-failure streak (failures must be consecutive)", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) recordBreakerOutcome("deepseek", true, t0);
  recordBreakerOutcome("deepseek", false, t0); // success resets the streak
  for (let i = 0; i < 4; i++) recordBreakerOutcome("deepseek", true, t0);
  assert.equal(isBreakerOpen("deepseek", t0), false, "streak reset means 4 again is not enough");
  recordBreakerOutcome("deepseek", true, t0);
  assert.equal(isBreakerOpen("deepseek", t0), true);
});

test("open -> half-open after cooldown (lazy, read-driven)", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) recordBreakerOutcome("deepseek", true, t0);
  assert.equal(isBreakerOpen("deepseek", t0), true);
  // before cooldown elapses: still open
  assert.equal(isBreakerOpen("deepseek", t0 + 29_999), true);
  assert.deepEqual(assertBreakerAllowsDispatch("deepseek", t0 + 29_999), { allowed: false, reason: "open" });
  // at/after cooldown: transitions to half-open on the read; open-veto lifts
  assert.equal(isBreakerOpen("deepseek", t0 + 30_000), false);
  assert.equal(getBreakerEntry("deepseek", t0 + 30_000).state, "half-open");
});

test("half-open allows exactly ONE probe (halfOpenMax = 1); a second is busy", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) recordBreakerOutcome("deepseek", true, t0);
  const tHalf = t0 + 30_000;
  // first probe reserved
  assert.deepEqual(assertBreakerAllowsDispatch("deepseek", tHalf), { allowed: true });
  // second concurrent probe is rejected while the first is in flight
  assert.deepEqual(assertBreakerAllowsDispatch("deepseek", tHalf), { allowed: false, reason: "half-open-busy" });
});

test("half-open -> closed after successThreshold probe successes", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) recordBreakerOutcome("deepseek", true, t0);
  const tHalf = t0 + 30_000;
  // probe 1: reserve + success
  assert.equal(assertBreakerAllowsDispatch("deepseek", tHalf).allowed, true);
  recordBreakerOutcome("deepseek", false, tHalf);
  assert.equal(getBreakerEntry("deepseek", tHalf).state, "half-open", "1 success < threshold(2)");
  // probe 2: reserve + success -> closes
  assert.equal(assertBreakerAllowsDispatch("deepseek", tHalf).allowed, true);
  recordBreakerOutcome("deepseek", false, tHalf);
  assert.equal(getBreakerEntry("deepseek", tHalf).state, "closed");
  assert.equal(isBreakerOpen("deepseek", tHalf), false);
});

test("half-open -> open immediately on a probe failure, cooldown restarts", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) recordBreakerOutcome("deepseek", true, t0);
  const tHalf = t0 + 30_000;
  assert.equal(assertBreakerAllowsDispatch("deepseek", tHalf).allowed, true);
  recordBreakerOutcome("deepseek", true, tHalf); // probe failed
  const entry = getBreakerEntry("deepseek", tHalf);
  assert.equal(entry.state, "open");
  assert.equal(entry.cooldownUntil, tHalf + 30_000, "cooldown restarts from the probe-failure time");
});

test("onBreakerOpen hook fires once on the closed->open transition (not on each subsequent failure)", () => {
  const t0 = 1_000_000;
  const fired = [];
  setOnBreakerOpen((key) => fired.push(key));
  for (let i = 0; i < 5; i++) recordBreakerOutcome("gpt-oss", true, t0);
  assert.deepEqual(fired, ["gpt-oss"], "fires exactly once on open");
  recordBreakerOutcome("gpt-oss", true, t0); // already open
  assert.deepEqual(fired, ["gpt-oss"], "no re-fire while it stays open");
});

test("a hook throw never corrupts the state machine", () => {
  const t0 = 1_000_000;
  setOnBreakerOpen(() => { throw new Error("self-heal boom"); });
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) recordBreakerOutcome("gpt-oss", true, t0); });
  assert.equal(isBreakerOpen("gpt-oss", t0), true);
});

test("env thresholds are read at call time (a flip takes effect on the next record)", () => {
  const t0 = 1_000_000;
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "2";
  recordBreakerOutcome("qwen-code", true, t0);
  recordBreakerOutcome("qwen-code", true, t0);
  assert.equal(isBreakerOpen("qwen-code", t0), true, "threshold 2 opens on the 2nd failure");
});
