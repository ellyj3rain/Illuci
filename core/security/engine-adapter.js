/**
 * Security engine adapter contracts.
 *
 * illuci orchestrates security engines through capability facts, work permits,
 * target scope, egress profiles, and evidence references. It does not import
 * sibling security-engine internals.
 */

import { evaluateWorkPermit } from "../governance/work-permit.js";

export const SECURITY_EGRESS_PROFILES = Object.freeze({
  package: Object.freeze({
    id: "package",
    network: "registries-and-local-infra",
    requiresPermit: false,
  }),
  provider: Object.freeze({
    id: "provider",
    network: "model-provider-endpoints",
    requiresPermit: true,
  }),
  "web-research": Object.freeze({
    id: "web-research",
    network: "bounded-web-research",
    requiresPermit: true,
  }),
  "security-authorized": Object.freeze({
    id: "security-authorized",
    network: "declared-security-targets",
    requiresPermit: true,
    evidenceRequired: true,
  }),
  "open-diagnostic": Object.freeze({
    id: "open-diagnostic",
    network: "operator-ratified-diagnostic-egress",
    requiresPermit: true,
    expires: "short-lived",
  }),
});

const EXECUTION_MODES = new Set(["read-only", "passive", "active-safe", "simulation", "restricted"]);
const ISOLATION_LEVELS = new Set(["in-process", "subprocess", "container", "vm", "external-sealed"]);

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function riskTier(value, fallback = 0) {
  if (Number.isInteger(value)) return Math.max(0, Math.min(4, value));
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "informational" || normalized === "info") return 0;
  if (normalized === "low") return 1;
  if (normalized === "moderate" || normalized === "medium") return 2;
  if (normalized === "high") return 3;
  if (normalized === "restricted" || normalized === "critical") return 4;
  return fallback;
}

function illuciRiskFromTier(tier) {
  if (tier <= 1) return "low";
  if (tier === 2) return "medium";
  if (tier === 3) return "high";
  return "critical";
}

function networkAccess(raw) {
  if (raw.network_access) return String(raw.network_access);
  if (raw.networkActive || raw.network_active) return "active-read";
  return "none";
}

function executionMode(raw) {
  const value = String(raw.execution_mode || raw.executionMode || "read-only");
  return EXECUTION_MODES.has(value) ? value : "read-only";
}

function isolationLevel(raw) {
  const value = String(raw.isolation || raw.isolationLevel || "subprocess");
  return ISOLATION_LEVELS.has(value) ? value : "subprocess";
}

export function normalizeSecurityCapability(raw = {}, { engineId } = {}) {
  const capabilityId = raw.capability_id || raw.capabilityId || raw.id;
  if (!capabilityId) throw new Error("security capability requires an id");
  const tier = riskTier(raw.risk_tier ?? raw.riskTier, networkAccess(raw) === "active-read" ? 1 : 0);
  return Object.freeze({
    engineId: String(engineId || raw.engineId || "unknown-security-engine"),
    capabilityId: String(capabilityId),
    module: raw.module ? String(raw.module) : null,
    action: raw.action ? String(raw.action) : "probe.execute",
    title: raw.title || raw.summary || String(capabilityId),
    description: raw.description || raw.summary || "",
    riskTier: tier,
    illuciRisk: illuciRiskFromTier(tier),
    executionMode: executionMode(raw),
    isolation: isolationLevel(raw),
    requiresPermit: raw.requires_permit ?? raw.requiresPermit ?? tier > 0,
    requiresDualApproval: raw.requires_dual_approval ?? raw.requiresDualApproval ?? tier >= 4,
    networkAccess: networkAccess(raw),
    destructive: Boolean(raw.destructive),
    sensitiveData: Boolean(raw.sensitive_data ?? raw.sensitiveData),
    targetKinds: Object.freeze(asArray(raw.allowed_target_kinds ?? raw.targetKinds).map(String)),
    inputSchema: raw.input_schema || raw.inputSchema || null,
    outputSchema: raw.output_schema || raw.outputSchema || null,
    version: raw.version ? String(raw.version) : null,
  });
}

export function assertAtomicSecurityRequest(request = {}) {
  const capabilityIds = [
    ...asArray(request.capabilityIds),
    ...asArray(request.capability_ids),
    ...asArray(request.capabilities),
  ].filter(Boolean);
  if (capabilityIds.length > 1 || Array.isArray(request.steps) || Array.isArray(request.workflow)) {
    throw new Error("security engine calls must execute one atomic capability at a time");
  }
  const capabilityId = request.capabilityId || request.capability_id || capabilityIds[0];
  if (!capabilityId) throw new Error("security engine call requires capabilityId");
  return String(capabilityId);
}

export function evaluateSecurityCapabilityPermit({
  permit = null,
  required = true,
  engineId,
  capability,
  target,
  now = new Date(),
} = {}) {
  const normalized = typeof capability === "string"
    ? normalizeSecurityCapability({ id: capability }, { engineId })
    : normalizeSecurityCapability(capability, { engineId });
  const targetValue = typeof target === "string"
    ? target
    : target?.locator || target?.url || target?.target || target?.target_id || target?.targetId || null;

  return evaluateWorkPermit({
    permit,
    required,
    toolName: "security_engine.execute",
    params: { url: targetValue },
    context: {
      toolFamily: "security",
      toolChannel: normalized.engineId,
      capability: normalized.capabilityId,
      risk: normalized.illuciRisk,
    },
    now,
  });
}

export function collectEvidenceRefs(result = {}) {
  const refs = new Set();
  for (const finding of asArray(result.findings)) {
    for (const ref of asArray(finding.evidence_refs ?? finding.evidenceRefs)) {
      if (ref) refs.add(String(ref));
    }
  }
  for (const evidence of asArray(result.evidence)) {
    if (evidence?.id) refs.add(String(evidence.id));
    if (evidence?.sha256) refs.add(`sha256:${evidence.sha256}`);
  }
  for (const artifact of asArray(result.artifacts)) {
    if (artifact?.uri) refs.add(String(artifact.uri));
    if (artifact?.sha256) refs.add(`sha256:${artifact.sha256}`);
    if (artifact?.hash) refs.add(String(artifact.hash));
  }
  return [...refs].sort();
}

export function createSecurityEngineAdapter(backend = {}) {
  if (!backend.engineId) throw new Error("security engine adapter requires engineId");
  const engineId = String(backend.engineId);

  let adapter;
  adapter = Object.freeze({
    engineId,
    async health() {
      return backend.health ? backend.health() : { status: "unknown", engineId };
    },
    async listCapabilities() {
      const raw = backend.listCapabilities
        ? await backend.listCapabilities()
        : backend.capabilities || [];
      const capabilities = Array.isArray(raw) ? raw : raw.capabilities || raw.descriptors || [];
      return capabilities.map((capability) => normalizeSecurityCapability(capability, { engineId }));
    },
    async describeCapability(capabilityId) {
      if (backend.describeCapability) {
        return normalizeSecurityCapability(await backend.describeCapability(capabilityId), { engineId });
      }
      const capabilities = await adapter.listCapabilities();
      const found = capabilities.find((capability) => capability.capabilityId === capabilityId);
      if (!found) throw new Error(`unknown security capability: ${capabilityId}`);
      return found;
    },
    async executeCapability(request = {}, context = {}) {
      const capabilityId = assertAtomicSecurityRequest(request);
      const capability = await adapter.describeCapability(capabilityId);
      const permitVerdict = evaluateSecurityCapabilityPermit({
        permit: context.workPermit || request.permit || null,
        required: context.workPermitRequired !== false && capability.requiresPermit,
        engineId,
        capability,
        target: request.target || request.targetScope || request.target_scope,
      });
      if (!permitVerdict.allow) {
        const err = new Error(permitVerdict.reason);
        err.code = permitVerdict.code;
        throw err;
      }
      if (!backend.executeCapability) {
        throw new Error(`security engine ${engineId} has no executeCapability implementation`);
      }
      const result = await backend.executeCapability({ ...request, capabilityId }, context);
      return {
        ...result,
        engineId,
        capabilityId,
        evidenceRefs: collectEvidenceRefs(result),
      };
    },
    async verifyAudit(params = {}) {
      if (!backend.verifyAudit) return { status: "unsupported", engineId, params };
      return backend.verifyAudit(params);
    },
    collectEvidenceRefs,
  });
  return adapter;
}

export default {
  SECURITY_EGRESS_PROFILES,
  normalizeSecurityCapability,
  assertAtomicSecurityRequest,
  evaluateSecurityCapabilityPermit,
  collectEvidenceRefs,
  createSecurityEngineAdapter,
};
