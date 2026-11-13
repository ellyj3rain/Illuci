/**
 * illuci datastore — the event-sourced TRUNK.
 *
 * One append-only `records` table is the system-of-record for run/company output
 * and (via consolidation) the unified runtime data. INSERT-only (no UPDATE/DELETE);
 * corrections append a superseding record (`payload.supersedes`). `seq` is the
 * global monotonic log order; `id` is UNIQUE so re-ingest is idempotent
 * (`INSERT OR IGNORE`, first write wins). Reads fold the log by lineage key.
 *
 * Mirrors OTL orchestrator-core's events+fold discipline and the in-repo
 * context/store.js inline-schema + `_migrations` idiom. Concrete on the injected
 * sqlite-driver handle — the medium is locked to SQLite, so there is no extra
 * "trunk medium" abstraction.
 */
import { normalizeRecord, toRow, fromRow } from "./record.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  kind           TEXT NOT NULL,
  type           TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'illuci',
  run_id TEXT, session_id TEXT, project_id TEXT, topology_id TEXT, pipeline_id TEXT,
  phase_id TEXT, stage_id TEXT, seat_id TEXT, model_id TEXT, artifact_id TEXT, gate_id TEXT, user_id TEXT,
  company_id TEXT,
  span_kind TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT,
  gen_ai_system TEXT, gen_ai_operation TEXT,
  input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER,
  tags TEXT, payload TEXT, metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_run       ON records(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_company   ON records(company_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_session   ON records(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_project   ON records(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_kind_type ON records(kind, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_topology  ON records(topology_id);
CREATE INDEX IF NOT EXISTS idx_records_model     ON records(model_id);
CREATE INDEX IF NOT EXISTS idx_records_trace     ON records(trace_id, span_id);
CREATE INDEX IF NOT EXISTS idx_records_ts        ON records(ts);

CREATE TABLE IF NOT EXISTS projection_offsets (
  projection TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Insert column order. payload is source-of-truth; scalar columns are the WHERE surface.
const INSERT_COLUMNS = [
  "id", "schema_version", "ts", "kind", "type", "source",
  "run_id", "session_id", "project_id", "topology_id", "pipeline_id",
  "phase_id", "stage_id", "seat_id", "model_id", "artifact_id", "gate_id", "user_id",
  "company_id",
  "span_kind", "trace_id", "span_id", "parent_span_id",
  "gen_ai_system", "gen_ai_operation", "input_tokens", "output_tokens", "latency_ms",
  "tags", "payload", "metadata",
];

// Filterable scalar columns → envelope key. Null/undefined filter values are ignored.
const FILTERABLE = [
  ["run_id", "runId"], ["company_id", "companyId"], ["session_id", "sessionId"],
  ["project_id", "projectId"], ["topology_id", "topologyId"], ["model_id", "modelId"],
  ["kind", "kind"], ["type", "type"],
];

// Additive, ordered, run-once migrations (v1 is the base SCHEMA above).
const MIGRATIONS = [];

function runMigrations(driver) {
  driver.prepare(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)"
  ).run();
  const applied = new Set(driver.prepare("SELECT version FROM _migrations").all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    m.up(driver);
    driver.prepare("INSERT INTO _migrations VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
  }
}

/**
 * Build the trunk over an open sqlite-driver handle (openDatabase). Runs the
 * schema + migrations, returns the append/fold surface.
 */
export function openTrunk(driver) {
  driver.exec(SCHEMA);
  runMigrations(driver);

  const placeholders = INSERT_COLUMNS.map(() => "?").join(", ");
  const insertStmt = driver.prepare(
    `INSERT OR IGNORE INTO records (${INSERT_COLUMNS.join(", ")}) VALUES (${placeholders})`
  );

  /** Append one record (normalized). Returns its id. Idempotent on id. */
  function append(input) {
    const rec = normalizeRecord(input);
    const row = toRow(rec);
    insertStmt.run(...INSERT_COLUMNS.map((c) => row[c] ?? null));
    return rec.id;
  }

  /** Append many in one transaction (atomic per batch). Returns ids. */
  function appendMany(inputs) {
    const ids = [];
    driver.transaction((items) => {
      for (const it of items) ids.push(append(it));
    })(inputs);
    return ids;
  }

  /** Fold the log by lineage filter, in append (seq) order. */
  function records(filter = {}) {
    const where = [];
    const params = [];
    for (const [col, key] of FILTERABLE) {
      if (filter[key] !== undefined && filter[key] !== null) {
        where.push(`${col} = ?`);
        params.push(filter[key]);
      }
    }
    let sql = "SELECT * FROM records";
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY seq";
    if (filter.limit) { sql += " LIMIT ?"; params.push(Number(filter.limit)); }
    return driver.prepare(sql).all(...params).map(fromRow);
  }

  const byRun = (runId) => records({ runId });
  const byCompany = (companyId) => records({ companyId });
  const latestSeq = () => driver.prepare("SELECT MAX(seq) AS s FROM records").get()?.s ?? 0;
  const count = () => driver.prepare("SELECT COUNT(*) AS c FROM records").get()?.c ?? 0;

  // Incremental read for projection catch-up: records with seq strictly greater than `seq`.
  function since(seq, limit) {
    let sql = "SELECT * FROM records WHERE seq > ? ORDER BY seq";
    const params = [Number(seq) || 0];
    if (limit) { sql += " LIMIT ?"; params.push(Number(limit)); }
    return driver.prepare(sql).all(...params).map(fromRow);
  }
  // Per-projection high-water mark — lets a projection catch up (or rebuild) from the trunk.
  const getOffset = (projection) =>
    Number(driver.prepare("SELECT last_seq FROM projection_offsets WHERE projection = ?").get(projection)?.last_seq ?? 0);
  const setOffset = (projection, seq) =>
    driver.prepare(
      "INSERT INTO projection_offsets(projection, last_seq, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(projection) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at"
    ).run(projection, Number(seq));

  return { append, appendMany, records, byRun, byCompany, since, getOffset, setOffset, latestSeq, count, driver };
}

export default { openTrunk };
