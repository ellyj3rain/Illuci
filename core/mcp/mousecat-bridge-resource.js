import { listSchemas } from "./schema-registry.js";
import { surfaceServerName, surfaceUri } from "../identity/surface.js";

const URI = surfaceUri("bridges/mousecat");
const CONTRACT_SCHEMA = "illuci.mcp.mousecat-bridge-contract/1";

const BRIDGE_METHODS = Object.freeze([
  "initialize",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

const WITHHELD_SURFACES = Object.freeze([
  "illuci-private-logic",
  "operator-memory",
  "local-credentials",
  "raw-source",
  "local-paths",
  "runtime-data-payloads",
  "run-traces",
  "private-agent-memory",
  "unregistered-skills",
]);

const BUTTON_TOOL_IDS = Object.freeze([
  "crucible_classify_v1",
  "crucible_elicit_v1",
  "compose_skill_framework_v1",
  "compose_skill_framework_use_v1",
  "illuci_intent_v1",
]);

function schemas(kind) {
  return listSchemas({ kind }).filter((entry) => !entry.deprecated);
}

function boundaryClass(entry) {
  const actions = Array.isArray(entry.definition?.requiredActions)
    ? entry.definition.requiredActions
    : [];
  if (entry.name === "crucible_elicit_v1") return "operator-elicitation";
  if (entry.name === "illuci_intent_v1") return "intent-router";
  if (actions.length > 0) return "gated-tool";
  return "read-shaped";
}

function publicTool(entry, { includeInputSchemas = true } = {}) {
  const actions = Array.isArray(entry.definition?.requiredActions)
    ? [...entry.definition.requiredActions]
    : [];
  return {
    name: entry.name,
    schema_version: entry.schema_version,
    boundary: boundaryClass(entry),
    requiredActions: actions,
    ...(includeInputSchemas ? { inputSchema: entry.definition?.inputSchema || { type: "object" } } : {}),
  };
}

function resourceRef(entry) {
  return {
    name: entry.name,
    schema_version: entry.schema_version,
    uri: entry.definition?.uri || null,
    mimeType: entry.definition?.mimeType || "application/json",
  };
}

function promptRef(entry) {
  return {
    name: entry.name,
    schema_version: entry.schema_version,
  };
}

function skillButtons(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return BUTTON_TOOL_IDS
    .filter((name) => byName.has(name))
    .map((name) => ({
      id: name.replace(/_v\d+$/, ""),
      tool: name,
      schema_version: byName.get(name).schema_version,
      boundary: byName.get(name).boundary,
    }));
}

export function summarizeMousecatAgents(trace = {}) {
  const assignments = trace?.agentAssignments || {};
  const out = {};
  for (const [seatId, agents] of Object.entries(assignments)) {
    const list = Array.isArray(agents) ? agents : [agents];
    out[seatId] = list.map((agent) => ({
      agentId: agent?.agentId || null,
      agentSlug: agent?.agentSlug || null,
      model: agent?.model || null,
      role: agent?.role || null,
      specialist: agent?.specialist || null,
      skillFrameworks: Array.isArray(agent?.skillFrameworks) ? [...agent.skillFrameworks] : [],
      skills: Array.isArray(agent?.skills) ? [...agent.skills] : [],
      public: { ...(agent?.public || {}) },
    }));
  }
  return out;
}

export function buildMousecatBridgeContract(options = {}) {
  const includeInputSchemas = options.includeInputSchemas !== false;
  const tools = schemas("tool").map((entry) => publicTool(entry, { includeInputSchemas }));
  const resources = schemas("resource").map(resourceRef);
  const prompts = schemas("prompt").map(promptRef);

  return {
    schema: CONTRACT_SCHEMA,
    schema_version: "1.0.0",
    consumer: "mousecat",
    role: "upstream-mcp-consumer",
    server: {
      name: surfaceServerName(),
      transport: "stdio",
      methods: BRIDGE_METHODS,
      staleCode: "MCP_RUNTIME_STALE",
    },
    contract: {
      invocation: "mcp-tools-call-only",
      catalog: "mcp-list-methods",
      update: "restart-upstream-on-stale-code",
      permissionBoundary: "illuci-mcp-permission-context",
      auditBoundary: "illuci-mcp-audit-wrapper",
    },
    publicSurface: {
      tools,
      resources,
      prompts,
      skillButtons: skillButtons(tools),
      agentAssignments: summarizeMousecatAgents(options.trace),
      skillRoutes: [
        { id: "crucible", status: "available", tools: ["crucible_classify_v1", "crucible_elicit_v1"] },
        { id: "mass-assault", status: "handoff-only", source: "crucible_batch_route" },
        { id: "total-recall", status: "external", owner: "mousecat-or-host" },
      ],
    },
    exportPolicy: {
      exported: [
        "schema-names",
        "schema-versions",
        "input-schemas",
        "boundary-classes",
        "required-actions",
        "stale-runtime-code",
        "public-agent-assignment-summaries",
      ],
      withheld: [...WITHHELD_SURFACES],
    },
  };
}

export const MOUSECAT_BRIDGE_RESOURCE = {
  name: "mousecat_bridge_contract_v1",
  schema_version: "1.0.0",
  uri: URI,
  mimeType: "application/json",
  description:
    "Read-only Mousecat bridge contract for consuming illuci through MCP without exporting private logic.",
  arguments: [
    {
      name: "includeInputSchemas",
      description: "Set false to return only tool names, versions, and boundary classes.",
      required: false,
    },
  ],
  read(args = {}) {
    return {
      contents: [
        {
          uri: URI,
          mimeType: "application/json",
          text: JSON.stringify(buildMousecatBridgeContract(args), null, 2),
        },
      ],
    };
  },
};

export default { MOUSECAT_BRIDGE_RESOURCE, buildMousecatBridgeContract };
