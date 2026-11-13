/**
 * illuci datastore — the canonical record envelope: `illuci.datastore.record.v1`.
 *
 * A strict SUPERSET of `illuci.observation.v1` (core/data/observations.js): the same
 * lineage keys, plus `companyId` (the company-bus key the observation envelope
 * lacked) and the OpenTelemetry GenAI span fields. Because it is a superset, an
 * existing observation normalizes into a record unchanged (back-compat by
 * construction). The trunk row is a flat projection of the envelope; the JSON
 * columns (tags / payload / metadata) carry the source-of-truth body, the scalar
 * columns are the indexed WHERE surface.
 */
import { randomUUID } from "node:crypto";

export const RECORD_SCHEMA_VERSION = "illuci.datastore.record.v1";

// Lineage keys carried verbatim from illuci.observation.v1.
const LINEAGE_KEYS = [
  "runId", "sessionId", "projectId", "topologyId", "pipelineId",
  "phaseId", "stageId", "seatId", "modelId", "artifactId", "gateId", "userId",
];

// OpenTelemetry GenAI span fields promoted to columns for query.
const OTEL_KEYS = [
  "spanKind", "traceId", "spanId", "parentSpanId",
  "genAiSystem", "genAiOperation", "inputTokens", "outputTokens", "latencyMs",
];

export function normalizeRecord(input = {}) {
  const out = {
    id: input.id || `rec-${Date.now()}-${randomUUID().slice(0, 8)}`,
    schemaVersion: input.schemaVersion || RECORD_SCHEMA_VERSION,
    ts: input.ts || input.timestamp || new Date().toISOString(),
    kind: input.kind || "datastore",
    type: input.type || "record",
    source: input.source || "illuci",
    companyId: input.companyId || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    payload: input.payload === undefined ? null : input.payload,
    metadata: input.metadata === undefined ? null : input.metadata,
  };
  for (const k of LINEAGE_KEYS) out[k] = input[k] ?? null;
  for (const k of OTEL_KEYS) out[k] = input[k] ?? null;
  return out;
}

const tryParse = (s) => {
  if (s === null || s === undefined) return null;
  try { return JSON.parse(s); } catch { return s; }
};

const dumpJson = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/** Envelope → flat SQLite row (snake_case columns; JSON columns stringified). */
export function toRow(rec) {
  return {
    id: rec.id,
    schema_version: rec.schemaVersion,
    ts: rec.ts,
    kind: rec.kind,
    type: rec.type,
    source: rec.source,
    run_id: rec.runId, session_id: rec.sessionId, project_id: rec.projectId,
    topology_id: rec.topologyId, pipeline_id: rec.pipelineId, phase_id: rec.phaseId,
    stage_id: rec.stageId, seat_id: rec.seatId, model_id: rec.modelId,
    artifact_id: rec.artifactId, gate_id: rec.gateId, user_id: rec.userId,
    company_id: rec.companyId,
    span_kind: rec.spanKind, trace_id: rec.traceId, span_id: rec.spanId, parent_span_id: rec.parentSpanId,
    gen_ai_system: rec.genAiSystem, gen_ai_operation: rec.genAiOperation,
    input_tokens: rec.inputTokens, output_tokens: rec.outputTokens, latency_ms: rec.latencyMs,
    tags: JSON.stringify(rec.tags || []),
    payload: dumpJson(rec.payload),
    metadata: dumpJson(rec.metadata),
  };
}

/** Flat SQLite row → envelope (inverse of toRow). Preserves `seq` when present. */
export function fromRow(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    id: row.id,
    schemaVersion: row.schema_version,
    ts: row.ts,
    kind: row.kind,
    type: row.type,
    source: row.source,
    runId: row.run_id, sessionId: row.session_id, projectId: row.project_id,
    topologyId: row.topology_id, pipelineId: row.pipeline_id, phaseId: row.phase_id,
    stageId: row.stage_id, seatId: row.seat_id, modelId: row.model_id,
    artifactId: row.artifact_id, gateId: row.gate_id, userId: row.user_id,
    companyId: row.company_id,
    spanKind: row.span_kind, traceId: row.trace_id, spanId: row.span_id, parentSpanId: row.parent_span_id,
    genAiSystem: row.gen_ai_system, genAiOperation: row.gen_ai_operation,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, latencyMs: row.latency_ms,
    tags: tryParse(row.tags) || [],
    payload: tryParse(row.payload),
    metadata: tryParse(row.metadata),
  };
}

export default { RECORD_SCHEMA_VERSION, normalizeRecord, toRow, fromRow };
