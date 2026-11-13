/**
 * illuci/core/mcp/server-permission-seam.test.js — Phase 2 server seam (node:test, hermetic)
 *
 * Exercises the two enforcement layers as wired into the live handler map:
 *   - handleListTools FILTERS the catalog when armed + returns the FULL set when off.
 *   - handleCallTool THROWS CAPABILITY_DENIED for an unpermitted tool when armed,
 *     and dispatches normally when off.
 *   - BEHAVIOR-IDENTICAL-OFF: with ILLUCI_ROLE_GOVERNANCE_ENABLED off, tools/list is
 *     the full catalog and tools/call behaves exactly as before.
 *
 * The role-context rides in on the threaded MCP context (ctx.roleId/topologyId),
 * exactly as the stdio transport / in-process caller would supply it.
 *
 * GATE PIN (defensive): Phase-2 enforcement throws BEFORE the handler, so a denied
 * call never reaches the gate. The one OFF call that DOES reach a handler uses a
 * pure read-shaped resolver (compose_skill_v1 → loadSkill, no dispatch, no gate),
 * so it cannot block on a CLI prompt. We still pin a headless DEFAULT before
 * importing the server, per the self-pin discipline.
 *
 * Run: ILLUCI_GATE_MODE=headless node --test illuci/core/mcp/server-permission-seam.test.js < /dev/null
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.ILLUCI_GATE_MODE = process.env.ILLUCI_GATE_MODE || "headless";

const { startServer } = await import("./server.js");
const { DENIAL_CODES } = await import("../roles/denial-codes.js");

const ENABLED = "ILLUCI_ROLE_GOVERNANCE_ENABLED";
const STRICT = "ILLUCI_ROLE_GOVERNANCE_STRICT";

afterEach(() => {
  delete process.env[ENABLED];
  delete process.env[STRICT];
});

test("BEHAVIOR-IDENTICAL-OFF: tools/list returns the FULL catalog (no filtering)", async () => {
  delete process.env[ENABLED];
  const { handlers } = await startServer({ tenantId: "seam-off" });

  // A seat is present on the context, but the flag is OFF → it must be ignored.
  const list = await handlers["tools/list"]({}, { roleId: "reviewer", topologyId: "no-such-topology" });
  const names = list.tools.map((t) => t.name);
  // The full catalog includes both unrestricted resolvers AND the shell_exec dispatch tools.
  assert.ok(names.includes("compose_role_v1"));
  assert.ok(names.includes("dispatch_v1"), "OFF: dispatch_v1 must remain in the full catalog");
  assert.ok(names.includes("run_topology_v1"), "OFF: run_topology_v1 must remain in the full catalog");
});

test("BEHAVIOR-IDENTICAL-OFF: tools/call dispatches normally (no CAPABILITY_DENIED)", async () => {
  delete process.env[ENABLED];
  const { handlers } = await startServer({ tenantId: "seam-off-call" });

  // Even a seat with an empty-ceiling unknown topology: flag off → no enforcement.
  // Use a pure read-shaped resolver so the call cannot reach a gate/dispatch.
  const called = await handlers["tools/call"](
    { params: { name: "compose_skill_v1", arguments: { skillId: "__nonexistent__" } } },
    { roleId: "reviewer", topologyId: "no-such-topology" },
  );
  assert.equal(called.schema_version, "1.0.0");
  assert.ok(Array.isArray(called.content));
  const payload = JSON.parse(called.content[0].text);
  assert.equal(payload.skillId, "__nonexistent__");
});

test("ARMED: tools/list FILTERS out the shell_exec tools for a seat that lacks shell_exec", async () => {
  process.env[ENABLED] = "true";
  const { handlers } = await startServer({ tenantId: "seam-on" });

  // reviewer on an unknown topology → empty ceiling → effectivePermission [] → no shell_exec.
  const list = await handlers["tools/list"]({}, { roleId: "reviewer", topologyId: "no-such-topology" });
  const names = list.tools.map((t) => t.name);
  // Unrestricted resolvers survive; both shell_exec dispatch tools are dropped.
  assert.ok(names.includes("compose_role_v1"), "ARMED: unrestricted resolver survives");
  assert.ok(!names.includes("dispatch_v1"), "ARMED: dispatch_v1 filtered out");
  assert.ok(!names.includes("run_topology_v1"), "ARMED: run_topology_v1 filtered out");
});

test("ARMED: tools/list KEEPS the shell_exec tools for a seat that retains shell_exec", async () => {
  process.env[ENABLED] = "true";
  const { handlers } = await startServer({ tenantId: "seam-on-keep" });

  // reviewer on dev-team → 'implement' ceiling minus authoring; shell_exec remains.
  const list = await handlers["tools/list"]({}, { roleId: "reviewer", topologyId: "dev-team" });
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes("dispatch_v1"), "ARMED: dispatch_v1 kept for a shell-capable seat");
  assert.ok(names.includes("run_topology_v1"));
});

test("ARMED: tools/call THROWS CAPABILITY_DENIED for an unpermitted tool (before the handler)", async () => {
  process.env[ENABLED] = "true";
  const { handlers } = await startServer({ tenantId: "seam-on-deny" });

  // dispatch_v1 requires shell_exec; reviewer-on-unknown-topology lacks it → denied
  // BEFORE the handler (so no live dispatch is attempted).
  await assert.rejects(
    () =>
      handlers["tools/call"](
        { params: { name: "dispatch_v1", arguments: { model: "deepseek", prompt: "hi" } } },
        { roleId: "reviewer", topologyId: "no-such-topology" },
      ),
    (err) => err.code === DENIAL_CODES.CAPABILITY_DENIED && /CAPABILITY_DENIED/.test(err.message),
  );
});

test("ARMED + permissive no-seat (default): full catalog + calls pass (Phase-1 parity)", async () => {
  process.env[ENABLED] = "true";
  delete process.env[STRICT];
  const { handlers } = await startServer({ tenantId: "seam-on-noseat" });

  // No seat on the context, non-strict → permissive: the catalog is unfiltered.
  const list = await handlers["tools/list"]({}, {});
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes("dispatch_v1"), "permissive no-seat: full catalog");

  // And a call to a pure resolver passes (assert is a no-op under permissive null permission).
  const called = await handlers["tools/call"](
    { params: { name: "compose_skill_v1", arguments: { skillId: "__nonexistent__" } } },
    {},
  );
  assert.ok(Array.isArray(called.content));
});

test("ARMED + STRICT no-seat: a shell_exec tool/call is CAPABILITY_DENIED", async () => {
  process.env[ENABLED] = "true";
  process.env[STRICT] = "true";
  const { handlers } = await startServer({ tenantId: "seam-on-strict" });

  // No seat + strict → deny-by-default (empty permission). dispatch_v1 (shell_exec) denied.
  await assert.rejects(
    () =>
      handlers["tools/call"](
        { params: { name: "dispatch_v1", arguments: { model: "deepseek", prompt: "hi" } } },
        {},
      ),
    (err) => err.code === DENIAL_CODES.CAPABILITY_DENIED,
  );

  // An unrestricted resolver still passes even under strict no-seat (no requiredActions).
  const called = await handlers["tools/call"](
    { params: { name: "compose_skill_v1", arguments: { skillId: "__nonexistent__" } } },
    {},
  );
  assert.ok(Array.isArray(called.content));
});
