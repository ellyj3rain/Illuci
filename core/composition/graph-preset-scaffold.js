/**
 * Runtime graph preset scaffold helpers.
 *
 * These helpers turn compact operator-authored pipeline/company specs into the
 * graph preset substrate. They do not create canon; callers persist the returned
 * preset through the runtime graph preset store.
 */

import { assertSafeGraphId } from "./graph-preset.js";

const EXECUTION_KINDS = new Set(["topology", "company", "pipeline"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inferKind(spec = {}) {
  if (typeof spec.kind === "string" && EXECUTION_KINDS.has(spec.kind)) return spec.kind;
  if (Array.isArray(spec.stages)) return "pipeline";
  if (Array.isArray(spec.members)) return "company";
  if (typeof spec.topologyId === "string" || typeof spec.ref === "string") return "topology";
  return null;
}

function safeSegment(value, fallback) {
  const raw = String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const segment = /^[a-z]/.test(raw) ? raw : `n-${raw || fallback}`;
  return assertSafeGraphId(segment.slice(0, 96), "scaffold node id");
}

function publicSpecForNode(kind, item = {}) {
  const { kind: _kind, members: _members, stages: _stages, id: _id, label: _label, ...rest } = item;
  return {
    ...rest,
    ...(kind === "topology" && !rest.topologyId && item.ref ? { topologyId: item.ref } : {}),
  };
}

function addExecutionNode({ item, kind, parentId, index, relation, nodes, edges }) {
  const itemKind = kind || inferKind(item);
  if (!itemKind) throw new Error("graph preset scaffold item requires kind, topologyId, stages, or members");
  const nodeId = safeSegment(item.id || `${parentId}.${relation}.${index}`, `${parentId}.${relation}.${index}`);
  const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : nodeId;

  nodes.push({
    id: nodeId,
    type: itemKind,
    label,
    ref: itemKind === "topology" ? item.topologyId || item.ref || null : null,
    spec: publicSpecForNode(itemKind, item),
  });

  if (parentId) {
    edges.push({
      from: parentId,
      to: nodeId,
      type: "contains",
      metadata: { relation, sequence: index },
    });
  }

  const children = itemKind === "pipeline" ? item.stages : itemKind === "company" ? item.members : null;
  if (Array.isArray(children)) {
    children.forEach((child, childIndex) => addExecutionNode({
      item: child,
      parentId: nodeId,
      index: childIndex,
      relation: itemKind === "pipeline" ? "stage" : "member",
      nodes,
      edges,
    }));
  }

  return nodeId;
}

export function scaffoldRuntimeGraphPreset(id, kind, spec = {}) {
  assertSafeGraphId(id, "id");
  if (kind !== "pipeline" && kind !== "company") {
    throw new Error(`graph preset scaffold kind must be pipeline or company; got ${kind}`);
  }
  if (!isObject(spec)) throw new Error("graph preset scaffold spec must be an object");

  const nodes = [{
    id: "orchestrator",
    type: "orchestrator",
    label: "Meta Orchestrator",
    customization: {
      modelRefs: [],
      roleRefs: [],
      dispositionRefs: [],
      skillFrameworkRefs: [],
      instructionRefs: [],
      permissionBoundaryRefs: [],
    },
  }];
  const edges = [];
  const rootId = addExecutionNode({
    item: { ...spec, kind, id: spec.rootId || spec.id || `${kind}.root` },
    kind,
    parentId: null,
    index: 0,
    relation: "root",
    nodes,
    edges,
  });
  edges.push({ from: "orchestrator", to: rootId, type: "delegates-to", metadata: { relation: "root", sequence: 0 } });

  return {
    id,
    version: 1,
    status: "draft",
    presentation: {
      label: typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : id,
      publicLabel: typeof spec.publicLabel === "string" && spec.publicLabel.trim() ? spec.publicLabel.trim() : null,
      visibility: spec.visibility || "default",
      status: "active",
    },
    nodes,
    edges,
    provenance: {
      source: "runtime",
      scaffoldKind: kind,
    },
    governance: {
      auditable: true,
      dynamic: true,
      rootNodeId: rootId,
    },
  };
}

export default { scaffoldRuntimeGraphPreset };
