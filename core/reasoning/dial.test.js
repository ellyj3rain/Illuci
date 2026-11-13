/**
 * The universal reasoning DIAL helper (champion "A-universal-dial", 2026-06-17).
 * Pure functions: normalize the dial, and translate it to each provider's knob shape.
 * The load-bearing invariant: a NULL return is the explicit "no reasoning knob" signal a
 * bridge keys its capability-aware omission on; legacy capability-tier words degrade to null.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIAL_POSITIONS,
  normalizeDial,
  toEffort,
  toCodexEffort,
  toGeminiThinking,
  toOllamaThink,
} from "./dial.js";

test("normalizeDial clamps to a known position, lowercased; legacy/unknown -> null", () => {
  assert.equal(normalizeDial("high"), "high");
  assert.equal(normalizeDial(" XHIGH "), "xhigh");
  assert.equal(normalizeDial("off"), "off");
  // legacy claude capability-tier words are NOT dial positions -> null (degrade to no-op)
  assert.equal(normalizeDial("frontier"), null);
  assert.equal(normalizeDial("balanced"), null);
  assert.equal(normalizeDial("fast"), null);
  // unset / empty / bogus -> null
  assert.equal(normalizeDial(undefined), null);
  assert.equal(normalizeDial(null), null);
  assert.equal(normalizeDial(""), null);
  assert.equal(normalizeDial("nonesuch"), null);
});

test("DIAL_POSITIONS is the ascending dial, frozen ([A110]: minimal is a real position)", () => {
  assert.deepEqual(DIAL_POSITIONS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.throws(() => { DIAL_POSITIONS.push("x"); });
});

test("toEffort -> OpenAI-compatible reasoning_effort enum; off/unknown -> null", () => {
  assert.equal(toEffort("low"), "low");
  assert.equal(toEffort("medium"), "medium");
  assert.equal(toEffort("high"), "high");
  assert.equal(toEffort("xhigh"), "xhigh");
  assert.equal(toEffort("max"), "max");
  assert.equal(toEffort("off"), null);       // off -> caller omits the knob
  assert.equal(toEffort("frontier"), null);  // legacy word -> null
  assert.equal(toEffort(undefined), null);
});

test("[A110] minimal is a REAL position; ultra aliases to the universal top; none -> off", () => {
  assert.equal(normalizeDial("minimal"), "minimal");
  assert.equal(normalizeDial(" MINIMAL "), "minimal");
  assert.equal(normalizeDial("ultra"), "max");
  assert.equal(normalizeDial("none"), "off");
  // per-shape clamping: the generic effort shape has no minimal tier -> low;
  // active postures still count as thinking-on for the boolean shapes.
  assert.equal(toEffort("minimal"), "low");
  assert.equal(toGeminiThinking("minimal"), true);
  assert.equal(toOllamaThink("none"), false);
});

test("toCodexEffort preserves distinct max and ultra settings", () => {
  assert.equal(toCodexEffort("minimal"), "minimal");
  assert.equal(toCodexEffort("low"), "low");
  assert.equal(toCodexEffort("medium"), "medium");
  assert.equal(toCodexEffort("high"), "high");
  assert.equal(toCodexEffort("xhigh"), "xhigh");
  assert.equal(toCodexEffort("max"), "max");
  assert.equal(toCodexEffort("ultra"), "ultra"); // operator-typed alias round-trips
  assert.equal(toCodexEffort("off"), null);      // caller falls to the bridge default
  assert.equal(toCodexEffort("frontier"), null);
  assert.equal(toCodexEffort(undefined), null);
});

test("toGeminiThinking / toOllamaThink -> on/off boolean; unset -> null", () => {
  for (const fn of [toGeminiThinking, toOllamaThink]) {
    assert.equal(fn("high"), true);
    assert.equal(fn("medium"), true);
    assert.equal(fn("max"), true);
    assert.equal(fn("off"), false);
    assert.equal(fn("frontier"), null); // legacy word -> null (emit nothing)
    assert.equal(fn(undefined), null);
    assert.equal(fn(""), null);
  }
});
