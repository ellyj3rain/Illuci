/**
 * illuci — DRL outcome taxonomy (node:test, hermetic)
 *
 * Proves the classification: success / terminal_failure / ignored, where ONLY
 * permanent+unknown errors are terminal, and transient/aborted/paused/blocked/
 * breaker-fast-fail are excluded (never trip the breaker). Also proves
 * recordDispatchOutcome feeds the breaker + latency only for the right outcomes.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { classifyDispatchOutcome, recordDispatchOutcome } from "./outcome.js";
import { getBreakerEntry, isBreakerOpen, _resetBreakers } from "./breaker.js";
import { getP95, _resetLatency } from "./latency-store.js";

beforeEach(() => {
  _resetBreakers();
  _resetLatency();
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "5";
});

// ── classification (pure) ──

test("a real response is success", () => {
  assert.equal(classifyDispatchOutcome({ response: "hi", failed: false }), "success");
});

test("a permanent error is terminal_failure", () => {
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "404 model not found" }), "terminal_failure");
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "401 unauthorized" }), "terminal_failure");
});

test("an unknown error (no transient marker) is terminal_failure", () => {
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "something weird happened" }), "terminal_failure");
});

test("a transient error is IGNORED (withRetry owns it; never trips the breaker)", () => {
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "ECONNRESET" }), "ignored");
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "429 rate limit" }), "ignored");
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "503 temporarily unavailable" }), "ignored");
});

test("an aborted dispatch is IGNORED (cancellation, not a fault)", () => {
  assert.equal(classifyDispatchOutcome({ aborted: true, error: "aborted" }), "ignored");
  assert.equal(classifyDispatchOutcome({ failed: true, response: null, error: "ABORTED" }), "ignored");
});

test("a paused dispatch is IGNORED (operator intent)", () => {
  assert.equal(classifyDispatchOutcome({ skipped: true, reason: "paused" }), "ignored");
});

test("a governance-blocked dispatch is IGNORED (policy, not backend health)", () => {
  assert.equal(classifyDispatchOutcome({ failed: true, blocked: true, response: null, error: "denied" }), "ignored");
});

test("the breaker's own fast-fail is IGNORED (no double-count)", () => {
  assert.equal(classifyDispatchOutcome({ failed: true, breaker: "open", response: null, error: "circuit breaker open" }), "ignored");
  assert.equal(classifyDispatchOutcome({ failed: true, breaker: "half-open-busy", response: null, error: "circuit breaker half-open-busy" }), "ignored");
});

// ── recordDispatchOutcome side effects ──

test("a terminal_failure feeds the breaker; transient does not", () => {
  const tFail = { failed: true, response: null, error: "404 not found" };
  for (let i = 0; i < 5; i++) recordDispatchOutcome("deepseek", tFail, 100);
  assert.equal(isBreakerOpen("deepseek"), true, "5 terminal failures open");

  _resetBreakers();
  const tTransient = { failed: true, response: null, error: "ECONNRESET" };
  for (let i = 0; i < 10; i++) recordDispatchOutcome("deepseek", tTransient, 100);
  assert.equal(isBreakerOpen("deepseek"), false, "transient never trips the breaker");
  assert.equal(getBreakerEntry("deepseek"), null, "ignored outcomes never materialize an entry");
});

test("success and terminal_failure both record latency; ignored does not", () => {
  recordDispatchOutcome("deepseek", { response: "ok" }, 200);
  recordDispatchOutcome("deepseek", { response: "ok" }, 400);
  assert.ok(getP95("deepseek") > 0, "two success samples produce a p95");

  _resetLatency();
  recordDispatchOutcome("deepseek", { aborted: true, error: "aborted" }, 999);
  recordDispatchOutcome("deepseek", { skipped: true, reason: "paused" }, 999);
  assert.equal(getP95("deepseek"), 0, "ignored outcomes record no latency");
});

test("the returned OutcomeRecord carries the canonical key + terminal flag", () => {
  const rec = recordDispatchOutcome("claude-local", { failed: true, response: null, error: "404 not found" }, 123);
  assert.equal(rec.canonicalKey, "claude-fable", "alias canonicalized in the record");
  assert.equal(rec.outcome, "terminal_failure");
  assert.equal(rec.terminal, true);
  assert.equal(rec.latencyMs, 123);
});
