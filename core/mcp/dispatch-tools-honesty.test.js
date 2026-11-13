// core/mcp/dispatch-tools-honesty.test.js
//
// [A44] Boundary honesty (F-084): the engine computes honest failure and halt
// shapes below (queryModel's failed/error, the [A17.3] empty-success funnel,
// trace.halted from the runner) — the MCP trim layer must CARRY them, never
// flatten them into success-shaped emptiness. Found live: a deployed-service
// bridge failure surfaced as {response:"", usage:0, skipped:false}, and an
// operator checkpoint-abort returned indistinguishable from a clean zero-step
// completion. Pure unit coverage over the two trim helpers; the transport-level
// loud-failure and checkpoint-port cases live in core/runtime/verb-contract.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { DISPATCH_TOOLS, mcpStepFromPhaseResponse, traceHaltFields } from "./dispatch-tools.js";

// [A90]/DR-182 P1: the genome arm fails closed at the verb boundary — loud,
// BEFORE any topology lookup or dispatch (the resolver's projectDir law,
// enforced one seam earlier). Proven with an unknown topology: reaching the
// genome error means nothing downstream ever ran.
test("run_topology_v1: a malformed genome arm rejects fail-fast (no lookup, no dispatch)", async () => {
  const runTopologyTool = DISPATCH_TOOLS.find((t) => t.name === "run_topology_v1");
  await assert.rejects(
    () => runTopologyTool.handler({ topology: "no-such-topology", task: "x", genome: "not-an-object" }),
    /genome must be an object/,
  );
  await assert.rejects(
    () => runTopologyTool.handler({ topology: "no-such-topology", task: "x", genome: {} }),
    /genome\.projectDir \(string\) is required/,
  );
});

test("a failed seat response stays failed at the boundary — never a silent empty output", () => {
  const failed = mcpStepFromPhaseResponse("draft", {
    model: "claude-sonnet",
    response: null,
    failed: true,
    error: "bridge returned empty content with zero completion tokens (route/auth/preflight failure)",
  });
  assert.equal(failed.failed, true);
  assert.match(failed.error, /zero completion tokens/);
  assert.equal(failed.output, "");

  const ok = mcpStepFromPhaseResponse("draft", { model: "kimi-cloud", response: "fine" });
  assert.equal(ok.failed, undefined, "a successful step carries no failure keys");
  assert.equal(ok.error, undefined);
  assert.equal(ok.output, "fine");
});

test("a failed seat without an error string still carries a NAMED failure", () => {
  const r = mcpStepFromPhaseResponse("p", { model: "m", response: null, failed: true });
  assert.equal(r.failed, true);
  assert.ok(r.error, "failure is named even when the shape lost its error string");
});

test("a halted trace surfaces halted/haltedAt/haltReason; an unhalted one adds nothing", () => {
  assert.deepEqual(
    traceHaltFields({ halted: true, haltedAt: "draft", haltReason: "Operator aborted at fire-control checkpoint" }),
    { halted: true, haltedAt: "draft", haltReason: "Operator aborted at fire-control checkpoint" },
  );
  assert.deepEqual(traceHaltFields({ halted: false }), {});
  assert.deepEqual(traceHaltFields({}), {});
  assert.deepEqual(traceHaltFields(undefined), {});
  // A degenerate halt still surfaces AS a halt — nulls, not dropped keys.
  assert.deepEqual(traceHaltFields({ halted: true }), { halted: true, haltedAt: null, haltReason: null });
});

// [A91]/DR-184 + [A92]/DR-185: the childIdentity state validates at the verb
// boundary through the ONE policy module — an unknown state dies before any
// lookup; the four ratified states all pass validation (derive reaching the
// topology lookup proves it cleared the boundary).
test("run_topology_v1: an unknown childIdentity rejects fail-fast; all four states clear the boundary", async () => {
  const runTopologyTool = DISPATCH_TOOLS.find((t) => t.name === "run_topology_v1");
  await assert.rejects(
    () => runTopologyTool.handler({ topology: "no-such-topology", task: "x", genome: { projectDir: "/p", childIdentity: "sideways" } }),
    /not a state/,
  );
  for (const state of ["none", "inherit", "derive", "explicit"]) {
    await assert.rejects(
      () => runTopologyTool.handler({ topology: "no-such-topology", task: "x", genome: { projectDir: "/p", childIdentity: state } }),
      /unknown topology/,
      state + ' cleared boundary validation and reached the lookup',
    );
  }
});
