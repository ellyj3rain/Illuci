// node:test — the gate controller's headless honesty (DR-191): the DEFAULT cli
// transport must never hang a process that has no TTY to answer with.
//
// This test process itself has no TTY on stdin (node --test), which is exactly
// the environment the repair targets: pre-A98 the first assertion would HANG
// on a readline prompt; post-A98 it resolves a loud fail-closed denial.
import { test } from "node:test";
import assert from "node:assert/strict";

// The default mode is "cli" (no ILLUCI_GATE_MODE in this process) — the hang case.
delete process.env.ILLUCI_GATE_MODE;

const { requestApproval } = await import("./gate-controller.js");
const { registerApprovalCallback, clearApprovalCallback } = await import("./callback-gate.js");
const { GATE_LEVELS } = await import("./gate-types.js");

test("cli transport + no TTY → loud fail-closed denial, never a prompt (the F-132 hang class)", async () => {
  assert.ok(!process.stdin.isTTY, "precondition: the test runner has no TTY");
  const result = await requestApproval({
    tool: "file_write",
    args: { path: "core/anything.js", content: "x" },
    level: GATE_LEVELS.FULL,
    source: { model: "test-seat", seat: "implementer" },
  });
  assert.equal(result.approved, false);
  assert.equal(result.code, "headless-no-tty");
  assert.match(result.reason, /denied fail-closed/);
});

test("the denial is remembered: an identical retry auto-denies without re-routing", async () => {
  const result = await requestApproval({
    tool: "file_write",
    args: { path: "core/anything.js", content: "x" },
    level: GATE_LEVELS.FULL,
    source: { model: "test-seat", seat: "implementer" },
  });
  assert.equal(result.approved, false);
});

test("a registered approval callback still takes priority over the no-TTY deny", async () => {
  registerApprovalCallback(async () => ({ approved: true, reason: "callback approved" }));
  try {
    const result = await requestApproval({
      tool: "file_write",
      args: { path: "core/other.js", content: "y" },
      level: GATE_LEVELS.FULL,
      source: { model: "test-seat", seat: "implementer" },
    });
    assert.equal(result.approved, true);
    assert.equal(result.reason, "callback approved");
  } finally {
    clearApprovalCallback();
  }
});

test("reads (level NONE) pass through untouched", async () => {
  const result = await requestApproval({ tool: "file_read", args: { path: "x" }, level: GATE_LEVELS.NONE });
  assert.equal(result.approved, true);
});
