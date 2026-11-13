/**
 * illuci - assignable agent identity envelope.
 *
 * An agent assignment binds a stable agent id to a topology seat while keeping
 * model route, disposition, memory scope, and public display metadata as data.
 */

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function collapse(items) {
  return items.length <= 1 ? (items[0] ?? undefined) : items;
}

function normalizeDisposition(raw = {}) {
  const source = asObject(raw.disposition || raw.dispositionConfig || raw);
  const out = {};
  if (source.presetId) out.presetId = String(source.presetId);
  if (source.profile && typeof source.profile === "object") out.profile = source.profile;
  if (source.role) out.role = String(source.role);
  const skills = Array.isArray(source.skills) ? source.skills.map(String).filter(Boolean) : [];
  if (skills.length) out.skills = skills;
  return Object.keys(out).length ? out : null;
}

function normalizeAgentRecord(agentId, raw = {}) {
  const source = asObject(raw);
  const id = cleanString(agentId || source.agentId || source.id || source.agentSlug || source.slug);
  if (!id) return null;
  const agentSlug = cleanString(source.agentSlug || source.slug || id);
  const modelResource = source.modelResource ?? source.model ?? source.modelId ?? source.dispatchId ?? null;
  const publicSource = asObject(source.public || source.display || source.metadata?.public);
  const memorySource = asObject(source.memory);
  const disposition = normalizeDisposition(source);
  return {
    agentId: id,
    agentSlug,
    modelResource,
    model: cleanString(source.model || source.modelId || source.dispatchId),
    disposition,
    role: cleanString(source.role || disposition?.role),
    specialist: cleanString(source.specialist),
    skillFrameworks: Array.isArray(source.skillFrameworks) ? source.skillFrameworks.map(String).filter(Boolean) : [],
    skills: Array.isArray(source.skills) ? source.skills.map(String).filter(Boolean) : (disposition?.skills || []),
    memory: {
      scope: cleanString(memorySource.scope) || "project",
      private: memorySource.private !== false,
      projectId: cleanString(memorySource.projectId),
    },
    public: {
      displayName: cleanString(publicSource.displayName || publicSource.name),
      color: cleanString(publicSource.color),
      avatar: cleanString(publicSource.avatar),
      summary: cleanString(publicSource.summary),
    },
  };
}

function orgToManifest(org = null) {
  const source = asObject(org);
  const agents = {};
  const seats = {};

  for (const [id, raw] of Object.entries(asObject(source.agents))) {
    const agent = normalizeAgentRecord(id, raw);
    if (agent) agents[agent.agentId] = agent;
  }

  for (const [seatId, raw] of Object.entries(asObject(source.personas))) {
    const agent = normalizeAgentRecord(raw?.agentSlug || seatId, raw);
    if (!agent) continue;
    agents[agent.agentId] = { ...(agents[agent.agentId] || {}), ...agent };
    seats[seatId] = agent.agentId;
  }

  for (const [seatId, value] of Object.entries(asObject(source.seatAgents || source.assignments))) {
    seats[seatId] = value;
  }

  return { agents, seats };
}

export function normalizeAgentManifest(input = null) {
  const source = asObject(input);
  const orgManifest = source.charterId || source.personas ? orgToManifest(source) : { agents: {}, seats: {} };
  const rawAgents = source.agents && !source.charterId ? source.agents : {};
  const agents = { ...orgManifest.agents };
  for (const [id, raw] of Object.entries(asObject(rawAgents))) {
    const agent = normalizeAgentRecord(id, raw);
    if (agent) agents[agent.agentId] = agent;
  }
  const seats = {
    ...orgManifest.seats,
    ...asObject(source.seats),
    ...asObject(source.seatAgents),
    ...asObject(source.assignments),
  };
  return {
    schema: source.schema || "illuci.agent-assignment/1",
    agents,
    seats,
    stages: source.stages || source.stageMap || {},
  };
}

function selectTopologySeats(manifest, topologyId) {
  const seats = asObject(manifest?.seats);
  if (seats[topologyId] && typeof seats[topologyId] === "object" && !Array.isArray(seats[topologyId])) {
    return asObject(seats[topologyId].seats || seats[topologyId]);
  }
  return seats;
}

function agentModel(agent) {
  return agent?.modelResource ?? agent?.model ?? null;
}

function resolveAgentRef(ref, agents) {
  if (typeof ref === "string") return agents[ref] || null;
  if (ref && typeof ref === "object") {
    const id = ref.agentId || ref.id || ref.agentSlug || ref.slug;
    const known = id ? agents[id] : null;
    return normalizeAgentRecord(id, { ...(known || {}), ...ref });
  }
  return null;
}

function normalizeSeatAgents(value, agents) {
  return list(value).map((item) => resolveAgentRef(item, agents)).filter(Boolean);
}

export function resolveAgentLineup({ topologyId, lineup = {}, agentManifest = null, seatAgents = null, org = null } = {}) {
  const fromOptions = normalizeAgentManifest(agentManifest);
  const fromOrg = normalizeAgentManifest(org);
  const agents = { ...fromOrg.agents, ...fromOptions.agents };
  const manifest = {
    agents,
    seats: {
      ...selectTopologySeats(fromOrg, topologyId),
      ...selectTopologySeats(fromOptions, topologyId),
      ...asObject(seatAgents),
    },
  };

  const resolvedLineup = { ...(lineup || {}) };
  const boundAgents = {};

  for (const [seatId, binding] of Object.entries(selectTopologySeats(manifest, topologyId))) {
    const agentsForSeat = normalizeSeatAgents(binding, agents);
    if (!agentsForSeat.length) continue;
    boundAgents[seatId] = agentsForSeat;
    if (resolvedLineup[seatId] === undefined) {
      const models = agentsForSeat.map(agentModel).filter(Boolean);
      if (models.length) resolvedLineup[seatId] = collapse(models);
    }
  }

  for (const [seatId, value] of Object.entries(lineup || {})) {
    const values = list(value);
    const agentsForSeat = values.map((item) => resolveAgentRef(item, agents));
    if (!agentsForSeat.some(Boolean)) continue;
    boundAgents[seatId] = agentsForSeat.filter(Boolean);
    const models = values.map((item, index) => {
      const agent = agentsForSeat[index];
      return agent ? agentModel(agent) : item;
    }).filter((item) => item !== undefined && item !== null);
    resolvedLineup[seatId] = collapse(models);
  }

  return { lineup: resolvedLineup, seatAgents: boundAgents, agents };
}

export function bindResolvedModelsToAgents(normalizedLineup = {}, seatAgents = {}) {
  const out = {};
  for (const [seatId, modelsRaw] of Object.entries(normalizedLineup || {})) {
    const models = list(modelsRaw);
    const agents = list(seatAgents?.[seatId]);
    if (!agents.length) continue;
    out[seatId] = agents.map((agent, index) => ({
      ...agent,
      model: models[index] ?? agent.model ?? agent.modelResource ?? null,
    }));
  }
  return out;
}

export function agentDispositionMap(seatAgents = {}) {
  const out = {};
  for (const agents of Object.values(seatAgents || {})) {
    for (const agent of list(agents)) {
      if (agent?.agentId && agent.disposition) out[agent.agentId] = agent.disposition;
      if (agent?.agentSlug && agent.disposition) out[agent.agentSlug] = agent.disposition;
    }
  }
  return out;
}

export function publicAgentView(agent = {}) {
  return {
    agentId: agent.agentId || null,
    agentSlug: agent.agentSlug || null,
    model: agent.model || null,
    role: agent.role || null,
    specialist: agent.specialist || null,
    skillFrameworks: Array.isArray(agent.skillFrameworks) ? [...agent.skillFrameworks] : [],
    skills: Array.isArray(agent.skills) ? [...agent.skills] : [],
    public: { ...(agent.public || {}) },
  };
}

export function publicAgentAssignments(seatAgents = {}) {
  const out = {};
  for (const [seatId, agents] of Object.entries(seatAgents || {})) {
    out[seatId] = list(agents).map(publicAgentView);
  }
  return out;
}

export function buildAgentSeatAssignments(seatAgents = {}) {
  const out = {};
  for (const [seatId, agents] of Object.entries(seatAgents || {})) {
    out[seatId] = list(agents).map((agent) => ({ agent: publicAgentView(agent) }));
  }
  return out;
}

export function mergeSeatAssignmentMetadata(dispositionAssignments = null, agentAssignments = null) {
  if (!dispositionAssignments && !agentAssignments) return null;
  const out = {};
  const seats = new Set([
    ...Object.keys(dispositionAssignments || {}),
    ...Object.keys(agentAssignments || {}),
  ]);
  for (const seatId of seats) {
    const disposition = dispositionAssignments?.[seatId] || null;
    const agents = agentAssignments?.[seatId] || null;
    if (Array.isArray(agents)) {
      out[seatId] = agents.map((entry) => ({ ...(disposition ? { disposition } : {}), ...entry }));
    } else {
      out[seatId] = { ...(disposition ? { disposition } : {}), ...(agents || {}) };
    }
  }
  return out;
}

function stageRecord(stageMap, stageDef, stageIndex) {
  const source = asObject(stageMap);
  if (Array.isArray(source.stages)) {
    return source.stages.find((stage) =>
      stage?.sequence === stageIndex ||
      stage?.index === stageIndex ||
      stage?.topology === stageDef?.topologyId ||
      stage?.topologyId === stageDef?.topologyId ||
      stage?.label === stageDef?.label
    ) || null;
  }
  return source[String(stageIndex)] || source[stageDef?.id] || source[stageDef?.label] || source[stageDef?.topologyId] || null;
}

export function resolveStageAgentOptions({ agents = null, stageMap = null, stageDef = {}, stageIndex = 0 } = {}) {
  const manifest = normalizeAgentManifest(agents);
  const record = stageRecord(stageMap || manifest.stages, stageDef, stageIndex);
  const seats = record ? asObject(record.seats || record.assignments || record) : null;
  return {
    agents: manifest,
    ...(seats && Object.keys(seats).length ? { seatAgents: seats } : {}),
  };
}

export default {
  normalizeAgentManifest,
  resolveAgentLineup,
  bindResolvedModelsToAgents,
  agentDispositionMap,
  publicAgentAssignments,
  buildAgentSeatAssignments,
  mergeSeatAssignmentMetadata,
  resolveStageAgentOptions,
};
