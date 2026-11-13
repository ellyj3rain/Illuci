/**
 * illuci — Role Governance · BEHAVIOR-IDENTICAL-OFF proof (node:test, hermetic)
 *
 * The Phase-1 wiring is DARK: with ILLUCI_ROLE_GOVERNANCE_ENABLED off, the two
 * runtime guards (executeTool capability step + deriveFromTask role-tightening)
 * MUST short-circuit, so runtime behavior is identical to pre-Phase-1:
 *   - executeTool never returns a CAPABILITY_DENIED and never capability-blocks.
 *   - deriveFromTask never tightens allowedActions for a role.
 * Flipping the flag ON arms both: a reviewer (no authoring capability) is
 * capability-denied a file_write BEFORE the gate, and its derived allowedActions
 * lose the authoring tools.
 *
 * Each assertion sets/unsets the env var itself (config reads at CALL time), so
 * the suite is hermetic and order-independent.
 *
 * Run: node --test illuci/core/roles/behavior-identical-off.test.js
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DENIAL_CODES } from "./denial-codes.js";

// gate-controller.js captures `const MODE = process.env.ILLUCI_GATE_MODE || "cli"` at
// IMPORT time, and ESM import statements hoist ABOVE top-level code — so setting the
// mode inside a test runs too late, and the OFF cases that reach the gate would hang
// on the CLI operator prompt. Pin headless BEFORE the gate-pulling modules load (a
// default only; a process-level ILLUCI_GATE_MODE still wins), then import them
// dynamically so they read the pinned value.
process.env.ILLUCI_GATE_MODE = process.env.ILLUCI_GATE_MODE || "headless";
const { executeTool } = await import("../bridges/tools.js");
const { deriveFromTask, clearApprovalContext } = await import("../gates/approval-context.js");

const FLAG = "ILLUCI_ROLE_GOVERNANCE_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
  clearApprovalContext();
});

// ── executeTool capability layer ──────────────────────────────────────────

test("OFF: executeTool with a reviewer roleId does NOT capability-block file_write", async () => {
  delete process.env[FLAG];
  // headless mode so an ungated/out-of-scope authoring tool resolves to a gate
  // denial rather than hanging on an operator prompt — we only assert it is NOT
  // the capability layer that acted.
  const prevMode = process.env.ILLUCI_GATE_MODE;
  process.env.ILLUCI_GATE_MODE = "headless";
  try {
    const res = await executeTool(
      "file_write",
      { path: join(tmpdir(), "illuci-role-off.txt"), content: "x" },
      { roleId: "reviewer", topologyId: "dev-team" },
    );
    // Whatever the gate does, the role capability layer must NOT have tagged it.
    assert.notEqual(res.code, DENIAL_CODES.CAPABILITY_DENIED, "flag off must not capability-deny");
    if (res.blocked) {
      assert.ok(!/lacks the capability/.test(res.reason || ""), "flag off: no capability reason");
    }
  } finally {
    if (prevMode === undefined) delete process.env.ILLUCI_GATE_MODE; else process.env.ILLUCI_GATE_MODE = prevMode;
  }
});

test("ON: executeTool capability-denies a reviewer's file_write BEFORE the gate", async () => {
  process.env[FLAG] = "true";
  const res = await executeTool(
    "file_write",
    { path: join(tmpdir(), "illuci-role-on.txt"), content: "x" },
    { roleId: "reviewer", topologyId: "dev-team" },
  );
  assert.equal(res.success, false);
  assert.equal(res.blocked, true);
  assert.equal(res.code, DENIAL_CODES.CAPABILITY_DENIED);
  assert.match(res.reason, /lacks the capability/);
});

test("ON: executeTool does NOT capability-block an implementer's file_write (it keeps the capability)", async () => {
  process.env[FLAG] = "true";
  const prevMode = process.env.ILLUCI_GATE_MODE;
  process.env.ILLUCI_GATE_MODE = "headless";
  try {
    const res = await executeTool(
      "file_write",
      { path: join(tmpdir(), "illuci-role-impl.txt"), content: "x" },
      { roleId: "implementer", topologyId: "dev-team" },
    );
    // implementer HAS file_write capability → the capability layer must pass it
    // through (it may still be gated/denied downstream, but never with CAPABILITY_DENIED).
    assert.notEqual(res.code, DENIAL_CODES.CAPABILITY_DENIED);
  } finally {
    if (prevMode === undefined) delete process.env.ILLUCI_GATE_MODE; else process.env.ILLUCI_GATE_MODE = prevMode;
  }
});

test("ON: a read tool is never capability-blocked regardless of role", async () => {
  process.env[FLAG] = "true";
  const res = await executeTool("file_read", { path: "VERSION" }, { roleId: "reviewer", topologyId: "dev-team" });
  assert.notEqual(res.code, DENIAL_CODES.CAPABILITY_DENIED, "reads are not capability-governed");
});

// ── deriveFromTask role-tightening ─────────────────────────────────────────

test("OFF: deriveFromTask does NOT tighten allowedActions for a role", () => {
  delete process.env[FLAG];
  const baseline = deriveFromTask("implement the dev-team feature", { topology: "dev-team" });
  const baselineActions = [...baseline.allowedActions];
  clearApprovalContext();

  // Same task, now WITH a reviewer role — flag off, so it must be identical.
  const withRole = deriveFromTask("implement the dev-team feature", { topology: "dev-team", roleId: "reviewer" });
  assert.deepEqual(withRole.allowedActions, baselineActions, "flag off: role must not tighten");
  assert.ok(withRole.allowedActions.includes("file_write"), "flag off: writes remain");
});

test("ON: deriveFromTask tightens allowedActions for a reviewer (subtractive)", () => {
  delete process.env[FLAG];
  const baseline = deriveFromTask("implement the dev-team feature", { topology: "dev-team" });
  assert.ok(baseline.allowedActions.includes("file_write"), "precondition: ceiling has file_write");
  clearApprovalContext();

  process.env[FLAG] = "true";
  const tightened = deriveFromTask("implement the dev-team feature", { topology: "dev-team", roleId: "reviewer" });
  assert.ok(!tightened.allowedActions.includes("file_write"), "ON: reviewer loses file_write");
  assert.ok(!tightened.allowedActions.includes("file_edit"));
  assert.ok(!tightened.allowedActions.includes("git_commit"));
  // strict subset of the un-tightened baseline — never widened
  for (const a of tightened.allowedActions) {
    assert.ok(baseline.allowedActions.includes(a), `ON: '${a}' was added, not subtracted`);
  }
});

test("ON: deriveFromTask leaves an implementer's actions intact (no tighten)", () => {
  process.env[FLAG] = "true";
  const ctx = deriveFromTask("implement the dev-team feature", { topology: "dev-team", roleId: "implementer" });
  assert.ok(ctx.allowedActions.includes("file_write"));
  assert.ok(ctx.allowedActions.includes("git_commit"));
});
