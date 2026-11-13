/**
 * illuci — AMD-8: haltReason honesty (node:test, hermetic)
 *
 * The bug: a gated phase that failed for ANY reason set trace.haltReason to the
 * hardcoded literal "Gate check failed", collapsing three distinct content-gate
 * failure modes (a dead seat / an all-empty phase / a low-confidence vote) into one
 * opaque string. The fix populates a distinct gateReason per mode and assigns
 * trace.haltReason = phaseResult.gateReason.
 *
 * These tests exercise the pure classifier classifyGateResult (extracted from the
 * runner's inline gate block) directly — hermetic, no dispatch/bridge graph — and
 * assert the trace.haltReason assignment CONTRACT lexically against runner.js source
 * (the full runner run touches the live dispatch graph, so the source-grep guards the
 * assignment site the same way dispatch.enforce.test.js guards its call sites).
 *
 * Run: node --test illuci/core/topologies/runner.gate-haltreason.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyGateResult } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "runner.js"), "utf-8");
const LIVE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ─── The three distinct fail modes each get their OWN reason ───────────────────

test("AMD-8: a seat error/timeout surfaces 'seat-error' (NOT 'Gate check failed')", () => {
  // A seat that threw / errored / timed out lands in the response as { error }.
  const phaseResult = {
    responses: [
      { model: "deepseek", response: "a real answer" },
      { model: "kimi", error: "TIMEOUT" }, // the timed-out / errored seat
    ],
  };
  const gate = classifyGateResult(phaseResult, null);
  assert.equal(gate.status, "fail");
  assert.equal(gate.reason, "seat-error");
  assert.notEqual(gate.reason, "Gate check failed");
});

test("AMD-8: an all-empty phase surfaces 'all-empty'", () => {
  const phaseResult = {
    responses: [
      { model: "deepseek", response: "" },
      { model: "kimi", response: null },
    ],
  };
  const gate = classifyGateResult(phaseResult, null);
  assert.equal(gate.status, "fail");
  assert.equal(gate.reason, "all-empty");
});

test("AMD-8: a phase with zero responses is all-empty (vacuous-every parity with the old inline)", () => {
  const gate = classifyGateResult({ responses: [] }, null);
  assert.equal(gate.status, "fail");
  assert.equal(gate.reason, "all-empty");
});

test("AMD-8: below-confidence keeps the existing systemConfidence reason", () => {
  const phaseResult = {
    responses: [{ model: "a", response: "x" }, { model: "b", response: "y" }],
    calibration: { systemConfidence: 0.31 },
  };
  const gate = classifyGateResult(phaseResult, 0.6);
  assert.equal(gate.status, "fail");
  assert.match(gate.reason, /^systemConfidence 0\.31 < min 0\.6$/);
});

test("AMD-8: precedence — seat-error wins over emptiness and confidence", () => {
  // A phase that is BOTH errored AND below confidence reports the most proximate cause.
  const phaseResult = {
    responses: [{ model: "a", error: "boom" }],
    calibration: { systemConfidence: 0.1 },
  };
  assert.equal(classifyGateResult(phaseResult, 0.9).reason, "seat-error");
});

// ─── A passing gate stays passing ──────────────────────────────────────────────

test("AMD-8: a healthy phase passes with no reason", () => {
  const phaseResult = {
    responses: [{ model: "a", response: "good" }, { model: "b", response: "also good" }],
    calibration: { systemConfidence: 0.95 },
  };
  const gate = classifyGateResult(phaseResult, 0.6);
  assert.equal(gate.status, "pass");
  assert.equal(gate.reason, null);
});

test("AMD-8: a null systemConfidence does NOT trip the confidence floor", () => {
  // A single-response phase has no calibration; systemConfidence null must not fail.
  const phaseResult = { responses: [{ model: "a", response: "solo" }], calibration: { systemConfidence: null } };
  const gate = classifyGateResult(phaseResult, 0.6);
  assert.equal(gate.status, "pass");
});

// ─── The assignment site: trace.haltReason is sourced from gateReason, not a literal ─

test("AMD-8: trace.haltReason is assigned from phaseResult.gateReason (not the bare literal)", () => {
  // The OLD bug was the unconditional literal assignment. Guard that the live
  // assignment now reads gateReason, with the literal surviving only as a fallback.
  assert.match(
    LIVE,
    /trace\.haltReason\s*=\s*phaseResult\.gateReason\s*\|\|\s*["']Gate check failed["']/,
    "trace.haltReason must be sourced from the classified gateReason (literal is only the fallback)",
  );
  // And the gate block routes through the pure classifier (single source of truth).
  assert.match(LIVE, /classifyGateResult\(\s*phaseResult\s*,\s*minConfidence\s*\)/,
    "the gate block must delegate classification to classifyGateResult");
  // The OLD unconditional-literal assignment is gone.
  assert.doesNotMatch(
    LIVE,
    /trace\.haltReason\s*=\s*["']Gate check failed["']\s*;/,
    "the hardcoded unconditional `trace.haltReason = \"Gate check failed\";` must be gone",
  );
});

// ─── The operator dispatch/abort gate keeps its OWN distinct reasons ─────────────

test("AMD-8: real operator/budget halts keep their own distinct reasons (not relabeled)", () => {
  // These are decided at their own layers and must NOT be collapsed into the content-gate
  // reasons — confirm both distinct reason strings still exist verbatim in the runner.
  assert.match(LIVE, /trace\.haltReason\s*=\s*["']Operator aborted at fire-control checkpoint["']/);
  assert.match(LIVE, /trace\.haltReason\s*=\s*["']Token budget exhausted["']/);
});
