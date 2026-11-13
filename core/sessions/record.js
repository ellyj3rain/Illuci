/**
 * illuci - Session Records + Distillation (memory strata 2-4, file-based)
 *
 * A session record is stratum 4: the immutable join of a run, mandate,
 * arrangement timeline, and outcome. Closing a session distills upward into
 * project lessons (stratum 2) and agent experiences (stratum 3).
 *
 * Canonical storage:
 *   <projectDir>/.illuci/data/sessions/<sessionId>.json
 *   <projectDir>/.illuci/data/memory/project.jsonl
 *   <projectDir>/.illuci/data/memory/agents/<slug>.jsonl
 *   <projectDir>/.illuci/data/memory/personas/<slug>.jsonl  (compatibility alias)
 *
 * Legacy read compatibility:
 *   <projectDir>/.illuci/sessions/*
 *   <projectDir>/.illuci/memory/*
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const CONFIG_DIR = ".illuci";
const DATA_DIR = "data";

function dataDir(projectDir) { return join(projectDir, CONFIG_DIR, DATA_DIR); }
function sessionsDir(projectDir) { return join(dataDir(projectDir), "sessions"); }
function memoryDir(projectDir) { return join(dataDir(projectDir), "memory"); }
function agentsDir(projectDir) { return join(memoryDir(projectDir), "agents"); }
function personasDir(projectDir) { return join(memoryDir(projectDir), "personas"); }
function legacySessionsDir(projectDir) { return join(projectDir, CONFIG_DIR, "sessions"); }
function legacyMemoryDir(projectDir) { return join(projectDir, CONFIG_DIR, "memory"); }
function legacyAgentsDir(projectDir) { return join(legacyMemoryDir(projectDir), "agents"); }
function legacyPersonasDir(projectDir) { return join(legacyMemoryDir(projectDir), "personas"); }
function existingDirs(...dirs) { return dirs.filter((dir) => existsSync(dir)); }
function freezeJson(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function sessionFile(sessionId, runId = null) {
  if (!safeKey(sessionId) || (runId !== null && (typeof runId !== "string" || !runId))) throw Error("Valid session/run coordinate required");
  return runId === null ? `${sessionId}.json` : `${sessionId}--${digest(runId)}.json`;
}

/** Persist a session record (stratum 4). Immutable: refuses to overwrite. */
export function appendSessionRecord(projectDir, record, { publication = null } = {}) {
  if (!record?.sessionId) throw new Error("appendSessionRecord: record.sessionId required");
  if (publication !== null && typeof publication !== "function") throw TypeError("Host session publication callback required");
  const dir = sessionsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const sessionId = record.sessionId, runId = record.runId ?? null;
  const path = join(dir, sessionFile(sessionId, runId));
  if (existsSync(path)) throw new Error(`session record "${record.sessionId}" already exists (records are immutable)`);
  let sealed = { ...record, recordedAt: new Date().toISOString() };
  if (publication) {
    // Snapshot the JSON representation before calling host code. Separate copies
    // let us check both final bytes and mutation of the seal returned downstream.
    const prepared = JSON.stringify(sealed), expected = JSON.parse(prepared);
    if (expected?.sessionId !== sessionId || (expected.runId ?? null) !== runId) {
      throw Error("Session publication coordinate changed during serialization");
    }
    sealed = freezeJson(JSON.parse(prepared));
    const target = resolve(path), receipt = publication(target, sealed);
    if (receipt && typeof receipt.then === "function") {
      Promise.resolve(receipt).catch(() => {});
      throw TypeError("Synchronous host session publication required; inspect before retry");
    }
    const acknowledgedPath = receipt?.path, acknowledgedHash = receipt?.sha256;
    if (acknowledgedPath !== target || !/^[a-f0-9]{64}$/.test(acknowledgedHash ?? "")) {
      throw Error("Session publication readback is unacknowledged; inspect before retry");
    }
    const finalBytes = readFileSync(target);
    if (createHash("sha256").update(finalBytes).digest("hex") !== acknowledgedHash) {
      throw Error("Session publication readback is unacknowledged; inspect before retry");
    }
    let published;
    try { published = JSON.parse(finalBytes.toString("utf8")); }
    catch { throw Error("Session publication seal is invalid; inspect before retry"); }
    if (!isDeepStrictEqual(published, expected) || !isDeepStrictEqual(sealed, expected)) {
      throw Error("Session publication seal differs from its prepared snapshot; inspect before retry");
    }
  } else {
    // Compatibility path for hosts without a configured qualified publisher.
    writeFileSync(path, JSON.stringify(sealed, null, 2), { encoding: "utf-8", flag: "wx" });
  }
  return sealed;
}

/** List session records (newest last), summaries only. Canonical records win over legacy duplicates. */
export function listSessionRecords(projectDir) {
  const seen = new Set();
  const out = [];
  for (const dir of existingDirs(sessionsDir(projectDir), legacySessionsDir(projectDir))) {
    for (const f of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        const key = JSON.stringify([r?.sessionId, r?.runId ?? null]);
        if (!r?.sessionId || seen.has(key)) continue;
        seen.add(key);
        out.push({
          sessionId: r.sessionId,
          runId: r.runId ?? null,
          topologyId: r.topologyId,
          agendaMode: r.agendaMode || null,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          halted: !!r.halted,
          intent: r.mandate?.intent?.raw?.slice(0, 120) || null,
        });
      } catch {
        // ignore damaged records in both canonical and legacy lanes
      }
    }
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** Read one full session record. Canonical records are checked before legacy records. */
export function getSessionRecord(projectDir, sessionId, { runId = null } = {}) {
  const exact = sessionFile(sessionId, runId), selected = [];
  for (const dir of existingDirs(sessionsDir(projectDir), legacySessionsDir(projectDir))) {
    // Select filenames before loading any payload. Unqualified session lookup
    // must not silently pick one of several company members.
    const names = runId !== null ? [exact, `${sessionId}.json`] : readdirSync(dir).filter(name =>
      name === exact || (name.startsWith(`${sessionId}--`) && /^[a-f0-9]{64}\.json$/.test(name.slice(sessionId.length + 2))));
    for (const name of names) {
      const file = join(dir, name); if (!existsSync(file)) continue;
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (record.sessionId !== sessionId || (runId !== null && record.runId !== runId)) continue;
        if (!selected.some(r => (r.runId ?? null) === (record.runId ?? null))) selected.push(record);
      } catch { return null; }
    }
  }
  return selected.length === 1 ? selected[0] : null;
}

/**
 * Build a session record from a topology run trace + mandate. Pure; persistence
 * is appendSessionRecord's job.
 */
export function buildSessionRecord({ sessionId, trace, mandate, org = null, runId = trace.runId ?? null }) {
  const observations = [];
  let omitted = 0, unattributed = 0;
  for (const [phaseId, phase] of Object.entries(trace.phases || {})) {
    for (const [index, response] of (Array.isArray(phase?.responses) ? phase.responses : []).entries()) {
      // No model/seat fallback establishes a durable agent identity.
      if (typeof response?.agentId !== "string" || !response.agentId || typeof response.seat !== "string" || !response.seat) { unattributed++; continue; }
      if (observations.length >= 256) { omitted++; continue; }
      const output = typeof response.response === "string" ? response.response : "";
      observations.push({ phaseId, index, agentId: response.agentId, seat: response.seat,
        model: response.model ?? null, status: response.error ? "error-observed" : output ? "output-observed" : "empty-observed",
        outputSha256: digest(output), outputBytes: Buffer.byteLength(output, "utf8"),
        gateStatus: ["passed", "failed"].includes(phase.gateStatus) ? phase.gateStatus : "unassessed" });
    }
  }
  return {
    sessionId,
    runId,
    topologyId: trace.topologyId,
    agendaMode: trace.agenda?.mode || null,
    kind: org?.kind || null,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt || null,
    halted: !!trace.halted,
    haltReason: trace.haltReason || null,
    mandate: {
      operator: mandate?.operator || null,
      intent: mandate?.intent || null,
    },
    lineup: trace.lineup,
    agentAssignments: trace.agentAssignments || null,
    arrangement: trace.arrangement || [],
    phaseIds: Object.keys(trace.phases || {}),
    agentContinuity: trace.agentContinuity ?? null,
    agentProgress: { schema: "illuci.agent-progress/1", observations, omitted, unattributed,
      scope: "retained final phase snapshots; output and gate observations are not goal acceptance or complete retry history" },
  };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function assignmentFor(record, seatId, index) {
  const raw = record.agentAssignments?.[seatId];
  if (!raw) return null;
  return Array.isArray(raw) ? raw[index] || null : raw;
}

function orgAgentFor(org, seatId, index) {
  const seatAgents = org?.seatAgents?.[seatId] || org?.assignments?.[seatId] || null;
  const ref = Array.isArray(seatAgents) ? seatAgents[index] : seatAgents;
  if (typeof ref === "string") return org?.agents?.[ref] || { agentId: ref, agentSlug: ref };
  if (ref && typeof ref === "object") return ref;
  const persona = org?.personas?.[seatId];
  if (persona && index === 0) return persona;
  return null;
}

function resolveExperienceIdentity({ record, org, seatId, model, index }) {
  const assignment = assignmentFor(record, seatId, index);
  const agent = orgAgentFor(org, seatId, index);
  const slug =
    assignment?.agentSlug ||
    assignment?.agentId ||
    agent?.agentSlug ||
    agent?.slug ||
    agent?.agentId ||
    agent?.id ||
    model;
  if (!slug) return null;
  return {
    agentSlug: slug,
    agentId: assignment?.agentId || agent?.agentId || agent?.id || slug,
  };
}

function appendAgentExperience(projectDir, slug, experience) {
  const line = JSON.stringify(experience) + "\n";
  appendFileSync(join(agentsDir(projectDir), `${slug}.jsonl`), line, "utf-8");
  appendFileSync(join(personasDir(projectDir), `${slug}.jsonl`), line, "utf-8");
}

/**
 * Distill a session record upward.
 * - project.jsonl gains one lesson line.
 * - each seated persona gains one experience line.
 */
export function distillSession(projectDir, record, org = null) {
  mkdirSync(memoryDir(projectDir), { recursive: true });
  mkdirSync(agentsDir(projectDir), { recursive: true });
  mkdirSync(personasDir(projectDir), { recursive: true });

  const interventions = (record.arrangement || []).filter((e) =>
    e.type === "checkpoint" || e.type === "mandate_revised",
  ).length;

  const lesson = {
    t: new Date().toISOString(),
    sessionId: record.sessionId,
    topologyId: record.topologyId,
    agendaMode: record.agendaMode,
    kind: record.kind,
    halted: record.halted,
    haltReason: record.haltReason,
    steps: record.phaseIds,
    operatorInterventions: interventions,
    intent: record.mandate?.intent?.raw?.slice(0, 200) || null,
  };
  appendFileSync(join(memoryDir(projectDir), "project.jsonl"), JSON.stringify(lesson) + "\n", "utf-8");

  const agents = {};
  for (const [seatId, models] of Object.entries(record.lineup || {})) {
    for (const [index, model] of asArray(models).entries()) {
      const identity = resolveExperienceIdentity({ record, org, seatId, model, index });
      if (!identity?.agentSlug) continue;
      const experience = {
        t: new Date().toISOString(),
        sessionId: record.sessionId,
        runId: record.runId ?? null,
        sourceRecordSha256: digest(record),
        identitySource: assignmentFor(record, seatId, index)?.agentId ? "assignment" : "legacy-unverified",
        assignmentIndex: index,
        topologyId: record.topologyId,
        seat: seatId,
        agentId: identity.agentId,
        agentSlug: identity.agentSlug,
        model,
        models: [model],
        stepsParticipated: record.phaseIds.length,
        halted: record.halted,
        intent: record.mandate?.intent?.raw?.slice(0, 120) || null,
      };
      appendAgentExperience(projectDir, identity.agentSlug, experience);
      agents[identity.agentSlug] = experience;
    }
  }

  return { project: lesson, agents, personas: agents };
}

const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const safeKey = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);

/** Read source-verified structural changes from the existing M5 experience lane.
 * The host selects the project and identities; this is no authentication/grant.
 * Legacy/model-keyed history remains available through loadAgentDigest, but
 * cannot silently become verified longitudinal agent state here.
 */
export function readAgentContinuity(projectDir, agent, { limit = 5, after = null } = {}) {
  if (!agent?.agentId || typeof agent.agentId !== "string" || !agent.agentId.trim() || !safeKey(agent.agentSlug) ||
      !Number.isInteger(limit) || limit < 1 || limit > 20) throw Error("Bounded agent identity and history limit required");
  if (after !== null && (!safeKey(after?.sessionId) || typeof after.runId !== "string" ||
      !/^[a-f0-9]{64}$/.test(after.sha256) || Object.keys(after).some(k => !["sessionId", "runId", "sha256"].includes(k)))) {
    throw Error("Exact agent continuity cursor required");
  }
  const view = { agentId: agent.agentId, agentSlug: agent.agentSlug, status: "no-recorded-state", changes: [], cursor: after,
    coverage: { unverifiedEntries: 0, omittedEarlier: 0, remaining: 0, indexCompleteness: "unverified",
      ordering: "experience append order; not execution chronology" },
    scope: "selected project/agent structural observations; no permissions, personality update or goal-success inference" };
  const file = [agentsDir(projectDir), personasDir(projectDir), legacyAgentsDir(projectDir), legacyPersonasDir(projectDir)]
    .map(dir => join(dir, `${agent.agentSlug}.jsonl`)).find(p => existsSync(p));
  if (!file) { if (after) view.status = "needs-reconciliation"; return view; }
  try {
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const changes = new Map();
    for (const row of rows) {
      if (row.agentId !== agent.agentId) continue;
      if (row.identitySource !== "assignment" || typeof row.runId !== "string") { view.coverage.unverifiedEntries++; continue; }
      if (!safeKey(row.sessionId)) throw Error("Invalid source session reference");
      const source = getSessionRecord(projectDir, row.sessionId, { runId: row.runId });
      const assigned = source && assignmentFor(source, row.seat, row.assignmentIndex);
      if (!source || source.sessionId !== row.sessionId || source.runId !== row.runId || digest(source) !== row.sourceRecordSha256 ||
          assigned?.agentId !== agent.agentId || (assigned.agentSlug || assigned.agentId) !== agent.agentSlug ||
          source.agentProgress?.schema !== "illuci.agent-progress/1" || !Array.isArray(source.agentProgress.observations)) throw Error("Changed or mismatched agent history source");
      const key = JSON.stringify([source.sessionId, source.runId]);
      let change = changes.get(key);
      if (!change) {
        change = { source: { sessionId: source.sessionId, runId: source.runId, sha256: row.sourceRecordSha256 },
          goal: { field: "mandate.intent", revision: source.mandate?.intent?.revision ?? null,
            sha256: typeof source.mandate?.intent?.raw === "string" ? digest(source.mandate.intent.raw) : null, acceptance: "unassessed" },
          halted: source.halted === true, observations: [], sourceObservationsOmitted: source.agentProgress.omitted,
          sourceUnattributedObservations: source.agentProgress.unattributed };
        changes.set(key, change);
      }
      // Derive from the pinned source, never from an editable experience summary.
      const observed = (source.agentProgress?.observations || []).filter(o => o.agentId === agent.agentId && o.seat === row.seat);
      for (const observation of observed) {
        if (!change.observations.some(o => o.phaseId === observation.phaseId && o.index === observation.index)) change.observations.push(observation);
      }
    }
    const all = [...changes.values()];
    let start = Math.max(0, all.length - limit);
    if (after) {
      const index = all.findIndex(c => c.source.sessionId === after.sessionId && c.source.runId === after.runId && c.source.sha256 === after.sha256);
      if (index < 0) throw Error("Agent continuity cursor not in retained history");
      start = index + 1;
    } else view.coverage.omittedEarlier = start;
    view.changes = all.slice(start, start + limit);
    view.coverage.remaining = Math.max(0, all.length - start - view.changes.length);
    view.cursor = view.changes.at(-1)?.source ?? after;
    view.status = all.length ? "source-verified" : view.coverage.unverifiedEntries ? "unverified-history" : "no-recorded-state";
    return view;
  } catch { return { ...view, status: "needs-reconciliation", changes: [], cursor: after }; }
}

/** Structural observations at engine call boundaries. No input/exception text,
 * provider receipt, inner seat-loop turns, acceptance or durable audit is inferred.
 */
export function createAgentContinuityObserver(blocks, { limit = 256 } = {}) {
  if (!blocks || typeof blocks !== "object" || Array.isArray(blocks) ||
      !Number.isInteger(limit) || limit < 1 || limit > 256) throw Error("Bounded prepared continuity frames required");
  const frames = new Map(Object.entries(blocks));
  if ([...frames.values()].some(frame => typeof frame !== "string" || !frame)) throw Error("Prepared continuity frame text required");
  const state = { schema: "illuci.agent-continuity-dispatch/1", observations: [], omitted: 0, unassigned: 0,
    scope: "buffered query and initial seat-loop entry inputs/settlement; not provider receipt, inner turns, native delegate, model use or goal acceptance" };
  let ordinal = 0;
  return { state, async invoke({ recipientId, phaseId, seat, model, route }, input, operation) {
    if (typeof operation !== "function" || !["query-model", "seat-loop-entry"].includes(route)) throw Error("Known engine call boundary required");
    if (!frames.has(recipientId)) { state.unassigned++; return operation(); }
    const frame = frames.get(recipientId), sequence = ++ordinal;
    let observation = null;
    if (state.observations.length >= limit) state.omitted++;
    else {
      observation = { ordinal: sequence, recipientId, phaseId: phaseId ?? null, seat: seat ?? null, model: model ?? null, route,
        frameSha256: digest(frame), inputSha256: typeof input === "string" ? digest(input) : null,
        inputBytes: typeof input === "string" ? Buffer.byteLength(input, "utf8") : null,
        presence: typeof input !== "string" ? "non-text-input" : input.includes(frame) ? "exact-frame-present" : "absent",
        outcome: "pending" };
      state.observations.push(observation);
    }
    try {
      const value = await operation();
      if (observation) observation.outcome = "returned";
      return value;
    } catch (error) {
      if (observation) observation.outcome = "threw";
      throw error;
    }
  } };
}

/** Recipient-selected change views over existing assignments, not a new team or
 * personality store. Peer views contain structural references, never prompts or
 * output text. The caller remains responsible for project/custody authorization.
 */
export function buildAgentContinuityBlocks(projectDir, seatAgents, control) {
  if (control === undefined || control === false) return null;
  if (!projectDir || !control || typeof control !== "object" || Array.isArray(control) ||
      Object.keys(control).some(k => !["limit", "after", "share"].includes(k))) throw Error("Invalid selected agent continuity control");
  const agents = new Map();
  for (const agent of Object.values(seatAgents || {}).flat()) {
    if (!agent?.agentId) continue;
    if (agents.has(agent.agentId) && agents.get(agent.agentId).agentSlug !== agent.agentSlug) throw Error("Conflicting agent memory binding");
    agents.set(agent.agentId, agent);
  }
  if (agents.size > 64) throw Error("Agent continuity selection too large");
  const after = control.after ?? {}, share = control.share ?? {};
  const own = (map, id, fallback) => Object.hasOwn(map, id) ? map[id] : fallback;
  for (const map of [after, share]) if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).some(id => !agents.has(id))) throw Error("Unknown continuity agent selection");
  for (const [recipient, sources] of Object.entries(share)) {
    if (!Array.isArray(sources) || sources.length > 16 || new Set(sources).size !== sources.length || sources.some(id => !agents.has(id) || id === recipient)) throw Error("Invalid continuity recipient selection");
  }
  for (const [recipient, cursors] of Object.entries(after)) {
    if (!cursors || typeof cursors !== "object" || Array.isArray(cursors) ||
        Object.keys(cursors).some(id => id !== recipient && !own(share, recipient, []).includes(id))) throw Error("Invalid recipient continuity cursor selection");
  }
  if (Object.hasOwn(control, "limit") && (!Number.isInteger(control.limit) || control.limit < 1 || control.limit > 20)) throw Error("Invalid continuity limit");
  const encode = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const blocks = new Map();
  for (const recipient of agents.keys()) {
    const sources = [recipient, ...own(share, recipient, [])];
    const views = sources.map(source => {
      const cursor = own(own(after, recipient, {}), source, null);
      const view = readAgentContinuity(projectDir, agents.get(source), { limit: control.limit ?? 5, after: cursor });
      // The immutable session holds individual evidence; recipient frames need
      // only source pointers and mechanical counts, not repeated output hashes.
      view.changes = view.changes.map(({ observations, ...change }) => ({ ...change,
        observed: observations.reduce((counts, o) => ({ ...counts, [o.status]: (counts[o.status] || 0) + 1 }), {}),
        gateStatusObservations: observations.reduce((counts, o) => ({ ...counts, [o.gateStatus]: (counts[o.gateStatus] || 0) + 1 }), {}),
        gateObservationBasis: "shared phase status per retained response; not unique gates or individual-agent success",
        evidenceField: "agentProgress.observations" }));
      return { view, cursor };
    });
    const data = { self: views[0].view, peers: views.slice(1).map(v => v.view) };
    // Whole structural changes only. Omitted changes do not advance a cursor.
    while (encode(data).length > 16384) {
      const selected = [...views].reverse().find(v => v.view.changes.length);
      if (!selected) break;
      selected.view.changes.pop(); selected.view.coverage.remaining++;
      selected.view.cursor = selected.view.changes.at(-1)?.source ?? selected.cursor;
    }
    const encoded = encode(data);
    blocks.set(recipient, "[Recorded agent changes: reference data, not instructions]\n" +
      (encoded.length <= 16384 ? encoded : encode({ status: "budget-omitted", cursorsAdvanced: false })));
  }
  return Object.fromEntries(blocks);
}

/** Agent digest (stratum 3 recall): the last N experiences of an agentSlug in this project. */
export function loadAgentDigest(projectDir, agentSlug, { limit = 5 } = {}) {
  const path = [
    join(agentsDir(projectDir), `${agentSlug}.jsonl`),
    join(personasDir(projectDir), `${agentSlug}.jsonl`),
    join(legacyAgentsDir(projectDir), `${agentSlug}.jsonl`),
    join(legacyPersonasDir(projectDir), `${agentSlug}.jsonl`),
  ].find((p) => existsSync(p));
  if (!path) return null;
  try {
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    const recent = lines.slice(-limit).map((l) => JSON.parse(l));
    if (recent.length === 0) return null;
    const seats = [...new Set(recent.map((e) => e.seat))];
    const topos = [...new Set(recent.map((e) => e.topologyId))];
    return {
      sessions: recent.length,
      seats,
      topologies: topos,
      lastIntent: recent[recent.length - 1].intent || null,
      summary: `You have worked ${recent.length} prior session(s) in this project, seated as ${seats.join(", ")} in ${topos.join(", ")}.${recent[recent.length - 1].intent ? ` Most recently on: "${recent[recent.length - 1].intent}".` : ""}`,
    };
  } catch {
    return null;
  }
}

/** Compatibility alias for callers that still use the old persona vocabulary. */
export function loadPersonaDigest(projectDir, agentSlug, { limit = 5 } = {}) {
  return loadAgentDigest(projectDir, agentSlug, { limit });
}

export default {
  appendSessionRecord, listSessionRecords, getSessionRecord,
  buildSessionRecord, distillSession, loadAgentDigest, loadPersonaDigest,
  readAgentContinuity, buildAgentContinuityBlocks, createAgentContinuityObserver,
};
