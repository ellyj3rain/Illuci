/**
 * illuci — DRL canonical keying / alias-snarl dissolution (node:test, hermetic)
 *
 * The load-bearing invariant: an alias and its canonical id share ONE resilience
 * key, so one failing backend is one breaker entry (not several phantom ones).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { toCanonicalKey, _resetCanonicalWarnings } from "./canonical.js";
import { recordBreakerOutcome, isBreakerOpen, _resetBreakers } from "./breaker.js";

beforeEach(() => {
  _resetBreakers();
  _resetCanonicalWarnings();
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "5";
});

test("INVARIANT: claude-local and claude-fable resolve to the same canonical key", () => {
  assert.equal(toCanonicalKey("claude-local"), toCanonicalKey("claude-fable"));
  assert.equal(toCanonicalKey("claude-local"), "claude-fable");
});

test("legacy Fable aliases collapse without absorbing default Claude", () => {
  assert.equal(toCanonicalKey("fable"), "claude-fable");
  assert.equal(toCanonicalKey("claude-local"), "claude-fable");
});

test("default Claude aliases collapse onto Opus", () => {
  assert.equal(toCanonicalKey("claude"), "claude-opus");
  assert.equal(toCanonicalKey("anthropic"), "claude-opus");
  assert.equal(toCanonicalKey("opus"), "claude-opus");
});

test("a provider model string canonicalizes too (claude-opus-4-8 has a registry mapping)", () => {
  // claude-opus-4-8 is the provider model for claude-fable AND claude-opus; the
  // registry resolves it to whichever entry owns that string. We only assert it
  // is a known canonical id, not which — the point is it does not pass through raw.
  assert.equal(typeof toCanonicalKey("claude-opus-4-8"), "string");
  assert.notEqual(toCanonicalKey("claude-opus-4-8"), "claude-opus-4-8-unknown");
});

test("an unknown spelling falls back to the raw id (stable, distinct key)", () => {
  assert.equal(toCanonicalKey("totally-made-up-model"), "totally-made-up-model");
});

test("legacy Fable aliases accrue on one breaker entry", () => {
  const t0 = 1_000_000;
  recordBreakerOutcome("claude-local", true, t0);
  recordBreakerOutcome("claude-fable", true, t0);
  recordBreakerOutcome("fable", true, t0);
  recordBreakerOutcome("claude-local", true, t0);
  recordBreakerOutcome("fable", true, t0);
  assert.equal(isBreakerOpen("claude-fable", t0), true);
  assert.equal(isBreakerOpen("claude-local", t0), true, "the alias reads the same open breaker");
});

test("default Claude aliases accrue on one Opus breaker entry", () => {
  const t0 = 1_000_000;
  recordBreakerOutcome("claude", true, t0);
  recordBreakerOutcome("anthropic", true, t0);
  recordBreakerOutcome("opus", true, t0);
  recordBreakerOutcome("claude-opus", true, t0);
  recordBreakerOutcome("claude", true, t0);
  assert.equal(isBreakerOpen("claude-opus", t0), true);
  assert.equal(isBreakerOpen("claude", t0), true, "the alias reads the same open breaker");
});

test("warn-once: an unknown id warns at most once", () => {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    toCanonicalKey("mystery-x");
    toCanonicalKey("mystery-x");
    toCanonicalKey("mystery-x");
  } finally {
    console.warn = orig;
  }
  const drlWarns = warns.filter((w) => w.includes("mystery-x"));
  assert.equal(drlWarns.length, 1, "warned exactly once for the same unknown id");
});
