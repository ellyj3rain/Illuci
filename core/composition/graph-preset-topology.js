/**
 * Graph preset to runtime topology bridge.
 *
 * A graph preset may describe a topology node. When that node carries an inline
 * topology spec, this bridge validates it and writes through the existing
 * runtime topology overlay. It does not invent a second topology store.
 */

import { TOPOLOGIES } from "../topologies/index.js";
import { createRuntimeTopology } from "../topologies/runtime-topologies.js";
import { getGraphPreset } from "./graph-preset-store.js";

function topologyNodeSpec(node) {
  if (!node || node.type !== "topology" || !node.spec) return null;
  const spec = node.spec;
  const id = typeof spec.id === "string" && spec.id.trim() ? spec.id.trim() : node.ref || node.id;
  return {
    id,
    name: typeof spec.name === "string" ? spec.name : node.label || id,
    description: typeof spec.description === "string" ? spec.description : "",
    seats: Array.isArray(spec.seats) ? spec.seats : [],
    phases: Array.isArray(spec.phases) ? spec.phases : [],
  };
}

export function validateGraphTopologyNode(node, options = {}) {
  const errors = [];
  if (!node || node.type !== "topology") errors.push("node must be a topology node");
  const spec = topologyNodeSpec(node);
  if (!spec) errors.push("topology node requires an inline spec to materialize");
  if (spec) {
    if (!spec.id) errors.push("topology spec requires an id");
    if (TOPOLOGIES[spec.id] || (options.reservedIds || []).includes(spec.id)) {
      errors.push(`topology id "${spec.id}" collides with a canonical topology`);
    }
    if (!spec.seats.length) errors.push("topology spec requires at least one seat");
    if (!spec.phases.length) errors.push("topology spec requires at least one phase");
  }
  return { valid: errors.length === 0, errors, spec };
}

export function materializeGraphTopologyNode(node, options = {}) {
  const validation = validateGraphTopologyNode(node, options);
  if (!validation.valid) {
    return { created: false, id: validation.spec?.id || node?.id || null, reason: "invalid-topology-node", errors: validation.errors };
  }
  const topology = createRuntimeTopology(validation.spec.id, validation.spec, {
    storeFile: options.topologyStoreFile,
    reservedIds: Object.keys(TOPOLOGIES),
  });
  if (topology === null) {
    return { created: false, id: validation.spec.id, reason: "runtime-topology-create-refused", errors: [] };
  }
  return { created: true, id: topology.id, topology };
}

export function materializeTopologyFromGraphPreset(presetId, nodeId = null, options = {}) {
  const preset = typeof presetId === "string" ? getGraphPreset(presetId, options) : presetId;
  if (!preset) return { created: false, id: presetId, reason: "unknown-graph-preset", errors: [] };
  const candidates = preset.nodes.filter((node) => node.type === "topology" && node.spec);
  const node = nodeId ? candidates.find((candidate) => candidate.id === nodeId) : candidates[0];
  if (!node) {
    return { created: false, id: preset.id, reason: "no-materializable-topology-node", errors: [] };
  }
  return materializeGraphTopologyNode(node, options);
}

export default {
  validateGraphTopologyNode,
  materializeGraphTopologyNode,
  materializeTopologyFromGraphPreset,
};
