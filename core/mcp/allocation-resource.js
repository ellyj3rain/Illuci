// core/mcp/allocation-resource.js
//
// Host-facing read-tier allocation resources. These resources expose what the
// engine can currently describe without creating schedules, grants, runs, or
// delegation authority.

import { listDispositions } from "../agents/disposition-registry.js";
import { listPresetMetadata, getPreset } from "../agents/disposition-presets.js";
import { bandProfile, computeSalience, computeTensionPairs } from "../agents/disposition-identity.js";
import { buildWarehouseBelt, WAREHOUSE_BELT_SCHEMA } from "../governance/belt/warehouse-belt.js";
import { listTopologies, getTopology, getSeats } from "../topologies/index.js";
import * as telemetryStore from "../telemetry/store.js";
import { listRoleIds } from "../roles/role-registry.js";
import { listSkillFrameworkIds } from "../roles/skill-frameworks/catalog.js";

export const ALLOCATION_READ_TIER_SCHEMA = "illuci.allocation.read-tier/1";

const MIME = "application/json";
const POLICY_READ_ONLY = Object.freeze({
  mutation: false,
  scheduling: false,
  grants: false,
  dispatch: false,
  note: "read-tier surface only; write authority remains outside this resource set",
});

function wrap(uri, payload) {
  return {
    contents: [
      { uri, mimeType: MIME, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function jsonResource({ name, uri, description, args = [], read }) {
  return {
    name,
    schema_version: "1.0.0",
    uri,
    mimeType: MIME,
    description,
    arguments: args,
    read(input = {}, context = {}) {
      return wrap(uri, read(input, context));
    },
  };
}

function stationClass(station) {
  return String(station?.id || "").replace(/^S\d+-/, "") || "unknown";
}

function normalizeStation(station) {
  return {
    nodeId: station.id,
    stationId: station.id,
    index: station.index,
    stationClass: stationClass(station),
    name: station.name,
    ledgerId: station.ledgerId,
    tenantId: station.tenantId,
    defaultTopologyId: station.topologyId,
    entryTier: station.entryTier,
    acceptedPackets: station.index === 0 ? ["draft-work-packet", "operator-intent"] : ["warehouse-work-packet"],
    containerCompatibility: {
      scope: "policy-reference",
      resource: "container_policy_v1",
      defaultPolicyId: "host-process",
      status: "not-container-asserted",
    },
    activationPolicy: {
      resource: "activation_policy_v1",
      defaultPolicyId: "manual",
      status: "read-only-visible",
    },
    delegableTopologies: [station.topologyId],
    delegableCompanies: [],
    orchestratorOccupancy: {
      allowedShapes: ["individual", "atomic-group", "topology-backed", "company-managed", "pipeline-managed"],
      resource: "orchestrator_registry_v1",
    },
    evidencePolicy: {
      required: ["run-trace", "decision-record", "verification-receipt"],
      note: "specific evidence is produced by later execution surfaces, not this read resource",
    },
  };
}

function beltSnapshot() {
  const belt = buildWarehouseBelt();
  return {
    belt,
    nodes: belt.stations.map(normalizeStation),
    transitions: belt.transitions.map((transition) => ({ ...transition })),
  };
}

export function readWarehouseList() {
  const { nodes, transitions } = beltSnapshot();
  return {
    schema: "illuci.warehouse.nodes/1",
    source: { kind: "warehouse-belt", schema: WAREHOUSE_BELT_SCHEMA },
    policy: POLICY_READ_ONLY,
    counts: { nodes: nodes.length, transitions: transitions.length },
    nodes,
    transitions,
  };
}

export function readWarehouseNode({ nodeId = null, stationId = null } = {}) {
  const wanted = nodeId || stationId || "S0-intake";
  const found = readWarehouseList().nodes.find((node) => node.nodeId === wanted || node.stationId === wanted);
  if (!found) {
    throw new Error(`warehouse_node_v1: unknown nodeId "${wanted}"`);
  }
  return {
    schema: "illuci.warehouse.node/1",
    source: { kind: "warehouse-belt", schema: WAREHOUSE_BELT_SCHEMA },
    policy: POLICY_READ_ONLY,
    node: found,
  };
}

export function readActivationPolicy() {
  return {
    schema: "illuci.activation-policy.catalog/1",
    policy: POLICY_READ_ONLY,
    currentDefault: "manual",
    policies: [
      {
        id: "manual",
        status: "active",
        authority: "operator",
        meaning: "a packet activates only through an explicit operator or host invocation",
      },
    ],
    existingRuntimeSignals: {
      checkpointChannel: "/runtime/checkpoints",
      eventStream: "/runtime/events",
      note: "these observe and pace active work; they are not a cron scheduler",
    },
  };
}

export function readContainerPolicy() {
  return {
    schema: "illuci.container-policy.catalog/1",
    policy: POLICY_READ_ONLY,
    currentDefault: "host-process",
    policies: [
      {
        id: "host-process",
        status: "active",
        scope: "global",
        meaning: "current Node runtime execution; no container isolation is asserted by this policy",
      },
    ],
  };
}

export function readDispositionCatalog() {
  const kindsById = new Map(listDispositions().map((entry) => [entry.id, entry.kind]));
  const presets = listPresetMetadata().map((entry) => {
    const preset = getPreset(entry.id);
    return {
      id: entry.id,
      kind: kindsById.get(entry.id) || "dimensional-preset",
      publicLabel: entry.publicLabel,
      internalId: entry.internalId,
      presentationStatus: entry.presentationStatus,
      stableRuntimeId: entry.stableRuntimeId,
      researchProvenance: entry.researchProvenance,
      // A72.x identity: fingerprint (opaque dedup key) + salience (top-N extreme
      // facets via computeSalience, derived at read time — its first host consumer).
      fingerprint: preset ? preset.fingerprint : null,
      salience: preset ? computeSalience(bandProfile(preset.profile), { topN: 4 }) : [],
      // A75/DR-168: tension pairs (three lenses — curated | domain | structural),
      // derived at read time — the learning-ready internal-tension signal.
      tensions: preset ? computeTensionPairs(bandProfile(preset.profile)) : [],
      profileResource: "compose_disposition_v1",
    };
  });
  return {
    schema: "illuci.disposition.catalog/1",
    policy: POLICY_READ_ONLY,
    boundary: {
      persona: "identity-bearing occupant or agent continuity",
      disposition: "behavioral vector or preset applied to a run coordinate",
      note: "persona and disposition are adjacent coordinates, not synonyms",
    },
    count: presets.length,
    presets,
  };
}

export function readOrchestratorRegistry() {
  return {
    schema: "illuci.orchestrator.registry/1",
    policy: POLICY_READ_ONLY,
    registered: [
      {
        id: "illuci",
        displayName: "Illuci",
        kind: "individual",
        layer: "meta-orchestrator",
        status: "built-in-primary",
        directUsable: true,
        requiresTopology: false,
        requiresCompany: false,
        persona: { identityBearing: true, disposition: "separate-coordinate" },
      },
      {
        id: "foreign-orchestrator-slot",
        displayName: "Foreign Orchestrator Slot",
        kind: "slot",
        layer: "opaque-nested-orchestrator",
        status: "contract-only",
        directUsable: true,
        requiresTopology: false,
        requiresCompany: false,
        provenanceRequired: true,
        innerSeatVisibility: "opaque",
      },
    ],
    operatorNamedExamples: [
      { displayName: "Dr. Cat Scanner", registered: false, recommendedSlot: "foreign-orchestrator-slot" },
      { displayName: "Hermes", registered: false, recommendedSlot: "foreign-orchestrator-slot" },
      { displayName: "Pi", registered: false, recommendedSlot: "foreign-orchestrator-slot" },
    ],
    shapes: [
      { id: "individual", directUsable: true, requiresTopology: false, requiresCompany: false },
      { id: "atomic-group", directUsable: true, requiresTopology: false, requiresCompany: false },
      { id: "topology-backed", directUsable: true, requiresTopology: true, requiresCompany: false },
      { id: "company-managed", directUsable: true, requiresTopology: false, requiresCompany: true },
      { id: "pipeline-managed", directUsable: true, requiresTopology: false, requiresCompany: false },
    ],
  };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function authorityFor(coordinate, value, state, resolver = null) {
  return {
    coordinate,
    value,
    state,
    pinnedBy: state === "pinned" ? "operator-or-caller" : null,
    resolver: state === "delegable" ? resolver || "selected-orchestrator" : null,
    allowedResolvers: state === "delegable" ? ["illuci", "foreign-orchestrator-slot"] : [],
    bounds: { allowedValues: [], deniedValues: [], requiresRatification: false },
  };
}

function buildAuthorityRecords({ pinned = {}, delegable = {} } = {}) {
  const records = [];
  for (const [coordinate, values] of Object.entries(pinned || {})) {
    for (const value of asArray(values)) records.push(authorityFor(coordinate, value, "pinned"));
  }
  for (const [coordinate, values] of Object.entries(delegable || {})) {
    for (const value of asArray(values)) records.push(authorityFor(coordinate, value, "delegable"));
  }
  return records;
}

export function readAllocationPlan(args = {}) {
  const intent = typeof args.intent === "string" ? args.intent : "";
  const pinned = args.pinned && typeof args.pinned === "object" && !Array.isArray(args.pinned) ? args.pinned : {};
  const delegable = args.delegable && typeof args.delegable === "object" && !Array.isArray(args.delegable) ? args.delegable : {};
  const authority = buildAuthorityRecords({ pinned, delegable });
  const warehouse = readWarehouseList();
  return {
    schema: "illuci.allocation.plan-preview/1",
    policy: POLICY_READ_ONLY,
    status: "preview-only",
    workPacket: {
      source: args.source || "preview",
      intent,
      interpretation: {
        summary: intent ? "caller-supplied intent; no natural-language decomposition is performed by this read resource" : null,
        decomposition: [],
        openQuestions: [],
      },
    },
    coordinates: {
      orchestrators: asArray(args.orchestrators),
      orchestratorGroups: asArray(args.orchestratorGroups),
      warehouseNodes: asArray(args.warehouseNodes),
      topologies: asArray(args.topologies),
      companies: asArray(args.companies),
      pipelines: asArray(args.pipelines),
      roles: asArray(args.roles),
      seats: asArray(args.seats),
      modelRoutes: asArray(args.modelRoutes),
      personas: asArray(args.personas),
      dispositions: asArray(args.dispositions),
      containerPolicies: asArray(args.containerPolicies),
      activationPolicies: asArray(args.activationPolicies),
    },
    authority,
    availableChoices: {
      warehouseNodes: warehouse.nodes.map((node) => node.nodeId),
      orchestratorShapes: readOrchestratorRegistry().shapes.map((shape) => shape.id),
      topologies: listTopologies(),
      roles: listRoleIds(),
      skillFrameworks: listSkillFrameworkIds(),
      dispositions: readDispositionCatalog().presets.map((preset) => preset.id),
      activationPolicies: readActivationPolicy().policies.map((policy) => policy.id),
      containerPolicies: readContainerPolicy().policies.map((policy) => policy.id),
    },
    execution: {
      readyForDispatch: false,
      reason: "allocation_plan_v1 is read-tier preview only; dispatch/scheduling uses separate governed surfaces",
    },
  };
}

export const WAREHOUSE_LIST_RESOURCE = jsonResource({
  name: "warehouse_list_v1",
  uri: "illuci://allocation/warehouse/nodes",
  description: "Read-only warehouse node catalog for allocation planning.",
  read: readWarehouseList,
});

export const WAREHOUSE_NODE_RESOURCE = jsonResource({
  name: "warehouse_node_v1",
  uri: "illuci://allocation/warehouse/node",
  description: "Read one warehouse node by nodeId/stationId. Defaults to S0-intake.",
  args: [
    { name: "nodeId", description: "Warehouse node id such as S0-intake.", required: false },
    { name: "stationId", description: "Alias for nodeId.", required: false },
  ],
  read: readWarehouseNode,
});

export const ORCHESTRATOR_REGISTRY_RESOURCE = jsonResource({
  name: "orchestrator_registry_v1",
  uri: "illuci://allocation/orchestrators",
  description: "Read-only orchestrator shape and slot registry for allocation planning.",
  read: readOrchestratorRegistry,
});

export const ALLOCATION_PLAN_RESOURCE = jsonResource({
  name: "allocation_plan_v1",
  uri: "illuci://allocation/plan-preview",
  description: "Read-only allocation preview: coordinate-local pin/delegate records without scheduling or dispatch.",
  args: [
    { name: "intent", description: "Operator intent text to carry into the preview.", required: false },
    { name: "pinned", description: "Coordinate -> value(s) pinned by the caller.", required: false },
    { name: "delegable", description: "Coordinate -> value(s) delegated to an allowed resolver.", required: false },
  ],
  read: readAllocationPlan,
});

export const ACTIVATION_POLICY_RESOURCE = jsonResource({
  name: "activation_policy_v1",
  uri: "illuci://allocation/policies/activation",
  description: "Read-only activation-policy catalog for manual, event, cron, and orchestrator-tick shapes.",
  read: readActivationPolicy,
});

export const CONTAINER_POLICY_RESOURCE = jsonResource({
  name: "container_policy_v1",
  uri: "illuci://allocation/policies/container",
  description: "Read-only container compatibility policy catalog. Current default is host-process, not container-isolated.",
  read: readContainerPolicy,
});

export const DISPOSITION_CATALOG_RESOURCE = jsonResource({
  name: "disposition_catalog_v1",
  uri: "illuci://allocation/dispositions",
  description: "Read-only disposition preset catalog; full profiles remain resolved by compose_disposition_v1.",
  read: readDispositionCatalog,
});

// Topology seat rosters ([A119]) — the read-tier surface a GUI needs to route a
// model to each seat of a topology before launching, WITHOUT hard-coding the
// ontology client-side (the host contract: always fetch structure from the live
// runtime). Derived from the topology registry's own seat definitions.
export function readTopologyRoster(input = {}) {
  const only = typeof input?.topology === "string" && input.topology.trim() ? input.topology.trim() : null;
  const ids = only ? [only] : listTopologies();
  const topologies = [];
  for (const id of ids) {
    let topology;
    try { topology = getTopology(id); } catch { continue; } // unknown id → omit (empty roster, never throw)
    if (!topology) continue;
    topologies.push({
      id: topology.id,
      name: topology.name || topology.id,
      description: topology.description || null,
      seats: getSeats(id).map((s) => ({
        id: s.id,
        label: s.label || s.id,
        min: typeof s.min === "number" ? s.min : 1,
        max: typeof s.max === "number" ? s.max : 1,
        roleHint: s.roleHint || null,
      })),
    });
  }
  return { schema: "illuci.topology.roster/1", policy: POLICY_READ_ONLY, topologies };
}

export const TOPOLOGY_ROSTER_RESOURCE = jsonResource({
  name: "topology_roster_v1",
  uri: "illuci://topology/roster",
  description: "Read-only topology seat rosters — each topology's assignable seats (id, label, min/max, roleHint) for per-seat model routing.",
  args: [{ name: "topology", description: "Optional topology id to return a single roster (unknown ids yield an empty list).", required: false }],
  read: (input) => readTopologyRoster(input),
});

// Run history ([A120]) — the read-tier surface for runs from BEFORE the session.
// The live event stream only carries the current window; completed runs persist in
// the telemetry store (a topology_complete event per run). This summarizes those
// into run rows a GUI can list, WITHOUT the datastore trunk (telemetry is separate).
const RUN_HISTORY_DEFAULT_LIMIT = 25;
const RUN_HISTORY_MAX_LIMIT = 200;

/** Pure: fold telemetry topology_start/complete events into per-run summaries. */
export function summarizeRunHistory(completeEvents = [], startEvents = []) {
  const byRun = new Map();
  const ensure = (ev) => {
    const runId = ev.run_id || ev.session_id;
    if (!runId) return null;
    if (!byRun.has(runId)) {
      byRun.set(runId, {
        runId,
        sessionId: ev.session_id || runId,
        topology: null,
        status: "running",
        latencyMs: null,
        haltReason: null,
        phaseCount: null,
        at: null,
      });
    }
    return byRun.get(runId);
  };
  for (const ev of startEvents) {
    const r = ensure(ev);
    if (!r) continue;
    const p = ev.payload || {};
    r.topology = p.topologyName || r.topology || ev.topology_id || null;
    if (ev.timestamp && (!r.at || ev.timestamp < r.at)) r.at = ev.timestamp;
  }
  for (const ev of completeEvents) {
    const r = ensure(ev);
    if (!r) continue;
    const p = ev.payload || {};
    r.topology = p.topologyName || r.topology || ev.topology_id || null;
    r.status = p.halted === true ? "halted" : "complete";
    r.haltReason = p.haltReason || null;
    if (typeof p.totalLatency === "number") r.latencyMs = p.totalLatency;
    if (typeof p.phaseCount === "number") r.phaseCount = p.phaseCount;
    r.at = ev.timestamp || r.at;
  }
  return [...byRun.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

export function readRunHistory(input = {}) {
  const requested = Number(input?.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, RUN_HISTORY_MAX_LIMIT) : RUN_HISTORY_DEFAULT_LIMIT;
  let completeEvents = [];
  let startEvents = [];
  let telemetryAvailable = true;
  try {
    completeEvents = telemetryStore.getEvents({ event_type: "topology_complete", limit, order: "DESC" }) || [];
    startEvents = telemetryStore.getEvents({ event_type: "topology_start", limit, order: "DESC" }) || [];
  } catch {
    telemetryAvailable = false;
  }
  return {
    schema: "illuci.run.history/1",
    policy: POLICY_READ_ONLY,
    telemetryAvailable,
    runs: summarizeRunHistory(completeEvents, startEvents).slice(0, limit),
  };
}

export const RUN_HISTORY_RESOURCE = jsonResource({
  name: "run_history_v1",
  uri: "illuci://runs/history",
  description: "Read-only run history: completed/started runs from the telemetry store (topology, status, latency, timestamp) — the runs from before the live session.",
  args: [{ name: "limit", description: "Max runs to return (default 25, cap 200).", required: false }],
  read: (input) => readRunHistory(input),
});

export const ALLOCATION_RESOURCES = Object.freeze([
  WAREHOUSE_LIST_RESOURCE,
  WAREHOUSE_NODE_RESOURCE,
  ORCHESTRATOR_REGISTRY_RESOURCE,
  ALLOCATION_PLAN_RESOURCE,
  ACTIVATION_POLICY_RESOURCE,
  CONTAINER_POLICY_RESOURCE,
  DISPOSITION_CATALOG_RESOURCE,
  TOPOLOGY_ROSTER_RESOURCE,
  RUN_HISTORY_RESOURCE,
]);

export default {
  ALLOCATION_READ_TIER_SCHEMA,
  ALLOCATION_RESOURCES,
  readWarehouseList,
  readWarehouseNode,
  readActivationPolicy,
  readContainerPolicy,
  readDispositionCatalog,
  readOrchestratorRegistry,
  readAllocationPlan,
};
