// Telemetry has two sinks: a dependency-free JSONL observation stream that is
// always available, and an optional SQLite index when better-sqlite3 is present.
// The JSONL stream is the durable intake path; SQLite is a query accelerator.
import { createRequire } from "module";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { recordObservation, readObservations } from "../data/observations.js";
import { runtimeDataPath } from "../data/paths.js";
import { openDatabase, enableWalMode } from "../storage/sqlite-driver.js";
import { consolidationEnabled, storeDbPath, ingestLegacy } from "../datastore/consolidation.js";

const require = createRequire(import.meta.url);
const TELEMETRY_EVENTS_FILE = "events.jsonl";
const STORE_ID = "telemetry";
const STORE_TABLES = ["telemetry_events"];
const TELEMETRY_SCHEMA = `
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL,
      session_id    TEXT,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      event_type    TEXT NOT NULL,
      project_id    TEXT,
      topology_id   TEXT,
      phase_id      TEXT,
      seat_id       TEXT,
      model_id      TEXT,
      artifact_id   TEXT,
      gate_id       TEXT,
      user_id       TEXT,
      payload       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_run_id ON telemetry_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON telemetry_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_telemetry_project_id ON telemetry_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_model_id ON telemetry_events(model_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_id ON telemetry_events(user_id);
  `;

let db = null;
let unavailable = false;
let warnedUnavailable = false;

export function telemetryDbPath() {
  return process.env.ILLUCI_CONTEXT_DB || runtimeDataPath("telemetry", "context.db");
}

function sqliteDisabled() {
  const flag = String(process.env.ILLUCI_TELEMETRY_SQLITE || "").toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

function getDB() {
  if (sqliteDisabled()) return null;
  if (db) return db;
  if (unavailable) return null;

  const consolidated = consolidationEnabled();
  const legacyPath = telemetryDbPath();

  // ── [A16.6] CONSOLIDATED: share the trunk through the facade. node:sqlite is built
  // in (always available) and telemetry uses only prepare/run/all/exec/pragma, so this
  // is a uniform-driver reroute with no better-sqlite3 dependency or mixed-driver risk. ──
  if (consolidated) {
    const dbPath = storeDbPath(legacyPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    db = openDatabase(dbPath);
    enableWalMode(db);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(TELEMETRY_SCHEMA);
    ingestLegacy(db, { storeId: STORE_ID, legacyPath, tables: STORE_TABLES });
    return db;
  }

  // ── LEGACY (byte-identical): raw better-sqlite3, graceful JSONL-only degrade ──
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    unavailable = true;
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[telemetry] better-sqlite3 unavailable - SQLite index disabled; telemetry still records JSONL observations. Root cause: ${err.message}`
      );
    }
    return null;
  }

  const dbPath = legacyPath;
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  enableWalMode(db);
  db.pragma("foreign_keys = ON");

  db.exec(TELEMETRY_SCHEMA);

  return db;
}

function normalizeEvent(event = {}) {
  return {
    run_id: event.run_id || `untracked-${Date.now()}`,
    session_id: event.session_id || null,
    timestamp: event.timestamp || new Date().toISOString(),
    event_type: event.event_type || event.type || "unknown",
    project_id: event.project_id || null,
    topology_id: event.topology_id || null,
    phase_id: event.phase_id || null,
    seat_id: event.seat_id || null,
    model_id: event.model_id || null,
    artifact_id: event.artifact_id || null,
    gate_id: event.gate_id || null,
    user_id: event.user_id || null,
    payload: event.payload || null,
  };
}

function recordTelemetryObservation(event) {
  try {
    recordObservation("telemetry", {
      timestamp: event.timestamp,
      type: event.event_type,
      source: "telemetry-store",
      runId: event.run_id,
      sessionId: event.session_id,
      projectId: event.project_id,
      topologyId: event.topology_id,
      phaseId: event.phase_id,
      seatId: event.seat_id,
      modelId: event.model_id,
      artifactId: event.artifact_id,
      gateId: event.gate_id,
      userId: event.user_id,
      tags: ["telemetry", event.event_type].filter(Boolean),
      payload: event,
    }, { fileName: TELEMETRY_EVENTS_FILE });
  } catch {
    // Telemetry must never block dispatch.
  }
}

/**
 * Records a telemetry event. JSONL intake is always attempted; SQLite indexing
 * is optional and may be disabled with ILLUCI_TELEMETRY_SQLITE=0.
 */
export function recordEvent(event) {
  const normalized = normalizeEvent(event);
  recordTelemetryObservation(normalized);

  const d = getDB();
  if (!d) return;
  // SQLite indexing is best-effort; the JSONL observation above is the durable record.
  // A driver/binder error here (e.g. a better-sqlite3 "Too few parameter values" RangeError
  // on a drifted statement) must never propagate and crash a dispatch — telemetry is advisory.
  try {
    const stmt = d.prepare(`
      INSERT INTO telemetry_events (
        run_id, session_id, timestamp, event_type, project_id, topology_id,
        phase_id, seat_id, model_id, artifact_id, gate_id, user_id, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      normalized.run_id,
      normalized.session_id,
      normalized.timestamp,
      normalized.event_type,
      normalized.project_id,
      normalized.topology_id,
      normalized.phase_id,
      normalized.seat_id,
      normalized.model_id,
      normalized.artifact_id,
      normalized.gate_id,
      normalized.user_id,
      JSON.stringify(normalized.payload)
    );
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(`[telemetry] SQLite index write skipped (${err.message}); JSONL observation retained.`);
    }
  }
}

function matches(row, filters = {}) {
  if (filters.run_id && row.run_id !== filters.run_id) return false;
  if (filters.event_type && row.event_type !== filters.event_type) return false;
  if (filters.project_id && row.project_id !== filters.project_id) return false;
  if (filters.model_id && row.model_id !== filters.model_id) return false;
  if (filters.user_id && row.user_id !== filters.user_id) return false;
  if (filters.since && new Date(row.timestamp).getTime() < new Date(filters.since).getTime()) return false;
  if (filters.until && new Date(row.timestamp).getTime() > new Date(filters.until).getTime()) return false;
  return true;
}

function getFallbackEvents(filters = {}) {
  let rows = readObservations("telemetry", {}, { fileName: TELEMETRY_EVENTS_FILE })
    .map((record) => record.payload)
    .filter((row) => row && matches(row, filters));

  const dir = filters.order === "ASC" ? 1 : -1;
  rows = rows.sort((a, b) => dir * (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()));
  if (filters.limit) rows = rows.slice(0, Number(filters.limit));
  return rows;
}

/**
 * Retrieves telemetry events based on provided filters.
 */
export function getEvents(filters = {}) {
  const d = getDB();
  if (!d) return getFallbackEvents(filters);
  let sql = "SELECT * FROM telemetry_events WHERE 1=1";
  const params = [];

  if (filters.run_id) { sql += " AND run_id = ?"; params.push(filters.run_id); }
  if (filters.event_type) { sql += " AND event_type = ?"; params.push(filters.event_type); }
  if (filters.project_id) { sql += " AND project_id = ?"; params.push(filters.project_id); }
  if (filters.model_id) { sql += " AND model_id = ?"; params.push(filters.model_id); }
  if (filters.user_id) { sql += " AND user_id = ?"; params.push(filters.user_id); }
  if (filters.since) { sql += " AND timestamp >= ?"; params.push(filters.since); }
  if (filters.until) { sql += " AND timestamp <= ?"; params.push(filters.until); }

  const orderBy = filters.orderBy || "timestamp";
  sql += ` ORDER BY ${orderBy} ${filters.order === "ASC" ? "ASC" : "DESC"}`;

  if (filters.limit) { sql += " LIMIT ?"; params.push(filters.limit); }

  const rows = d.prepare(sql).all(...params);
  return rows.map(row => ({
    ...row,
    payload: JSON.parse(row.payload),
  }));
}

/**
 * Cleans up old SQLite telemetry events. JSONL observations are append-only.
 */
export function cleanupEvents(daysToRetain) {
  const d = getDB();
  if (!d) return 0;
  const cutoffDate = new Date(Date.now() - daysToRetain * 24 * 60 * 60 * 1000).toISOString();
  const result = d.prepare(
    "DELETE FROM telemetry_events WHERE timestamp < ?"
  ).run(cutoffDate);
  return result.changes;
}

export function close() {
  if (db) { db.close(); db = null; }
}

export default {
  recordEvent,
  getEvents,
  cleanupEvents,
  close,
  telemetryDbPath,
};
