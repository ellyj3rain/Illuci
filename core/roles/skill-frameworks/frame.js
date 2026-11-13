import { resolveSkillFrameworkUse } from "./catalog.js";

function cleanList(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

function asFrameworkRequest(value) {
  if (!value) return null;
  if (typeof value === "string") return { frameworkId: value };
  if (typeof value === "object") {
    const frameworkId = value.frameworkId || value.id || value.ref;
    if (!frameworkId || typeof frameworkId !== "string") return null;
    return { ...value, frameworkId };
  }
  return null;
}

export function normalizeSkillFrameworkRequests(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(asFrameworkRequest).filter(Boolean);
  const one = asFrameworkRequest(value);
  return one ? [one] : [];
}

function summarizeDisabledControls(controls = []) {
  return controls
    .filter((control) => !control.enabled || control.requiresExplicitGrant)
    .map((control) => {
      const flags = [];
      if (!control.enabled) flags.push("disabled");
      if (control.requiresExplicitGrant) flags.push("explicit grant");
      return `${control.actionRef}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    });
}

function renderBehaviorContract(contract) {
  if (!contract) return [];
  const lines = [];
  const label = contract.schema || "unnamed";
  const status = contract.status ? `; ${contract.status}` : "";
  const purpose = contract.purpose ? `; ${contract.purpose}` : "";
  lines.push(`  Behavior contract: ${label}${status}${purpose}.`);
  const required = cleanList(contract.requiredOutputFields);
  if (required.length) lines.push(`  Required output fields: ${required.join(", ")}.`);
  for (const field of Array.isArray(contract.conditionalOutputFields) ? contract.conditionalOutputFields : []) {
    const parts = [`  Conditional output field: ${field.field}`];
    if (field.when) parts.push(`when ${field.when}`);
    if (field.requirement) parts.push(`requirement: ${field.requirement}`);
    lines.push(`${parts.join("; ")}.`);
  }
  if (contract.rootExceptionPolicy) lines.push(`  Root exception policy: ${contract.rootExceptionPolicy}`);
  if (contract.orchestrationStandard) lines.push(`  Orchestration standard: ${contract.orchestrationStandard}`);
  return lines;
}

function renderTraceabilityGate(gate) {
  if (!gate) return [];
  const fields = cleanList(gate.requiredEvidenceFields);
  const target = gate.blockedRef || "promotion";
  const status = gate.status ? ` (${gate.status})` : "";
  const lines = [`  Blocked promotion gate: ${target}${status}${fields.length ? ` requires ${fields.join(", ")}` : ""}.`];
  if (gate.requirement) lines.push(`  Promotion requirement: ${gate.requirement}`);
  return lines;
}

function renderResolvedUse(result) {
  const resolved = result?.resolved;
  if (!resolved) return `- ${result?.query || "unknown"}: unresolved (${result?.status || "unknown"}).`;

  const lines = [];
  lines.push(`- ${resolved.frameworkId}: atoms ${cleanList(resolved.selectedSkillRefs).join(", ") || "none"}.`);
  lines.push(...renderBehaviorContract(resolved.behaviorContract));
  lines.push(...renderTraceabilityGate(resolved.traceabilityGate));
  lines.push(`  Channels: ${cleanList(resolved.enabledToolChannels).join(", ") || "none"}.`);
  lines.push(`  Boundaries: ${cleanList(resolved.permissionBoundaryRefs).join(", ") || "none"}.`);
  const enabledActions = cleanList(resolved.enabledActionRefs);
  if (enabledActions.length) lines.push(`  Enabled actions: ${enabledActions.join(", ")}.`);
  const disabled = summarizeDisabledControls(resolved.permissionControls);
  if (disabled.length) lines.push(`  Disabled or explicit-grant controls: ${disabled.join(", ")}.`);
  return lines.join("\n");
}

export function renderSkillFrameworkUseBlock(frameworkUses = []) {
  const uses = Array.isArray(frameworkUses) ? frameworkUses.filter(Boolean) : [];
  if (!uses.length) return null;
  const lines = [
    "[Skill Frameworks]",
    "Runtime-resolved skill frameworks operating on this seat. They shape decomposition, permission awareness, and recursive routing; they never lift the operator gate.",
  ];
  for (const use of uses) lines.push(renderResolvedUse(use));
  return lines.join("\n");
}

export function resolveSkillFrameworkBlocksForTopology({
  topology,
  topologyId,
  skillFrameworks = null,
  seatSkillFrameworks = null,
} = {}) {
  const globalRequests = normalizeSkillFrameworkRequests(skillFrameworks);
  const perSeatRequests = seatSkillFrameworks && typeof seatSkillFrameworks === "object" && !Array.isArray(seatSkillFrameworks)
    ? seatSkillFrameworks
    : {};
  const blocks = {};
  const usesBySeat = {};

  for (const seat of topology?.seats || []) {
    const requests = [
      ...globalRequests,
      ...normalizeSkillFrameworkRequests(perSeatRequests[seat.id]),
    ];
    if (!requests.length) continue;

    const resolved = requests.map((request) => resolveSkillFrameworkUse({
      ...request,
      topology: request.topology || topologyId || null,
      roleId: request.roleId || seat.roleHint || null,
    }));
    usesBySeat[seat.id] = resolved;
    const block = renderSkillFrameworkUseBlock(resolved);
    if (block) blocks[seat.id] = block;
  }

  return { blocks, usesBySeat };
}

export default {
  normalizeSkillFrameworkRequests,
  renderSkillFrameworkUseBlock,
  resolveSkillFrameworkBlocksForTopology,
};
