/**
 * illuci — Context Store
 *
 * The persistent, structured, shared memory of the platform.
 * Context is project-scoped. Projects are the top-level organizational
 * unit — everything exists within a project.
 *
 * Models are platform residents. They don't go back to their providers
 * for anything except compute. Their identity, context, workspace,
 * tools, permissions — all owned by ILLUCI. The provider is a compute
 * backend, nothing else.
 *
 * The context store IS the project's repository — the workspace where
 * models live and work. Backed by whatever storage the project uses:
 * local filesystem, git, cloud, private server.
 *
 * Structure:
 *   artifacts  — named, typed, versioned objects (code, designs, specs, reviews)
 *   messages   — conversation history within a project
 *   identity   — model perceptions, self-assessment, peer assessment
 *   snapshots  — compressed summaries for context window management
 *
 * Every write is attributed (who, when, why).
 * Every read is windowed (sized to the requesting model's context limit).
 *
 * Topologies, phases, sessions are metadata on writes — not structure.
 * The structure is: project → content. That's it.
 */

import { openDatabase, enableWalMode } from "../storage/sqlite-driver.js";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { estimateTokens as centralEstimate } from "./tokens.js";
import { consolidationEnabled, storeDbPath, migrationsTable, ingestLegacy } from "../datastore/consolidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, "../../data/context.db");
const STORE_ID = "context";
const STORE_TABLES = ["artifacts", "messages", "identity", "snapshots"];

let db = null;

// ─── INIT ───

function getDB() {
  if (db) return db;

  const legacyPath = process.env.ILLUCI_CONTEXT_DB || DEFAULT_DB_PATH;
  const consolidated = consolidationEnabled();
  const dbPath = storeDbPath(legacyPath);
  mkdirSync(dirname(dbPath), { recursive: true });

  db = openDatabase(dbPath);
  enableWalMode(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    -- ═══ ARTIFACTS ═══
    -- The things models produce and consume. Code, designs, specs,
    -- reviews, reports. Named, typed, versioned. The shared workspace.
    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      summary     TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      version     INTEGER NOT NULL DEFAULT 1,
      author      TEXT NOT NULL,
      metadata    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      modified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ MESSAGES ═══
    -- Conversation history. Every model utterance, operator directive,
    -- tool result, system event. The memory of what happened.
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      role        TEXT NOT NULL,
      model_id    TEXT,
      content     TEXT NOT NULL,
      summary     TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ IDENTITY ═══
    -- Model self-knowledge, peer perception, meta-perception.
    -- Global — not project-scoped. A model's identity persists
    -- across all projects. It's who they are.
    CREATE TABLE IF NOT EXISTS identity (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id  TEXT NOT NULL,
      observer_id TEXT NOT NULL,
      type        TEXT NOT NULL,
      content     TEXT NOT NULL,
      confidence  REAL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ SNAPSHOTS ═══
    -- Compressed summaries. When a project's message history exceeds
    -- a model's context window, older messages get compressed into
    -- snapshots. The model sees: snapshot + recent messages.
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      summary     TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      covers_from INTEGER NOT NULL,
      covers_to   INTEGER NOT NULL,
      created_by  TEXT NOT NULL DEFAULT 'system',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes — project_id is the primary access pattern
    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_name ON artifacts(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(project_id, model_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_identity_subject ON identity(subject_id);
    CREATE INDEX IF NOT EXISTS idx_identity_observer ON identity(observer_id);
    CREATE INDEX IF NOT EXISTS idx_identity_type ON identity(type);
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
  `);

  // ── MIGRATIONS ──
  runMigrations(db, migrationsTable(STORE_ID));

  // ── [A16.4] CONSOLIDATION: one-time ingest of legacy rows into the shared trunk ──
  if (consolidated) ingestLegacy(db, { storeId: STORE_ID, legacyPath, tables: STORE_TABLES });

  // ── STARTUP CLEANUP ──
  // Remove expired artifacts on every DB init
  try {
    const expired = db.prepare(
      "DELETE FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < ?"
    ).run(new Date().toISOString());
    if (expired.changes > 0) {
      console.error(`[Context] Cleaned ${expired.changes} expired artifact(s)`);
    }
  } catch {}

  return db;
}

function runMigrations(database, migTable = "_migrations") {
  database.prepare(`CREATE TABLE IF NOT EXISTS ${migTable} (
    version INTEGER PRIMARY KEY,
    name TEXT,
    applied_at TEXT
  )`).run();

  const applied = database.prepare(`SELECT version FROM ${migTable}`).all().map(r => r.version);

  const migrations = [
    {
      version: 1,
      name: "add_artifact_scope_and_expiry",
      up: () => {
        const columns = database.prepare("PRAGMA table_info(artifacts)").all();
        if (!columns.some(c => c.name === "scope")) {
          database.prepare('ALTER TABLE artifacts ADD COLUMN scope TEXT DEFAULT "project"').run();
          database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_scope ON artifacts(scope)").run();
        }
        if (!columns.some(c => c.name === "expires_at")) {
          database.prepare("ALTER TABLE artifacts ADD COLUMN expires_at TEXT").run();
          database.prepare("CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON artifacts(expires_at)").run();
        }
      },
    },
  ];

  for (const m of migrations) {
    if (!applied.includes(m.version)) {
      m.up();
      database.prepare(`INSERT INTO ${migTable} VALUES (?, ?, ?)`).run(
        m.version, m.name, new Date().toISOString()
      );
    }
  }
}

// ─── ARTIFACTS ───

/**
 * Write an artifact. If one with the same name exists in the project,
 * it's versioned up. Artifacts are the shared workspace — code, designs,
 * specs, reviews, anything a model produces for others to consume.
 *
 * @param {string} projectId
 * @param {object} artifact — { name, type, content, summary?, author, metadata? }
 */
export function writeArtifact(projectId, artifact) {
  const d = getDB();
  const id = artifact.id || `art-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tokenCount = artifact.tokenCount || estimateTokens(artifact.content);

  // Check for existing
  const existing = d.prepare(
    "SELECT id, version FROM artifacts WHERE project_id = ? AND name = ? ORDER BY version DESC LIMIT 1"
  ).get(projectId, artifact.name);

  const version = existing ? existing.version + 1 : 1;

  if (existing) {
    d.prepare(`
      UPDATE artifacts SET
        content = ?, summary = ?, token_count = ?, version = ?,
        author = ?, type = ?, metadata = ?, modified_at = datetime('now')
      WHERE id = ?
    `).run(
      artifact.content, artifact.summary || null, tokenCount, version,
      artifact.author, artifact.type, JSON.stringify(artifact.metadata || null),
      existing.id
    );
    return { id: existing.id, version, tokenCount };
  }

  d.prepare(`
    INSERT INTO artifacts (id, project_id, name, type, content, summary, token_count, version, author, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, projectId, artifact.name, artifact.type,
    artifact.content, artifact.summary || null, tokenCount, version,
    artifact.author, JSON.stringify(artifact.metadata || null)
  );

  return { id, version, tokenCount };
}

/**
 * Read the latest version of an artifact by name.
 */
export function readArtifact(projectId, name) {
  const row = getDB().prepare(
    "SELECT * FROM artifacts WHERE project_id = ? AND name = ? ORDER BY version DESC LIMIT 1"
  ).get(projectId, name);
  return row ? deserializeArtifact(row) : null;
}

/**
 * List artifacts in a project.
 */
export function listArtifacts(projectId, filters = {}) {
  const d = getDB();
  let sql = "SELECT * FROM artifacts WHERE project_id = ?";
  const params = [projectId];

  if (filters.type) { sql += " AND type = ?"; params.push(filters.type); }
  if (filters.author) { sql += " AND author = ?"; params.push(filters.author); }

  sql += " ORDER BY modified_at DESC";
  if (filters.limit) { sql += " LIMIT ?"; params.push(filters.limit); }

  return d.prepare(sql).all(...params).map(deserializeArtifact);
}

/**
 * Delete an artifact by its project ID and name.
 * @param {string} projectId
 * @param {string} name The name of the artifact to delete.
 */
export function deleteArtifact(projectId, name) {
  const d = getDB();
  d.prepare(
    "DELETE FROM artifacts WHERE project_id = ? AND name = ?"
  ).run(projectId, name);
}

// ─── MESSAGES ───

/**
 * Append a message. Every model utterance, operator directive, tool result,
 * system event. This is the persistent conversation history of the project.
 *
 * @param {string} projectId
 * @param {object} msg — { role, modelId?, content, summary?, metadata? }
 */
export function appendMessage(projectId, msg) {
  const d = getDB();
  const tokenCount = msg.tokenCount || estimateTokens(msg.content);

  const result = d.prepare(`
    INSERT INTO messages (project_id, role, model_id, content, summary, token_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, msg.role, msg.modelId || null,
    msg.content, msg.summary || null, tokenCount,
    JSON.stringify(msg.metadata || null)
  );

  return { id: result.lastInsertRowid, tokenCount };
}

/**
 * Get message history for a project.
 * Default: newest first. Use order: "asc" for chronological.
 */
export function getMessages(projectId, options = {}) {
  const d = getDB();
  let sql = "SELECT * FROM messages WHERE project_id = ?";
  const params = [projectId];

  if (options.modelId) { sql += " AND model_id = ?"; params.push(options.modelId); }
  if (options.role) { sql += " AND role = ?"; params.push(options.role); }
  if (options.since) { sql += " AND created_at > ?"; params.push(options.since); }
  if (options.afterId) { sql += " AND id > ?"; params.push(options.afterId); }

  sql += " ORDER BY id " + (options.order === "asc" ? "ASC" : "DESC");
  if (options.limit) { sql += " LIMIT ?"; params.push(options.limit); }

  return d.prepare(sql).all(...params).map(deserializeMessage);
}

/**
 * Get the total number of messages for a project.
 * @param {string} projectId
 * @returns {number} The total count of messages.
 */
export function getMessageCount(projectId) {
  const row = getDB().prepare(
    "SELECT COUNT(*) as count FROM messages WHERE project_id = ?"
  ).get(projectId);
  return row?.count || 0;
}

/**
 * Total tokens in a project's message history.
 */
export function messageTokens(projectId) {
  const row = getDB().prepare(
    "SELECT SUM(token_count) as total FROM messages WHERE project_id = ?"
  ).get(projectId);
  return row?.total || 0;
}

/**
 * Delete messages within a specific ID range for a given project.
 * This is typically used after messages have been compressed into a snapshot.
 * @param {string} projectId
 * @param {number} fromId The starting message ID (inclusive).
 * @param {number} toId The ending message ID (inclusive).
 */
export function deleteMessages(projectId, fromId, toId) {
  const d = getDB();
  d.prepare(
    "DELETE FROM messages WHERE project_id = ? AND id BETWEEN ? AND ?"
  ).run(projectId, fromId, toId);
}

// ─── IDENTITY ───
// Global — not project-scoped. A model's identity persists across everything.

/**
 * Write a perception. Types: "self", "peer", "meta"
 *  - self: model assessing itself (subject == observer)
 *  - peer: model assessing another model
 *  - meta: model's perception of another model's self-perception
 */
export function writePerception(perception) {
  getDB().prepare(`
    INSERT INTO identity (subject_id, observer_id, type, content, confidence)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    perception.subjectId, perception.observerId,
    perception.type, JSON.stringify(perception.content),
    perception.confidence || null
  );
}

/**
 * Write a batch of perceptions.
 * Uses a transaction for efficient multiple inserts.
 * @param {Array<object>} perceptions — Array of perception objects
 *  — each object should have: { subjectId, observerId, type, content, confidence? }
 */
export function writePerceptionsBatch(perceptions) {
  const d = getDB();
  const insert = d.prepare(`
    INSERT INTO identity (subject_id, observer_id, type, content, confidence)
    VALUES (?, ?, ?, ?, ?)
  `);

  d.transaction((percs) => {
    for (const p of percs) {
      insert.run(
        p.subjectId, p.observerId,
        p.type, JSON.stringify(p.content),
        p.confidence || null
      );
    }
  })(perceptions);
}

/**
 * What everyone thinks of a model.
 */
export function getPerceptionsOf(subjectId) {
  return getDB().prepare(
    "SELECT * FROM identity WHERE subject_id = ? ORDER BY created_at DESC"
  ).all(subjectId).map(deserializePerception);
}

/**
 * What a model thinks of everyone.
 */
export function getPerceptionsBy(observerId) {
  return getDB().prepare(
    "SELECT * FROM identity WHERE observer_id = ? ORDER BY created_at DESC"
  ).all(observerId).map(deserializePerception);
}

/**
 * What observer thinks of subject (most recent).
 */
export function getPerception(observerId, subjectId, type = "peer") {
  const row = getDB().prepare(
    "SELECT * FROM identity WHERE observer_id = ? AND subject_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1"
  ).get(observerId, subjectId, type);
  return row ? deserializePerception(row) : null;
}

/**
 * Get a model's self-assessment.
 */
export function getSelfAssessment(modelId) {
  return getPerception(modelId, modelId, "self");
}

// ─── SNAPSHOTS ───

/**
 * Save a compressed summary of a message range.
 * When the full history exceeds a model's context window,
 * the context manager compresses older messages into these.
 */
export function saveSnapshot(projectId, snapshot) {
  const tokenCount = snapshot.tokenCount || estimateTokens(snapshot.summary);

  getDB().prepare(`
    INSERT INTO snapshots (project_id, summary, token_count, covers_from, covers_to, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    projectId, snapshot.summary, tokenCount,
    snapshot.coversFrom, snapshot.coversTo,
    snapshot.createdBy || "system"
  );
}

/**
 * Get snapshots for a project.
 */
export function getSnapshots(projectId) {
  return getDB().prepare(
    "SELECT * FROM snapshots WHERE project_id = ? ORDER BY covers_to DESC"
  ).all(projectId);
}

// ─── MESSAGE MANAGEMENT (for compression) ───

/**
 * Delete specific messages by ID within a project.
 * Used by compression to prune messages after snapshotting.
 */
export function pruneMessages(projectId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;
  const d = getDB();
  const placeholders = messageIds.map(() => "?").join(",");
  d.prepare(
    `DELETE FROM messages WHERE project_id = ? AND id IN (${placeholders})`
  ).run(projectId, ...messageIds);
}

// ─── SCOPED ARTIFACT QUERIES ───

/**
 * List all global-scope artifacts, optionally filtered by type.
 */
export function listGlobalArtifacts(type = null) {
  const d = getDB();
  const sql = type
    ? "SELECT * FROM artifacts WHERE scope = 'global' AND type = ? ORDER BY modified_at DESC"
    : "SELECT * FROM artifacts WHERE scope = 'global' ORDER BY modified_at DESC";
  const stmt = d.prepare(sql);
  return (type ? stmt.all(type) : stmt.all()).map(deserializeArtifact);
}

/**
 * Remove expired artifacts (those past their expires_at timestamp).
 * Returns the number of artifacts removed.
 */
export function cleanupExpired() {
  const now = new Date().toISOString();
  const result = getDB().prepare(
    "DELETE FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < ?"
  ).run(now);
  return result.changes;
}

/**
 * Create a session-scoped artifact with automatic TTL.
 */
export function setSessionArtifact(projectId, name, content, type = "session", ttlMinutes = 60) {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  return writeArtifact(projectId, {
    name,
    type,
    content,
    author: "system",
    metadata: { scope: "session", expires_at: expiresAt },
  });
}

// ─── STATS ───

export function projectStats(projectId) {
  const d = getDB();
  return {
    artifacts: d.prepare("SELECT COUNT(*) as c FROM artifacts WHERE project_id = ?").get(projectId).c,
    messages: d.prepare("SELECT COUNT(*) as c FROM messages WHERE project_id = ?").get(projectId).c,
    tokens: d.prepare("SELECT SUM(token_count) as t FROM messages WHERE project_id = ?").get(projectId).t || 0,
    snapshots: d.prepare("SELECT COUNT(*) as c FROM snapshots WHERE project_id = ?").get(projectId).c,
  };
}

export function globalStats() {
  const d = getDB();
  return {
    artifacts: d.prepare("SELECT COUNT(*) as c FROM artifacts").get().c,
    messages: d.prepare("SELECT COUNT(*) as c FROM messages").get().c,
    perceptions: d.prepare("SELECT COUNT(*) as c FROM identity").get().c,
    snapshots: d.prepare("SELECT COUNT(*) as c FROM snapshots").get().c,
    totalTokens: d.prepare("SELECT SUM(token_count) as t FROM messages").get().t || 0,
  };
}

// ─── CLOSE ───

export function close() {
  if (db) { db.close(); db = null; }
}

// ─── HELPERS ───

function estimateTokens(text = "") {
  return centralEstimate(text);
}

function deserializeArtifact(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    type: row.type, content: row.content, summary: row.summary,
    tokenCount: row.token_count, version: row.version,
    author: row.author, metadata: tryParse(row.metadata),
    createdAt: row.created_at, modifiedAt: row.modified_at,
  };
}

function deserializeMessage(row) {
  return {
    id: row.id, projectId: row.project_id, role: row.role,
    modelId: row.model_id, content: row.content, summary: row.summary,
    tokenCount: row.token_count, metadata: tryParse(row.metadata),
    createdAt: row.created_at,
  };
}

function deserializePerception(row) {
  return {
    id: row.id, subjectId: row.subject_id, observerId: row.observer_id,
    type: row.type, content: tryParse(row.content),
    confidence: row.confidence, createdAt: row.created_at,
  };
}

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

export default {
  writeArtifact, readArtifact, listArtifacts, deleteArtifact,
  appendMessage, getMessages, messageTokens, getMessageCount,
  pruneMessages, listGlobalArtifacts, cleanupExpired, setSessionArtifact,
  writePerception, writePerceptionsBatch, getPerceptionsOf, getPerceptionsBy, getPerception, getSelfAssessment,
  saveSnapshot, getSnapshots, deleteMessages,
  projectStats, globalStats, close,
};
