/**
 * illuci — Session Store (SQLite)
 *
 * Persistent session storage for the Electron IDE.
 * Sessions survive app restart, are nameable, pinnable,
 * and optionally bound to a project workspace.
 *
 * Schema:
 *   sessions       — metadata (name, topology, lineup, pinned, project, timestamps)
 *   session_events — raw topology events per session (append-only)
 *
 * Uses better-sqlite3 (synchronous, already a project dependency).
 */

import { openDatabase, enableWalMode } from "../storage/sqlite-driver.js";
import { mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { consolidationEnabled, storeDbPath, ingestLegacy } from "../datastore/consolidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "../../data/sessions.db");
const STORE_ID = "sessions";
const STORE_TABLES = ["sessions", "session_events"];

let db = null;

// ─── INIT ───

function getDB() {
  if (db) return db;

  const legacyPath = process.env.ILLUCI_SESSION_DB || DEFAULT_DB_PATH;
  const consolidated = consolidationEnabled();
  const dbPath = storeDbPath(legacyPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  db = openDatabase(dbPath);
  enableWalMode(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL DEFAULT 'Untitled',
      topology_id   TEXT,
      lineup        TEXT,
      prompt        TEXT,
      trace         TEXT,
      pinned        INTEGER NOT NULL DEFAULT 0,
      project_path  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expired       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned);
  `);

  if (consolidated) ingestLegacy(db, { storeId: STORE_ID, legacyPath, tables: STORE_TABLES });

  return db;
}

// ─── SESSION CRUD ───

/**
 * Create a new session.
 * @returns {object} The created session
 */
export function createSession(params = {}) {
  const d = getDB();
  const id = params.id || `illuci-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  d.prepare(`
    INSERT INTO sessions (id, name, topology_id, lineup, prompt, pinned, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.name || "Untitled",
    params.topologyId || null,
    params.lineup ? JSON.stringify(params.lineup) : null,
    params.prompt || null,
    params.pinned ? 1 : 0,
    params.projectPath || null,
  );

  return getSession(id);
}

/**
 * Get a session by ID.
 */
export function getSession(id) {
  const row = getDB().prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  return row ? deserializeSession(row) : null;
}

/**
 * List all non-expired sessions, newest first.
 * @param {object} options
 * @param {string} options.projectPath — filter by project
 * @param {boolean} options.pinnedOnly — only pinned sessions
 * @param {number} options.limit
 */
export function listSessions(options = {}) {
  const d = getDB();
  let sql = "SELECT * FROM sessions WHERE expired = 0";
  const params = [];

  if (options.projectPath) {
    sql += " AND (project_path = ? OR project_path IS NULL)";
    params.push(options.projectPath);
  }

  if (options.pinnedOnly) {
    sql += " AND pinned = 1";
  }

  sql += " ORDER BY modified_at DESC";

  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  return d.prepare(sql).all(...params).map(deserializeSession);
}

/**
 * Update a session.
 */
export function updateSession(id, updates) {
  const d = getDB();
  const fields = [];
  const values = [];

  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.topologyId !== undefined) { fields.push("topology_id = ?"); values.push(updates.topologyId); }
  if (updates.lineup !== undefined) { fields.push("lineup = ?"); values.push(JSON.stringify(updates.lineup)); }
  if (updates.prompt !== undefined) { fields.push("prompt = ?"); values.push(updates.prompt); }
  if (updates.trace !== undefined) { fields.push("trace = ?"); values.push(JSON.stringify(updates.trace)); }
  if (updates.pinned !== undefined) { fields.push("pinned = ?"); values.push(updates.pinned ? 1 : 0); }
  if (updates.projectPath !== undefined) { fields.push("project_path = ?"); values.push(updates.projectPath); }

  if (fields.length === 0) return getSession(id);

  fields.push("modified_at = datetime('now')");
  values.push(id);

  d.prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

/**
 * Delete a session and its events.
 */
export function deleteSession(id) {
  getDB().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Pin/unpin a session.
 */
export function pinSession(id, pinned = true) {
  return updateSession(id, { pinned });
}

// ─── SESSION EVENTS ───

/**
 * Append an event to a session.
 */
export function addEvent(sessionId, eventType, payload) {
  getDB().prepare(`
    INSERT INTO session_events (session_id, event_type, payload)
    VALUES (?, ?, ?)
  `).run(sessionId, eventType, JSON.stringify(payload));

  // Touch modified_at
  getDB().prepare("UPDATE sessions SET modified_at = datetime('now') WHERE id = ?").run(sessionId);
}

/**
 * Batch append events (for replaying a topology trace).
 */
export function addEvents(sessionId, events) {
  const d = getDB();
  const insert = d.prepare(`
    INSERT INTO session_events (session_id, event_type, payload, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const batch = d.transaction((evts) => {
    for (const evt of evts) {
      insert.run(
        sessionId,
        evt.type || evt.event_type || "unknown",
        JSON.stringify(evt.payload || evt),
        evt.timestamp || new Date().toISOString(),
      );
    }
  });

  batch(events);
  d.prepare("UPDATE sessions SET modified_at = datetime('now') WHERE id = ?").run(sessionId);
}

/**
 * Get all events for a session.
 */
export function getEvents(sessionId, options = {}) {
  let sql = "SELECT * FROM session_events WHERE session_id = ? ORDER BY id ASC";
  const params = [sessionId];

  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  if (options.afterId) {
    sql = "SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id ASC";
    params.splice(1, 0, options.afterId);
  }

  return getDB().prepare(sql).all(...params).map(row => ({
    id: row.id,
    sessionId: row.session_id,
    type: row.event_type,
    payload: tryParse(row.payload),
    timestamp: row.timestamp,
  }));
}

/**
 * Get event count for a session.
 */
export function getEventCount(sessionId) {
  const row = getDB().prepare("SELECT COUNT(*) as count FROM session_events WHERE session_id = ?").get(sessionId);
  return row?.count || 0;
}

// ─── EXPIRATION ───

/**
 * Expire unpinned sessions older than `days`.
 */
export function expireOldSessions(days = 7) {
  const d = getDB();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = d.prepare(`
    UPDATE sessions SET expired = 1
    WHERE pinned = 0 AND modified_at < ? AND expired = 0
  `).run(cutoff);
  return result.changes;
}

/**
 * Permanently delete expired sessions and their events.
 */
export function purgeExpired() {
  const d = getDB();
  const result = d.prepare("DELETE FROM sessions WHERE expired = 1").run();
  return result.changes;
}

// ─── STATS ───

export function stats() {
  const d = getDB();
  const total = d.prepare("SELECT COUNT(*) as c FROM sessions WHERE expired = 0").get().c;
  const pinned = d.prepare("SELECT COUNT(*) as c FROM sessions WHERE pinned = 1 AND expired = 0").get().c;
  const events = d.prepare("SELECT COUNT(*) as c FROM session_events").get().c;
  return { total, pinned, events };
}

// ─── CLOSE ───

export function close() {
  if (db) { db.close(); db = null; }
}

// ─── HELPERS ───

function deserializeSession(row) {
  return {
    id: row.id,
    name: row.name,
    topologyId: row.topology_id,
    lineup: tryParse(row.lineup),
    prompt: row.prompt,
    trace: tryParse(row.trace),
    pinned: !!row.pinned,
    projectPath: row.project_path,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    expired: !!row.expired,
  };
}

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

export default {
  createSession, getSession, listSessions, updateSession,
  deleteSession, pinSession, addEvent, addEvents, getEvents,
  getEventCount, expireOldSessions, purgeExpired, stats, close,
};
