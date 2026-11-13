import { getEntry, isSuspended, listModels } from "../bridges/model-registry.js";
import { getModelResource, getProviderResource } from "./resource-gateway.js";

export const MODEL_LABEL_SCHEMA_VERSION = 1;

function safeNodePart(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "") || "unknown";
}

function titleFromKey(value) {
  return String(value || "unknown")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown";
}

function fallbackProviderId(providerKey) {
  return providerKey ? "provider." + safeNodePart(providerKey) : null;
}

function edge(from, relation, to, evidence = null) {
  return { from, relation, to, ...(evidence ? { evidence } : {}) };
}

function graphFor(label) {
  const edges = [];
  if (label.providerId) edges.push(edge(label.graphNodeId, "provided-by", label.providerId, "registry.provider"));
  if (label.family) edges.push(edge(label.graphNodeId, "in-family", "model-family." + safeNodePart(label.family), "registry.family"));
  if (label.variant) edges.push(edge(label.graphNodeId, "has-variant", "model-variant." + safeNodePart(label.family || "model") + "." + safeNodePart(label.variant), "registry.variant"));
  if (label.transport) edges.push(edge(label.graphNodeId, "uses-transport", "transport." + safeNodePart(label.transport), "registry.transport"));
  if (label.bridge) edges.push(edge(label.graphNodeId, "uses-bridge", "bridge." + safeNodePart(label.bridge.replace(/\.js$/u, "")), "registry.bridge"));
  if (label.providerModelString) edges.push(edge(label.graphNodeId, "provider-model", "provider-model." + safeNodePart(label.providerKey || "provider") + "." + safeNodePart(label.providerModelString), "registry.model"));
  if (label.routeStatus) edges.push(edge(label.graphNodeId, "has-route-status", "route-status." + safeNodePart(label.routeStatus), "registry.status"));
  return {
    node: {
      id: label.graphNodeId,
      kind: "model",
      label: label.displayName,
    },
    edges,
  };
}

function unknownLabel(requestedId) {
  const requested = String(requestedId || "").trim();
  const graphNodeId = "model.unknown." + safeNodePart(requested || "empty");
  const label = {
    schemaVersion: MODEL_LABEL_SCHEMA_VERSION,
    known: false,
    requestedId: requested,
    canonicalId: null,
    registryId: null,
    publicModelId: null,
    graphNodeId,
    displayName: requested ? titleFromKey(requested) : "Unknown Model",
    family: null,
    variant: null,
    tier: null,
    modality: null,
    fleetUse: null,
    capabilityLanes: [],
    providerId: null,
    providerKey: null,
    providerLabel: null,
    providerModelString: null,
    transport: null,
    bridge: null,
    cliId: null,
    routeStatus: null,
    aliases: [],
  };
  return { ...label, graph: graphFor(label) };
}

export function modelLabelFor(requestedId) {
  const requested = String(requestedId || "").trim();
  const entry = getEntry(requested);
  if (!entry) return unknownLabel(requested);

  const resource = getModelResource(entry.id);
  const provider = getProviderResource(entry.provider || null);
  const providerId = provider?.id || fallbackProviderId(entry.provider || null);
  const displayName = resource?.label || entry.label || titleFromKey(entry.id);
  const graphNodeId = resource?.id || "model." + safeNodePart(entry.id);
  const label = {
    schemaVersion: MODEL_LABEL_SCHEMA_VERSION,
    known: true,
    requestedId: requested,
    canonicalId: entry.id,
    registryId: entry.id,
    publicModelId: resource?.id || null,
    graphNodeId,
    displayName,
    family: entry.family || null,
    variant: entry.variant || null,
    tier: resource?.tier || entry.tier || entry.reasoning || null,
    modality: entry.modality || null,
    fleetUse: entry.fleetUse || null,
    capabilityLanes: [...(entry.capabilityLanes || [])],
    providerId,
    providerKey: entry.provider || null,
    providerLabel: provider?.label || (entry.provider ? titleFromKey(entry.provider) : null),
    providerModelString: entry.model || null,
    transport: entry.transport || null,
    bridge: entry.bridge || null,
    cliId: entry.cliAlias || null,
    routeStatus: isSuspended(entry.id) ? "suspended" : "available",
    aliases: [...(entry.aliases || [])],
  };
  return { ...label, graph: graphFor(label) };
}

export function listModelLabels(ids = null) {
  const targets = ids && ids.length ? ids : listModels().map((entry) => entry.id);
  return targets.map((id) => modelLabelFor(id));
}

export default { MODEL_LABEL_SCHEMA_VERSION, modelLabelFor, listModelLabels };
