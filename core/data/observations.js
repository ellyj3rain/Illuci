import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureRuntimeDataPath, runtimeDataPath, DATA_KINDS } from "./paths.js";

const DEFAULT_FILE = "observations.jsonl";
const SCHEMA_VERSION = "illuci.observation.v1";

export function observationPath(kind, fileName = DEFAULT_FILE) {
  return runtimeDataPath(kind, fileName);
}

function ensureObservationPath(kind, fileName = DEFAULT_FILE) {
  const path = ensureRuntimeDataPath(kind, fileName);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function normalizeObservation(kind, observation = {}) {
  if (!DATA_KINDS[kind]) throw new Error(`unknown illuci data kind: ${kind || "(missing)"}`);
  const payload = observation.payload === undefined ? null : observation.payload;
  const timestamp = observation.timestamp || new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: observation.id || `obs-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    kind,
    type: observation.type || "observation",
    source: observation.source || "illuci",
    runId: observation.runId || null,
    sessionId: observation.sessionId || null,
    projectId: observation.projectId || null,
    topologyId: observation.topologyId || null,
    pipelineId: observation.pipelineId || null,
    phaseId: observation.phaseId || null,
    stageId: observation.stageId || null,
    seatId: observation.seatId || null,
    modelId: observation.modelId || null,
    artifactId: observation.artifactId || null,
    gateId: observation.gateId || null,
    userId: observation.userId || null,
    tags: Array.isArray(observation.tags) ? observation.tags : [],
    payload,
    metadata: observation.metadata || null,
  };
}

export function recordObservation(kind, observation = {}, options = {}) {
  const fileName = options.fileName || DEFAULT_FILE;
  const record = normalizeObservation(kind, observation);
  appendFileSync(ensureObservationPath(kind, fileName), JSON.stringify(record) + "\n", "utf-8");
  return record;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function readObservations(kind, filter = {}, options = {}) {
  const fileName = options.fileName || DEFAULT_FILE;
  let records = readJsonl(observationPath(kind, fileName));
  if (filter.type) records = records.filter((record) => record.type === filter.type);
  if (filter.runId) records = records.filter((record) => record.runId === filter.runId);
  if (filter.sessionId) records = records.filter((record) => record.sessionId === filter.sessionId);
  if (filter.projectId) records = records.filter((record) => record.projectId === filter.projectId);
  if (filter.topologyId) records = records.filter((record) => record.topologyId === filter.topologyId);
  if (filter.modelId) records = records.filter((record) => record.modelId === filter.modelId);
  if (filter.since) {
    const since = new Date(filter.since).getTime();
    records = records.filter((record) => new Date(record.timestamp).getTime() >= since);
  }
  if (filter.until) {
    const until = new Date(filter.until).getTime();
    records = records.filter((record) => new Date(record.timestamp).getTime() <= until);
  }
  if (filter.limit) records = records.slice(-Number(filter.limit));
  return records;
}

export default {
  observationPath,
  normalizeObservation,
  recordObservation,
  readObservations,
};
