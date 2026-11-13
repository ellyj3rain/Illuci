/**
 * illuci datastore — per-lane adapter contract + shared helpers ([A19] Phase 1).
 *
 * The universal lane indexer (lane-index.js) folds every .illuci/data lane into the
 * trunk for query. Each lane provides an ADAPTER that (a) enumerates its physical
 * source files and (b) maps one source row into a `illuci.datastore.record.v1` object.
 * The adapter does NO SQL and NO fs — the indexer reads files (format-aware) and
 * calls trunk.append (which normalizes + INSERT OR IGNORE). Idempotency is by record
 * id, so re-indexing is free.
 *
 * Adapter shape:
 *   {
 *     lane:      string,                       // logical lane id (unique)
 *     kind:      string,                       // -> record.kind (the indexed WHERE surface)
 *     authority: "operational" | "file-canonical",
 *     source:    string,                       // provenance stamp
 *     sources(ctx): Array<{ path, format: "jsonl" | "json" | "json-array" | "text" }>,
 *     toRecord(raw, srcCtx): Record | null,    // null = skip this row
 *   }
 *
 * File-canonical lanes (decisions/governance/memory — AM-23/DR-004) are projected
 * READ-ONLY: the indexer appends them directly to the trunk (bypassing the
 * record-writer guard, which governs only the WRITE path), and markFileCanonical
 * stamps them so the projection is auditable and never mistaken for a writable row.
 */
import { createHash } from "node:crypto";

const LINEAGE_KEYS = [
  "runId", "sessionId", "projectId", "topologyId", "pipelineId", "phaseId",
  "stageId", "seatId", "modelId", "artifactId", "gateId", "userId", "companyId",
];
const OTEL_KEYS = [
  "spanKind", "traceId", "spanId", "parentSpanId",
  "genAiSystem", "genAiOperation", "inputTokens", "outputTokens", "latencyMs",
];

/**
 * Copy lineage + OpenTelemetry keys from a raw lane row into trunk-envelope shape.
 * Checks the top level first, then a nested `subject` (the illuci.X.record/1 family
 * nests lineage under subject). Omits null/undefined so normalizeRecord defaults apply.
 */
export function pickLineage(raw = {}) {
  const subject = raw && typeof raw.subject === "object" && raw.subject ? raw.subject : {};
  const out = {};
  for (const k of [...LINEAGE_KEYS, ...OTEL_KEYS]) {
    const v = raw[k] ?? subject[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Best-effort timestamp across the many lane envelope shapes. */
export function tsOf(raw = {}) {
  return raw.ts || raw.timestamp || raw.recordedAt || raw.startedAt || raw.t || null;
}

/**
 * Deterministic id for sources whose rows lack one (e.g. raw-text `runs`). A hash of
 * the parts — NEVER Date.now()/random — so re-indexing the same line is idempotent.
 */
export function stableId(prefix, ...parts) {
  const digest = createHash("sha1")
    .update(parts.map((p) => String(p ?? "")).join("\0"))
    .digest("hex");
  return `${prefix}-${digest.slice(0, 16)}`;
}

/**
 * Stamp a record as a READ-ONLY projection of a file-canonical lane. The files stay
 * the authority (AM-23/DR-004); the trunk row is a queryable mirror, marked as such.
 */
export function markFileCanonical(rec) {
  rec.source = "file-canonical";
  const meta = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
  rec.metadata = { ...meta, _authority: "file-canonical", _projection: "read-only" };
  return rec;
}

export default { pickLineage, tsOf, stableId, markFileCanonical };
