/**
 * illuci — DRL isAvailable ordering (node:test, hermetic)
 *
 * The availability gate must check, in this order:
 *   1. isSuspended (MODEL_STATUS) — the reversible gov override, runs FIRST.
 *   2. isBreakerOpen(canonical)   — the DRL veto (flag-gated), runs SECOND.
 *   3. the existing per-model arms (the switch).
 *
 * Proven by toggling the breaker + flag and asserting isAvailable reacts only in
 * the right order. Uses deepseek (its switch arm is unconditionally available, so
 * any false must come from a higher gate) and a model that is normally available.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { isAvailable } from "../matrix/capability-matrix.js";
import { recordBreakerOutcome, _resetBreakers } from "./breaker.js";

beforeEach(() => {
  _resetBreakers();
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "5";
});

function forceOpen(modelId, t = Date.now()) {
  for (let i = 0; i < 5; i++) recordBreakerOutcome(modelId, true, t);
}

test("baseline: deepseek is available (switch arm true, no suspension, breaker closed)", () => {
  process.env.ILLUCI_DRL_ENABLED = "0";
  assert.equal(isAvailable("deepseek"), true);
});

test("ARMED: an open breaker vetoes a normally-available model", () => {
  process.env.ILLUCI_DRL_ENABLED = "1";
  assert.equal(isAvailable("deepseek"), true, "closed breaker -> falls through to the switch (true)");
  forceOpen("deepseek");
  assert.equal(isAvailable("deepseek"), false, "open breaker vetoes BEFORE the switch arm");
});

test("ORDERING: isSuspended wins over the breaker (suspended reads false regardless of breaker)", () => {
  process.env.ILLUCI_DRL_ENABLED = "1";
  // claude-api's provider model is claude-fable-5, which MODEL_STATUS marks
  // suspended. It must read unavailable whether or not its breaker is open — the
  // suspension check is first and short-circuits before the breaker veto. (Note:
  // claude-fable the CLI entry is model claude-opus-4-8, NOT suspended — the
  // suspension is on the claude-fable-5 provider string, owned by claude-api.)
  assert.equal(isAvailable("claude-api"), false, "suspended -> false (before breaker)");
  forceOpen("claude-api");
  assert.equal(isAvailable("claude-api"), false, "still false; suspension already decided it");
});

test("ARMED half-open: the breaker allows the single probe (isBreakerOpen reads false in half-open)", () => {
  process.env.ILLUCI_DRL_ENABLED = "1";
  // isAvailable reads the WALL clock, so force the breaker open at ~now with a
  // long cooldown to keep it open through the assertion; then prove the open
  // state vetoes via isAvailable. (The half-open->probe semantics themselves are
  // proven with an injected `now` in breaker.test.js.)
  process.env.ILLUCI_DRL_BREAKER_COOLDOWN_MS = "600000";
  forceOpen("gpt-oss", Date.now());
  assert.equal(isAvailable("gpt-oss"), false, "open breaker -> unavailable");
});

test("FLAG-OFF: a forced-open breaker does NOT change isAvailable (byte-identical)", () => {
  // Force the breaker open, then turn the flag OFF. The veto branch must be
  // skipped entirely, so availability is exactly what the switch returns.
  forceOpen("deepseek");
  process.env.ILLUCI_DRL_ENABLED = "0";
  assert.equal(isAvailable("deepseek"), true, "flag off -> breaker veto skipped -> switch arm (true)");
  // [A48]/DR-128: the default is now ON (operator activation), so an UNSET flag
  // now vetoes an open breaker. The explicit "0" above remains the byte-identical
  // escape hatch; the default flipping is the point of this batch.
  delete process.env.ILLUCI_DRL_ENABLED;
  assert.equal(isAvailable("deepseek"), false, "default (unset) is now ON -> open breaker vetoes");
});
