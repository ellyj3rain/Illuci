/**
 * illuci/core/mcp/permission-context.test.js — Phase 2 dynamic MCP-boundary exposure
 *
 * Hermetic node:test suite for the permission-context module: the role-context
 * resolver, the per-tool permission check, the tools/list filter, and the
 * tools/call assert. Each assertion sets/unsets the env flags itself (config reads
 * at CALL time), so the suite is order-independent.
 *
 * GATE PIN (defensive): these unit functions throw CAPABILITY_DENIED BEFORE any
 * handler and never reach the gate, but to honor the self-pin discipline we set a
 * headless ILLUCI_GATE_MODE DEFAULT before any gate-pulling module could load, then
 * import the module under test dynamically so any transitive gate import reads the
 * pinned value rather than blocking on a CLI prompt.
 *
 * Run: ILLUCI_GATE_MODE=headless node --test illuci/core/mcp/permission-context.test.js < /dev/null
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Pin headless as a DEFAULT before importing the module-under-test (and its
// transitive imports). A process-level ILLUCI_GATE_MODE still wins.
process.env.ILLUCI_GATE_MODE = process.env.ILLUCI_GATE_MODE || "headless";

const {
  setSessionSeat,
  invalidateSessionPermission,
  clearSessionSeatMap,
  resolveSeatIdentity,
  resolveRoleContext,
  getToolRequiredActions,
  isToolPermitted,
  filterToolsByRoleContext,
  assertMcpToolExposed,
} = await import("./permission-context.js");
const { DENIAL_CODES } = await import("../roles/denial-codes.js");
// startServer registers the real tool catalog (so getToolRequiredActions resolves
// the co-located dispatch_v1 requiredActions through getSchema).
const { startServer } = await import("./server.js");

const ENABLED = "ILLUCI_ROLE_GOVERNANCE_ENABLED";
const STRICT = "ILLUCI_ROLE_GOVERNANCE_STRICT";

// Ensure the registry is populated once for the getToolRequiredActions paths.
await startServer({ tenantId: "perm-ctx-test" });

afterEach(() => {
  delete process.env[ENABLED];
  delete process.env[STRICT];
  clearSessionSeatMap();
});

// ── resolveRoleContext ─────────────────────────────────────────────────────

test("resolveRoleContext: flag OFF → governanceEnabled:false, effectivePermission:null", () => {
  delete process.env[ENABLED];
  const ctx = resolveRoleContext({ roleId: "reviewer", topologyId: "dev-team" });
  assert.equal(ctx.governanceEnabled, false);
  assert.equal(ctx.effectivePermission, null);
});

test("resolveRoleContext: ON + seat → builds the role-join (string[] permission + caps)", () => {
  process.env[ENABLED] = "true";
  const ctx = resolveRoleContext({ roleId: "reviewer", topologyId: "dev-team" });
  assert.equal(ctx.governanceEnabled, true);
  assert.ok(ctx.seat && ctx.seat.roleId === "reviewer");
  assert.ok(Array.isArray(ctx.effectivePermission), "effectivePermission is a string[]");
  assert.ok(Array.isArray(ctx.caps));
  // reviewer keeps the read floor + shell_exec, loses authoring
  assert.ok(ctx.effectivePermission.includes("shell_exec"));
  assert.ok(!ctx.effectivePermission.includes("file_write"));
});

test("resolveRoleContext: ON + no seat + STRICT → deny-by-default ([])", () => {
  process.env[ENABLED] = "true";
  process.env[STRICT] = "true";
  const ctx = resolveRoleContext({});
  assert.equal(ctx.governanceEnabled, true);
  assert.deepEqual(ctx.effectivePermission, []);
});

test("resolveRoleContext: ON + no seat + non-strict → PERMISSIVE (null + _permissiveNoSeat)", () => {
  process.env[ENABLED] = "true";
  delete process.env[STRICT];
  const ctx = resolveRoleContext({});
  assert.equal(ctx.governanceEnabled, true);
  assert.equal(ctx.effectivePermission, null);
  assert.equal(ctx._permissiveNoSeat, true);
});

test("resolveSeatIdentity: resolves via the session→seat map; unknown role ignored", () => {
  setSessionSeat("sess-1", { roleId: "reviewer", topologyId: "dev-team" });
  const seat = resolveSeatIdentity({ sessionId: "sess-1" });
  assert.equal(seat.roleId, "reviewer");
  assert.equal(seat.topologyId, "dev-team");

  // unknown role is never written
  setSessionSeat("sess-2", { roleId: "__not_a_role__" });
  assert.equal(resolveSeatIdentity({ sessionId: "sess-2" }), null);

  // invalidate clears it
  invalidateSessionPermission("sess-1");
  assert.equal(resolveSeatIdentity({ sessionId: "sess-1" }), null);
});

// ── getToolRequiredActions ─────────────────────────────────────────────────

test("getToolRequiredActions: dispatch_v1 requires shell_exec; a pure resolver requires nothing", () => {
  assert.deepEqual(getToolRequiredActions("dispatch_v1"), ["shell_exec"]);
  assert.deepEqual(getToolRequiredActions("run_topology_v1"), ["shell_exec"]);
  // pure read/compose resolvers carry NO requiredActions → undefined (unrestricted)
  assert.equal(getToolRequiredActions("compose_role_v1"), undefined);
  assert.equal(getToolRequiredActions("estimate_cost_v1"), undefined);
});

// ── isToolPermitted ────────────────────────────────────────────────────────

test("isToolPermitted: governance off → every tool permitted", () => {
  const off = { governanceEnabled: false, effectivePermission: null };
  assert.equal(isToolPermitted("dispatch_v1", off), true);
  assert.equal(isToolPermitted("compose_role_v1", off), true);
});

test("isToolPermitted: an unrestricted tool (no requiredActions) is always permitted", () => {
  const denySeat = { governanceEnabled: true, effectivePermission: [] };
  // compose_role_v1 has no requiredActions → permitted even to an empty-permission seat
  assert.equal(isToolPermitted("compose_role_v1", denySeat), true);
});

test("isToolPermitted: a shell_exec tool is denied to a seat without it, permitted to one with it", () => {
  const withShell = { governanceEnabled: true, effectivePermission: ["file_read", "shell_exec"] };
  const withoutShell = { governanceEnabled: true, effectivePermission: ["file_read"] };
  assert.equal(isToolPermitted("dispatch_v1", withShell), true);
  assert.equal(isToolPermitted("dispatch_v1", withoutShell), false);
});

test("isToolPermitted: permissive no-seat (effectivePermission null) → permitted", () => {
  const permissive = { governanceEnabled: true, effectivePermission: null, _permissiveNoSeat: true };
  assert.equal(isToolPermitted("dispatch_v1", permissive), true);
});

// ── filterToolsByRoleContext ───────────────────────────────────────────────

test("filterToolsByRoleContext: off → unchanged; armed seat → drops the unentitled tool", () => {
  const tools = [{ name: "compose_role_v1" }, { name: "dispatch_v1" }, { name: "run_topology_v1" }];

  const off = { governanceEnabled: false, effectivePermission: null };
  assert.deepEqual(filterToolsByRoleContext(tools, off), tools);

  const withoutShell = { governanceEnabled: true, effectivePermission: ["file_read"] };
  const filtered = filterToolsByRoleContext(tools, withoutShell).map((t) => t.name);
  assert.deepEqual(filtered, ["compose_role_v1"]); // both shell_exec tools dropped

  const withShell = { governanceEnabled: true, effectivePermission: ["file_read", "shell_exec"] };
  const kept = filterToolsByRoleContext(tools, withShell).map((t) => t.name);
  assert.deepEqual(kept, ["compose_role_v1", "dispatch_v1", "run_topology_v1"]);
});

// ── assertMcpToolExposed ───────────────────────────────────────────────────

test("assertMcpToolExposed: permitted tool returns; unpermitted throws CAPABILITY_DENIED", () => {
  const withoutShell = { governanceEnabled: true, effectivePermission: ["file_read"] };

  // unrestricted tool → no throw
  assert.doesNotThrow(() => assertMcpToolExposed("compose_role_v1", withoutShell));

  // shell_exec tool to a seat without it → CAPABILITY_DENIED
  assert.throws(
    () => assertMcpToolExposed("dispatch_v1", withoutShell),
    (err) => err.code === DENIAL_CODES.CAPABILITY_DENIED && /CAPABILITY_DENIED/.test(err.message),
  );

  // off → never throws
  assert.doesNotThrow(() =>
    assertMcpToolExposed("dispatch_v1", { governanceEnabled: false, effectivePermission: null }),
  );
});

// ── real role-join paths (no hand-built roleCtx) ───────────────────────────

test("real seat: reviewer+dev-team KEEPS shell_exec (dispatch permitted); reviewer+unknown-topology LACKS it (denied)", () => {
  process.env[ENABLED] = "true";

  // reviewer on dev-team — ceiling 'implement' minus authoring; shell_exec remains
  const okCtx = resolveRoleContext({ roleId: "reviewer", topologyId: "dev-team" });
  assert.equal(isToolPermitted("dispatch_v1", okCtx), true);

  // reviewer on an unknown topology — empty ceiling → effectivePermission [] → no shell_exec
  const denyCtx = resolveRoleContext({ roleId: "reviewer", topologyId: "no-such-topology" });
  assert.deepEqual(denyCtx.effectivePermission, []);
  assert.equal(isToolPermitted("dispatch_v1", denyCtx), false);
  assert.throws(() => assertMcpToolExposed("dispatch_v1", denyCtx), (e) => e.code === DENIAL_CODES.CAPABILITY_DENIED);
});
