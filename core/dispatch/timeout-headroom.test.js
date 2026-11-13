/**
 * illuci - Dispatch timeout headroom (node:test)
 *
 * AMD-7 proving tests. A SEATED council/composition member carries composition-
 * prefix + agentic-loop overhead the bare-query reasoning-tier ceilings were
 * never tuned for, so the unmodified 300s xhigh guillotined a long build seat
 * (twice). resolveRaceTimeout gives a seated run an env-tunable headroom
 * multiplier (default 1.3) while an explicit caller timeout still wins as-is and
 * an unseated query stays byte-identical to the tier ceiling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSeatTimeoutHeadroom, resolveRaceTimeout } from "./adaptive-fallback.js";

test("resolveSeatTimeoutHeadroom: defaults to 1.3 when env is unset or blank", () => {
  assert.equal(resolveSeatTimeoutHeadroom({}), 1.3);
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "" }), 1.3);
});

test("resolveSeatTimeoutHeadroom: honors an env override", () => {
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "2" }), 2);
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "1.5" }), 1.5);
});

test("resolveSeatTimeoutHeadroom: clamps a <1 or non-numeric value to 1.3 (never shortens)", () => {
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "0.5" }), 1.3);
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "-4" }), 1.3);
  assert.equal(resolveSeatTimeoutHeadroom({ ILLUCI_SEAT_TIMEOUT_HEADROOM: "abc" }), 1.3);
});

test("resolveRaceTimeout: an explicit caller timeout wins as-is, even when seated", () => {
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: 600000, tierTimeoutMs: 300000, seated: true, headroom: 1.3 }),
    600000,
  );
});

test("resolveRaceTimeout: a SEATED run gets the headroom multiplier on the tier ceiling", () => {
  // 300000 * 1.3 = 390000 - the AMD-7 fix: the build seat is no longer cut at 300s.
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: undefined, tierTimeoutMs: 300000, seated: true, headroom: 1.3 }),
    390000,
  );
});

test("resolveRaceTimeout: an UNSEATED query is byte-identical to the tier ceiling (no headroom)", () => {
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: undefined, tierTimeoutMs: 300000, seated: false, headroom: 1.3 }),
    300000,
  );
});

test("resolveRaceTimeout: an invalid tier falls back to the 180s base", () => {
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: undefined, tierTimeoutMs: undefined, seated: false }),
    180000,
  );
  // seated invalid-tier base with default headroom: 180000 * 1.3 = 234000
  assert.equal(
    resolveRaceTimeout({ callerTimeoutMs: undefined, tierTimeoutMs: 0, seated: true, headroom: 1.3 }),
    234000,
  );
});
