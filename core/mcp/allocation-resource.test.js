import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "./server.js";
import {
  readAllocationPlan,
  readContainerPolicy,
  readDispositionCatalog,
  readOrchestratorRegistry,
  readTopologyRoster,
  readRunHistory,
  summarizeRunHistory,
  readWarehouseList,
  readWarehouseNode,
  ALLOCATION_RESOURCES,
} from "./allocation-resource.js";

function parseResource(read) {
  return JSON.parse(read.contents[0].text);
}

test("warehouse resources expose canonical belt nodes as read-only allocation targets", () => {
  const list = readWarehouseList();
  assert.equal(list.schema, "illuci.warehouse.nodes/1");
  assert.equal(list.policy.mutation, false);
  assert.equal(list.counts.nodes, 8);
  assert.equal(list.nodes[0].nodeId, "S0-intake");
  assert.equal(list.nodes[0].ledgerId, "W0");
  assert.equal(list.nodes[0].containerCompatibility.defaultPolicyId, "host-process");

  const node = readWarehouseNode({ nodeId: "S7-promotion-airlock" });
  assert.equal(node.node.nodeId, "S7-promotion-airlock");
  assert.equal(node.node.entryTier, 3);

  assert.throws(() => readWarehouseNode({ nodeId: "S99-missing" }), /unknown nodeId/);
});

test("orchestrator registry preserves direct and atomic orchestration without mandatory topology/company wrapping", () => {
  const registry = readOrchestratorRegistry();
  const individual = registry.shapes.find((shape) => shape.id === "individual");
  const atomic = registry.shapes.find((shape) => shape.id === "atomic-group");
  assert.equal(individual.directUsable, true);
  assert.equal(individual.requiresTopology, false);
  assert.equal(individual.requiresCompany, false);
  assert.equal(atomic.directUsable, true);
  assert.equal(atomic.requiresTopology, false);
  assert.equal(atomic.requiresCompany, false);

  const illuci = registry.registered.find((entry) => entry.id === "illuci");
  assert.equal(illuci.persona.identityBearing, true);
  assert.equal(illuci.persona.disposition, "separate-coordinate");
});

test("disposition catalog lists presets without collapsing persona into disposition", () => {
  const catalog = readDispositionCatalog();
  assert.equal(catalog.schema, "illuci.disposition.catalog/1");
  assert.equal(catalog.boundary.persona.includes("identity"), true);
  assert.equal(catalog.boundary.disposition.includes("behavioral"), true);
  assert.ok(catalog.presets.some((preset) => preset.id === "O5C6E6A3N0"));
  assert.ok(catalog.presets.every((preset) => preset.profileResource === "compose_disposition_v1"));
  // A72.x identity surfaced: opaque fingerprint per preset + salience derived at
  // read time (computeSalience's first host consumer).
  const executive = catalog.presets.find((preset) => preset.id === "O5C6E6A3N0");
  assert.match(executive.fingerprint, /^sha256v1:[0-9a-f]{16}$/);
  assert.ok(Array.isArray(executive.salience) && executive.salience.length > 0);
  assert.ok(executive.salience.every((s) => /[↑↓]/.test(s)));
  assert.ok(catalog.presets.every((preset) => String(preset.fingerprint).startsWith("sha256v1:")));
  // A75/DR-168: tension pairs surfaced (three-lens signal), each tagged by kind.
  assert.ok(Array.isArray(executive.tensions) && executive.tensions.length > 0);
  assert.ok(executive.tensions.every((t) => ["curated", "domain", "structural"].includes(t.kind) && t.facets.length === 2));
  assert.ok(catalog.presets.every((preset) => Array.isArray(preset.tensions)));
});

test("allocation preview records pin/delegate authority per coordinate and never dispatches", () => {
  const plan = readAllocationPlan({
    intent: "Build a engine allocation pane",
    orchestrators: ["illuci"],
    pinned: { warehouseNodes: "S0-intake", personas: "Illuci" },
    delegable: { topologies: "dev-team", dispositions: "critic" },
  });
  assert.equal(plan.status, "preview-only");
  assert.equal(plan.execution.readyForDispatch, false);
  assert.ok(plan.authority.some((record) => record.coordinate === "warehouseNodes" && record.state === "pinned"));
  assert.ok(plan.authority.some((record) => record.coordinate === "topologies" && record.state === "delegable"));
  assert.ok(plan.availableChoices.warehouseNodes.includes("S0-intake"));
  assert.ok(plan.availableChoices.orchestratorShapes.includes("atomic-group"));
});

test("container policy is honest about current host-process default", () => {
  const policy = readContainerPolicy();
  assert.equal(policy.currentDefault, "host-process");
  assert.equal(policy.policies.find((entry) => entry.id === "host-process").status, "active");
  assert.equal(policy.policies.find((entry) => entry.id === "per-node-container").status, "read-contract-only");
});

test("MCP server registers allocation resources and runtime capability lists them", async () => {
  const { handlers } = await startServer({ tenantId: "allocation-test" });
  const listed = await handlers["resources/list"]({});
  const names = listed.resources.map((resource) => resource.name);
  for (const name of [
    "warehouse_list_v1",
    "warehouse_node_v1",
    "orchestrator_registry_v1",
    "allocation_plan_v1",
    "activation_policy_v1",
    "container_policy_v1",
    "disposition_catalog_v1",
  ]) {
    assert.ok(names.includes(name), `${name} registered`);
  }

  const read = await handlers["resources/read"]({
    params: { name: "allocation_plan_v1", arguments: { pinned: { orchestrators: "illuci" } } },
  });
  const payload = parseResource(read);
  assert.equal(payload.schema, "illuci.allocation.plan-preview/1");
  assert.equal(payload.authority[0].coordinate, "orchestrators");

  const capability = await handlers["resources/read"]({ params: { name: "runtime_capability_v1" } });
  const cap = parseResource(capability);
  assert.ok(cap.mcp.resources.includes("allocation_plan_v1"));
  assert.ok(cap.mcp.resources.includes("warehouse_list_v1"));
});

test("topology_roster_v1 exposes each topology's assignable seats read-only ([A119])", () => {
  const all = readTopologyRoster();
  assert.equal(all.schema, "illuci.topology.roster/1");
  assert.equal(all.policy.mutation, false);
  assert.ok(all.topologies.length > 5, "expected the full topology registry");

  const debate = all.topologies.find((t) => t.id === "adversarial-debate");
  assert.ok(debate, "adversarial-debate roster present");
  assert.deepEqual(debate.seats.map((s) => s.id), ["red", "blue", "arbiter"]);
  const arbiter = debate.seats.find((s) => s.id === "arbiter");
  assert.equal(arbiter.min, 1);
  assert.equal(arbiter.max, 1);
  assert.equal(arbiter.roleHint, "arbiter");

  const direct = all.topologies.find((t) => t.id === "direct");
  assert.equal(direct.seats.length, 1);
  assert.equal(direct.seats[0].id, "model");
  assert.equal(direct.seats[0].max, 7);
});

test("topology_roster_v1 filters to one roster and never throws on an unknown id", () => {
  const one = readTopologyRoster({ topology: "dev-team" });
  assert.equal(one.topologies.length, 1);
  assert.equal(one.topologies[0].id, "dev-team");
  assert.ok(one.topologies[0].seats.length >= 1);

  const none = readTopologyRoster({ topology: "does-not-exist" });
  assert.deepEqual(none.topologies, []);
});

test("topology_roster_v1 is a registered read-tier resource", () => {
  const resource = ALLOCATION_RESOURCES.find((r) => r.name === "topology_roster_v1");
  assert.ok(resource, "topology_roster_v1 must be in ALLOCATION_RESOURCES (auto-registered by the server)");
  const parsed = JSON.parse(resource.read({ topology: "direct" }).contents[0].text);
  assert.equal(parsed.topologies[0].id, "direct");
});

test("summarizeRunHistory folds telemetry start/complete events into per-run summaries ([A120])", () => {
  const summaries = summarizeRunHistory(
    [
      { run_id: "r1", session_id: "r1", timestamp: "2026-07-12T10:00:00", topology_id: "direct", payload: { topologyName: "Direct", totalLatency: 1200, halted: false, phaseCount: 1 } },
      { run_id: "r2", session_id: "r2", timestamp: "2026-07-12T11:00:00", topology_id: "adversarial-debate", payload: { topologyName: "Adversarial Debate", halted: true, haltReason: "budget-exhausted" } },
    ],
    [
      { run_id: "r1", session_id: "r1", timestamp: "2026-07-12T09:59:00", payload: { topologyName: "Direct" } },
      { run_id: "r3", session_id: "r3", timestamp: "2026-07-12T12:00:00", payload: { topologyName: "Research Swarm" } }, // started, never completed
    ],
  );
  // most-recent-first by timestamp: r3 (running) > r2 (halted) > r1 (complete)
  assert.deepEqual(summaries.map((r) => r.runId), ["r3", "r2", "r1"]);
  const r1 = summaries.find((r) => r.runId === "r1");
  assert.equal(r1.status, "complete");
  assert.equal(r1.latencyMs, 1200);
  assert.equal(r1.topology, "Direct");
  const r2 = summaries.find((r) => r.runId === "r2");
  assert.equal(r2.status, "halted");
  assert.equal(r2.haltReason, "budget-exhausted");
  const r3 = summaries.find((r) => r.runId === "r3");
  assert.equal(r3.status, "running"); // start with no complete
});

test("readRunHistory is registered, read-only, and shaped even with no telemetry", () => {
  const resource = ALLOCATION_RESOURCES.find((r) => r.name === "run_history_v1");
  assert.ok(resource, "run_history_v1 must be in ALLOCATION_RESOURCES");
  const payload = readRunHistory({ limit: 5 });
  assert.equal(payload.schema, "illuci.run.history/1");
  assert.equal(payload.policy.mutation, false);
  assert.ok(Array.isArray(payload.runs));
  assert.equal(typeof payload.telemetryAvailable, "boolean");
});
