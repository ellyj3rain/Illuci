// core/runtime/capability.js
//
// [A22.1] Illuci Runtime service — normalized capability response.
//
// The authoritative answer to "what can I call?" for a remote client: the runtime's
// providers / models / topologies / roles / skill-frameworks / auth-modes and (when the
// MCP adapter is present) its tools / resources / prompts — in Illuci-owned shapes, never
// leaking secrets. Each facet is resolved defensively so one unavailable surface degrades
// to empty rather than failing the whole introspection.

import { RUNTIME_SCHEMA_VERSION } from "./identity.js";
import { listProviderResources, listModelResources } from "../fleet/resource-gateway.js";
import { listTopologies } from "../topologies/index.js";
import { listRoleIds } from "../roles/role-registry.js";
import { listSkillFrameworkIds } from "../roles/skill-frameworks/catalog.js";
import { defaultsSnapshot } from "../governance/defaults-registry.js";
import { postureProfileSnapshot } from "../governance/posture-profile.js";

function safe(fn, fallback) {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function normalizeProvider(p) {
  return {
    id: p?.id ?? null,
    label: p?.label ?? null,
    organization: p?.organization ?? null,
    class: p?.class ?? null,
    authMode: p?.auth ?? null,
  };
}

function normalizeModel(m) {
  const defaultChannel = Array.isArray(m?.channels) ? m.channels.find((channel) => channel.isDefault) || m.channels[0] : null;
  return {
    id: m?.id ?? null,
    registryId: m?.registryId ?? m?.diagnostics?.registryId ?? defaultChannel?.dispatchId ?? null,
    label: m?.label ?? null,
    tier: m?.tier ?? null,
    provider: m?.provider ?? defaultChannel?.providerResourceId ?? m?.family ?? null,
    providerLabel: m?.providerLabel ?? null,
    providerModel: m?.providerModel ?? m?.diagnostics?.providerModel ?? defaultChannel?.diagnostics?.providerModel ?? null,
    transport: m?.transport ?? defaultChannel?.transport ?? null,
    authMode: m?.auth ?? m?.authMode ?? defaultChannel?.auth ?? null,
    lane: m?.lane ?? null,
    status: m?.status ?? m?.routeStatus ?? m?.diagnostics?.routeStatus ?? null,
    modality: m?.modality ?? null,
    fleetUse: m?.fleetUse ?? null,
    capabilityLanes: Array.isArray(m?.capabilityLanes) ? m.capabilityLanes : [],
  };
}

// Distinct auth modes across providers — "what auth is possible", never any secret value.
function deriveAuthModes(providers) {
  const modes = new Set();
  for (const p of providers) if (p.authMode) modes.add(p.authMode);
  return [...modes].sort();
}

function keysByKind(registry, kind) {
  return Object.entries(registry || {})
    .filter(([, s]) => s?.kind === kind)
    .map(([k]) => k)
    .sort();
}

/**
 * Normalized capability response.
 * @param {object} [opts]
 * @param {object|null} [opts.mcpRegistry] the SCHEMA_REGISTRY from startServer() — supplies the MCP tool/resource/prompt surface.
 */
export function getRuntimeCapability({ mcpRegistry = null } = {}) {
  const providers = safe(() => listProviderResources(), []).map(normalizeProvider);
  const models = safe(() => listModelResources(), []).map(normalizeModel);
  const topologies = safe(() => listTopologies(), []);
  const roles = safe(() => listRoleIds(), []);
  const skillFrameworks = safe(() => listSkillFrameworkIds(), []);

  const mcp = mcpRegistry
    ? {
        tools: keysByKind(mcpRegistry, "tool"),
        resources: keysByKind(mcpRegistry, "resource"),
        prompts: keysByKind(mcpRegistry, "prompt"),
      }
    : { present: false, note: "pass mcpRegistry (startServer().registry) for the MCP surface" };

  // [A50]/DR-130: the active default posture rides the capability response, so
  // ANY surface consuming the runtime (CLI, GUI, an attaching agent) can disclose
  // "what Illuci does by default, why, and how to change it" without a second call.
  const defaults = safe(() => defaultsSnapshot(), null);
  const postureProfile = safe(() => postureProfileSnapshot(), null);

  return {
    schema: RUNTIME_SCHEMA_VERSION,
    providers,
    models,
    topologies,
    roles,
    skillFrameworks,
    authModes: deriveAuthModes(providers),
    mcp,
    ...(defaults ? { defaults } : {}),
    ...(postureProfile ? { postureProfile } : {}),
    counts: {
      providers: providers.length,
      models: models.length,
      topologies: Array.isArray(topologies) ? topologies.length : Object.keys(topologies || {}).length,
      roles: roles.length,
      skillFrameworks: skillFrameworks.length,
    },
  };
}

export default { getRuntimeCapability };
