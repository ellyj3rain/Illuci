/**
 * illuci graph preset substrate.
 *
 * A graph preset is an authored reusable composition. It does not replace the
 * existing registries; it records how those layers compose so the runtime can
 * resolve, audit, author, and eventually visualize them through one spine.
 */

import { defineResolutionRecord } from "./resolution-record.js";

export const GRAPH_NODE_TYPES = Object.freeze([
  "orchestrator",
  "company",
  "pipeline",
  "topology",
  "seat",
  "model",
  "provider",
  "disposition",
  "role",
  "specialist-role",
  "skill-framework",
  "skill",
  "permission-boundary",
  "knowledge-ref",
  "instruction-overlay",
]);

export const GRAPH_EDGE_TYPES = Object.freeze([
  "contains",
  "delegates-to",
  "uses",
  "assigns",
  "constrains",
  "references",
  "inherits-from",
  "resolves-to",
]);

export const GRAPH_PRESET_STATUSES = Object.freeze([
  "draft",
  "resolvable",
  "runnable",
  "stable",
  "retired",
]);

const SAFE_ID_RE = /^[a-z][a-z0-9._-]{0,95}$/;
const EXECUTION_NODE_TYPES = new Set(["orchestrator", "company", "pipeline", "topology", "seat", "model"]);
const INLINE_NODE_TYPES = new Set(["orchestrator", "seat", "permission-boundary", "instruction-overlay"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSafeGraphId(value) {
  if (typeof value !== "string") return false;
  if (value.includes("..") || value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  return SAFE_ID_RE.test(value);
}

export function assertSafeGraphId(value, label = "id") {
  if (!isSafeGraphId(value)) {
    throw new Error(`graph preset ${label} must match ${SAFE_ID_RE} and contain no path traversal`);
  }
  return value;
}

function cleanObject(value) {
  return isObject(value) ? { ...value } : {};
}

function normalizePresentation(id, presentation = {}) {
  const input = cleanObject(presentation);
  return {
    label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : id,
    publicLabel: typeof input.publicLabel === "string" && input.publicLabel.trim() ? input.publicLabel.trim() : null,
    visibility: typeof input.visibility === "string" && input.visibility.trim() ? input.visibility.trim() : "default",
    status: typeof input.status === "string" && input.status.trim() ? input.status.trim() : "active",
    ...input,
  };
}

export function normalizeGraphNode(raw = {}) {
  if (!isObject(raw)) throw new Error("graph preset node must be an object");
  const id = assertSafeGraphId(String(raw.id || ""), "node.id");
  const type = String(raw.type || "");
  if (!GRAPH_NODE_TYPES.includes(type)) throw new Error(`graph preset node "${id}" has unknown type "${type}"`);

  const node = {
    id,
    type,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
    ref: typeof raw.ref === "string" && raw.ref.trim() ? raw.ref.trim() : null,
    spec: isObject(raw.spec) ? raw.spec : null,
    customization: isObject(raw.customization) ? raw.customization : {},
    metadata: cleanObject(raw.metadata),
  };

  if (type === "orchestrator") {
    node.privileged = true;
    node.layer = "meta-orchestrator";
  }

  return node;
}

export function normalizeGraphEdge(raw = {}) {
  if (!isObject(raw)) throw new Error("graph preset edge must be an object");
  const from = assertSafeGraphId(String(raw.from || ""), "edge.from");
  const to = assertSafeGraphId(String(raw.to || ""), "edge.to");
  const type = String(raw.type || "");
  if (!GRAPH_EDGE_TYPES.includes(type)) throw new Error(`graph preset edge "${from}->${to}" has unknown type "${type}"`);
  return {
    from,
    to,
    type,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null,
    metadata: cleanObject(raw.metadata),
  };
}

export function evaluateGraphPreset(preset) {
  const errors = [];
  const warnings = [];
  const nodeIds = new Set();
  const unresolvedRefs = [];
  let hasExecutionSurface = false;

  for (const node of preset.nodes || []) {
    if (nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
    if (EXECUTION_NODE_TYPES.has(node.type)) hasExecutionSurface = true;
    const hasInlineShape = node.spec || Object.keys(node.customization || {}).length > 0;
    if (!node.ref && !hasInlineShape && !INLINE_NODE_TYPES.has(node.type)) {
      unresolvedRefs.push({ nodeId: node.id, type: node.type });
    }
  }

  for (const edge of preset.edges || []) {
    if (!nodeIds.has(edge.from)) errors.push(`edge references missing source node: ${edge.from}`);
    if (!nodeIds.has(edge.to)) errors.push(`edge references missing target node: ${edge.to}`);
  }

  if (!hasExecutionSurface) warnings.push("graph preset has no execution-surface node");
  const requestedStatus = preset.status || "draft";
  let graphStatus = "draft";
  if (GRAPH_PRESET_STATUSES.includes(requestedStatus) && requestedStatus === "retired") {
    graphStatus = "retired";
  } else if (errors.length) {
    graphStatus = "draft";
  } else if (unresolvedRefs.length) {
    graphStatus = "draft";
  } else if (hasExecutionSurface) {
    graphStatus = preset.governance?.stability === "stable" ? "stable" : "runnable";
  } else {
    graphStatus = "resolvable";
  }

  return {
    valid: errors.length === 0,
    status: graphStatus,
    errors,
    warnings,
    unresolvedRefs,
    hasExecutionSurface,
    permissionBoundaryRefs: (preset.nodes || [])
      .filter((node) => node.type === "permission-boundary")
      .map((node) => node.ref || node.id),
  };
}

export function normalizeGraphPreset(raw = {}, options = {}) {
  if (!isObject(raw)) throw new Error("graph preset must be an object");
  const id = assertSafeGraphId(String(raw.id || ""), "id");
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(normalizeGraphNode) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.map(normalizeGraphEdge) : [];

  const preset = {
    id,
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    status: GRAPH_PRESET_STATUSES.includes(raw.status) ? raw.status : "draft",
    presentation: normalizePresentation(id, raw.presentation),
    nodes,
    edges,
    provenance: {
      source: options.source || raw.provenance?.source || "runtime",
      ...cleanObject(raw.provenance),
    },
    governance: {
      auditable: true,
      dynamic: true,
      ...cleanObject(raw.governance),
    },
  };

  const evaluation = evaluateGraphPreset(preset);
  preset.graphStatus = evaluation.status;
  preset.telemetry = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    unresolvedRefCount: evaluation.unresolvedRefs.length,
    permissionBoundaryRefCount: evaluation.permissionBoundaryRefs.length,
  };
  return Object.freeze(preset);
}

export function validateGraphPreset(raw = {}) {
  try {
    const preset = normalizeGraphPreset(raw);
    const evaluation = evaluateGraphPreset(preset);
    return { valid: evaluation.valid, preset, ...evaluation };
  } catch (error) {
    return {
      valid: false,
      preset: null,
      status: "draft",
      errors: [error.message],
      warnings: [],
      unresolvedRefs: [],
      hasExecutionSurface: false,
      permissionBoundaryRefs: [],
    };
  }
}

export function resolveGraphPresetRecord(raw, options = {}) {
  const validation = validateGraphPreset(raw);
  const preset = validation.preset;
  return defineResolutionRecord({
    layer: "graph-preset",
    query: preset?.id || raw?.id || null,
    resolved: validation.valid ? preset : null,
    candidates: [],
    resolver: options.resolver || "graph-preset",
    status: validation.valid ? "resolved" : "unresolved",
    telemetry: {
      graphStatus: validation.status,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
      unresolvedRefCount: validation.unresolvedRefs.length,
      nodeCount: preset?.nodes.length || 0,
      edgeCount: preset?.edges.length || 0,
    },
    governance: {
      auditable: true,
      dynamic: true,
      runnable: validation.status === "runnable" || validation.status === "stable",
      permissionBoundaryRefs: validation.permissionBoundaryRefs,
    },
    provenance: preset?.provenance || {},
  });
}

export default {
  GRAPH_NODE_TYPES,
  GRAPH_EDGE_TYPES,
  GRAPH_PRESET_STATUSES,
  isSafeGraphId,
  assertSafeGraphId,
  normalizeGraphNode,
  normalizeGraphEdge,
  normalizeGraphPreset,
  validateGraphPreset,
  evaluateGraphPreset,
  resolveGraphPresetRecord,
};
