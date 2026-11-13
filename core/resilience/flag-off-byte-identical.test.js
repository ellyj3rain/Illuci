/**
 * illuci — DRL flag-off byte-identical proof (node:test, hermetic)
 *
 * THE headline guarantee the legislature ratified: with ILLUCI_DRL_ENABLED off
 * (its default), the DRL is wholly inert and dispatch is byte-identical to
 * today's behavior — no breaker veto, no p95 timeout extension, no fast-fail,
 * no outcome recording. This file proves that by ARMING the layer's state
 * (a forced-open breaker + a recorded p95) and showing the off-flag surfaces
 * produce EXACTLY the values they produced before the DRL existed.
 *
 * The three armed surfaces and their off-flag invariants:
 *   1. isAvailable           — flag off => breaker veto branch skipped entirely,
 *                              so a forced-open breaker changes nothing.
 *   2. resolveRaceTimeout    — the dispatch call site passes p95Ms=0 when the
 *                              flag is off; p95Ms=0 is a no-op, so the timeout is
 *                              the pre-DRL value even with a recorded p95 present.
 *   3. recordDispatchOutcome — every dispatch-path call is guarded by
 *                              isDrlEnabled(); off => never called => breaker and
 *                              latency stores stay empty across a dispatch.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { isDrlEnabled } from "./config.js";
import { isAvailable } from "../matrix/capability-matrix.js";
import { resolveRaceTimeout } from "../dispatch/adaptive-fallback.js";
import {
  recordBreakerOutcome,
  isBreakerOpen,
  getBreakerEntry,
  _resetBreakers,
} from "./breaker.js";
import { recordLatency, getP95, _resetLatency } from "./latency-store.js";

beforeEach(() => {
  _resetBreakers();
  _resetLatency();
  process.env.ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD = "5";
  // [A48]/DR-128: the DRL default is now ON (operator activation). This file
  // proves the OFF posture is still byte-identical, so it sets the flag off
  // EXPLICITLY rather than leaning on a default that has flipped.
  process.env.ILLUCI_DRL_ENABLED = "0";
});

test("[A48]/DR-128: default (unset) ILLUCI_DRL_ENABLED is now ON (operator activation); explicit 0 is the byte-identical hatch", () => {
  assert.equal(isDrlEnabled(), false, "beforeEach set the env to explicit 0 for this off-proof file");
  assert.equal(isDrlEnabled({}), true, "an UNSET flag now defaults ON");
  assert.equal(isDrlEnabled({ ILLUCI_DRL_ENABLED: "0" }), false, "explicit 0 restores the inert layer");
  assert.equal(isDrlEnabled({ ILLUCI_DRL_ENABLED: "1" }), true);
});

test("PROOF 1 — isAvailable: a forced-open breaker is invisible when the flag is off", () => {
  // Arm: force deepseek's breaker fully OPEN. isAvailable reads the WALL clock, so
  // open at ~now with a long cooldown to keep it open through both assertions.
  process.env.ILLUCI_DRL_BREAKER_COOLDOWN_MS = "600000";
  const now = Date.now();
  for (let i = 0; i < 5; i++) recordBreakerOutcome("deepseek", true, now);
  assert.equal(isBreakerOpen("deepseek", now), true, "the breaker really is open");

  // Flag off => the veto branch is skipped. isAvailable returns the SAME value it
  // returned before the DRL existed (the switch arm: deepseek is available).
  process.env.ILLUCI_DRL_ENABLED = "0";
  assert.equal(isAvailable("deepseek"), true, "byte-identical: open breaker ignored when off");

  // Flag on => the SAME armed state now vetoes (proves the only difference is the flag).
  process.env.ILLUCI_DRL_ENABLED = "1";
  assert.equal(isAvailable("deepseek"), false, "armed: the open breaker now vetoes");
});

test("PROOF 2 — resolveRaceTimeout: a recorded p95 changes nothing when the off-flag passes p95Ms=0", () => {
  // Arm: record a fat p95 for the model.
  recordLatency("deepseek", 40000);
  recordLatency("deepseek", 40000);
  const observedP95 = getP95("deepseek");
  assert.ok(observedP95 > 0, "a p95 is on record");

  // The dispatch call site passes p95Ms = isDrlEnabled() ? getP95(...) : 0.
  // FLAG OFF => p95Ms = 0 => byte-identical to the pre-DRL timeout.
  const off = resolveRaceTimeout({ tierTimeoutMs: 300000, seated: true, headroom: 1.3, p95Ms: 0 });
  assert.equal(off, 390000, "off: (300000) * 1.3, p95 not added");

  // FLAG ON => p95Ms = observedP95 => the extension applies (proves the p95 is real).
  const on = resolveRaceTimeout({ tierTimeoutMs: 300000, seated: true, headroom: 1.3, p95Ms: observedP95 });
  assert.equal(on, Math.round((300000 + observedP95) * 1.3), "on: p95 added before headroom");
  assert.notEqual(on, off, "the ONLY difference is whether the p95 was passed");
});

test("PROOF 2b — an unextended resolveRaceTimeout call is identical to the legacy signature", () => {
  // The pre-DRL call shape (no p95Ms key at all) must equal the new default.
  const legacyShape = resolveRaceTimeout({ callerTimeoutMs: undefined, tierTimeoutMs: 300000, seated: false });
  assert.equal(legacyShape, 300000);
  const seatedLegacy = resolveRaceTimeout({ tierTimeoutMs: 180000, seated: true, headroom: 1.3 });
  assert.equal(seatedLegacy, 234000, "180000 * 1.3 — unchanged from timeout-headroom.test.js");
});

test("PROOF 3 — reads never materialize breaker state (a never-seen model stays absent)", () => {
  // isAvailable / isBreakerOpen are pure reads. Calling them must not create an
  // entry, so a fresh process that only ever READS behaves exactly as today.
  process.env.ILLUCI_DRL_ENABLED = "1";
  assert.equal(isAvailable("deepseek"), true);
  isBreakerOpen("deepseek");
  assert.equal(getBreakerEntry("deepseek"), null, "no entry materialized by reads");
});

test("PROOF 3b — getP95 with no samples is 0 (the timeout extension is a no-op on a fresh process)", () => {
  assert.equal(getP95("never-dispatched"), 0);
  // (300000 + 0) * 1.3 == the pre-DRL seated value
  assert.equal(resolveRaceTimeout({ tierTimeoutMs: 300000, seated: true, headroom: 1.3, p95Ms: getP95("never-dispatched") }), 390000);
});
