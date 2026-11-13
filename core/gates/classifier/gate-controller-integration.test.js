/**
 * illuci — Action Classifier · gate-controller insertion tests
 * (node:test, hermetic — ILLUCI_GATE_MODE=headless so no operator prompt is ever
 *  awaited; no callback channel registered; no real writes)
 *
 * IMPORTANT — import ordering: gate-controller.js captures the transport MODE
 * from process.env.ILLUCI_GATE_MODE at IMPORT time (const MODE = ...). A static
 * `import` hoists above all statements, so it would run before we could set the
 * env and would default MODE to "cli" (the interactive prompt — a hang under
 * --test). We therefore set ILLUCI_GATE_MODE = "headless" at top-level module
 * scope FIRST, then load gate-controller via top-level `await import()`. This
 * does NOT change gate-controller behavior; it only guarantees the test runs in
 * the headless transport so the out-of-scope path ends at a fail-closed deny.
 *
 * Covers:
 *   - FLAG-OFF byte-identical: ILLUCI_CLASSIFIER_ENABLED off + an out-of-scope
 *     "gate" verdict → requestApproval reaches the existing headless transport
 *     exactly as before; the classifier ring buffer stays empty (proving the
 *     classifier block never ran), and no `classifier` field is attached.
 *   - DEGRADATION: flag ON + buildFeatureContext throws (no active context) →
 *     requestApproval returns { approved:false } with a fail-closed reason.
 *   - SCOPE: the classifier acts ONLY on a "gate" verdict — a read-only tool is
 *     auto-approved by evaluate() BEFORE the classifier block, ring stays empty.
 *
 * Run: node --test illuci/core/gates/classifier/gate-controller-integration.test.js
 */

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── set transport BEFORE gate-controller is imported (see header note) ──
const ORIG_FLAG = process.env.ILLUCI_CLASSIFIER_ENABLED;
const ORIG_MODE = process.env.ILLUCI_GATE_MODE;
process.env.ILLUCI_GATE_MODE = "headless";
delete process.env.ILLUCI_CLASSIFIER_ENABLED; // default OFF for the first assertion

const { requestApproval } = await import("../gate-controller.js");
const { GATE_LEVELS } = await import("../gate-types.js");
const { setApprovalContext, clearApprovalContext } = await import("../approval-context.js");
const { recentClassifierDecisions } = await import("./audit.js");

after(() => {
  if (ORIG_FLAG === undefined) delete process.env.ILLUCI_CLASSIFIER_ENABLED;
  else process.env.ILLUCI_CLASSIFIER_ENABLED = ORIG_FLAG;
  if (ORIG_MODE === undefined) delete process.env.ILLUCI_GATE_MODE;
  else process.env.ILLUCI_GATE_MODE = ORIG_MODE;
  clearApprovalContext();
});

beforeEach(() => {
  recentClassifierDecisions.length = 0;
  clearApprovalContext();
});

// An out-of-scope "gate" verdict: file_write IS allowed by the context's action
// set, but the target path is outside the approved scope → evaluate() = gate.
function setOutOfScopeContext() {
  setApprovalContext({
    permissionLevel: "implement",
    allowedActions: ["file_write", "file_read"],
    allowedPaths: ["core/in-scope"],
    allowedPatterns: [],
    deniedPaths: [],
  });
}

const OUT_OF_SCOPE_PARAMS = {
  tool: "file_write",
  args: { path: "core/out-of-scope/elsewhere.js", content: "x" },
  level: GATE_LEVELS.FULL,
  source: { model: "m", seat: "seat-x" },
};

test("FLAG-OFF byte-identical: gate verdict reaches existing transport; classifier never runs", async () => {
  delete process.env.ILLUCI_CLASSIFIER_ENABLED; // OFF (default)
  setOutOfScopeContext();

  const result = await requestApproval({ ...OUT_OF_SCOPE_PARAMS });

  // Reached the existing out-of-scope transport (headless) and denied — the
  // exact same path as before the classifier existed.
  assert.equal(result.approved, false);
  assert.match(result.reason, /Headless mode/);
  // No classifier field is attached — the classifier block was skipped entirely.
  assert.equal(result.classifier, undefined);
  // The ring buffer is empty — classifyAction was never invoked.
  assert.equal(recentClassifierDecisions.length, 0);
});

test("DEGRADATION: flag ON + feature extraction throws → fail-closed deny", async () => {
  process.env.ILLUCI_CLASSIFIER_ENABLED = "true";
  // No active approval context → evaluate() returns gate, and
  // buildFeatureContext throws "no active approval context".
  clearApprovalContext();

  const result = await requestApproval({ ...OUT_OF_SCOPE_PARAMS });

  assert.equal(result.approved, false);
  assert.match(result.reason, /classifier failure/);

  process.env.ILLUCI_CLASSIFIER_ENABLED = ORIG_FLAG ?? undefined;
  if (ORIG_FLAG === undefined) delete process.env.ILLUCI_CLASSIFIER_ENABLED;
});

test("SCOPE: classifier acts only on a gate verdict — read-only auto-approves first", async () => {
  process.env.ILLUCI_CLASSIFIER_ENABLED = "true";
  setOutOfScopeContext();

  // file_read is read-only → evaluate() returns "approved" and requestApproval
  // returns at the explicit approved early-return, BEFORE the classifier block.
  const result = await requestApproval({
    tool: "file_read",
    args: { path: "core/anything.js" },
    level: GATE_LEVELS.FULL,
    source: { model: "m", seat: "seat-y" },
  });

  assert.equal(result.approved, true);
  assert.equal(recentClassifierDecisions.length, 0);

  if (ORIG_FLAG === undefined) delete process.env.ILLUCI_CLASSIFIER_ENABLED;
  else process.env.ILLUCI_CLASSIFIER_ENABLED = ORIG_FLAG;
});
