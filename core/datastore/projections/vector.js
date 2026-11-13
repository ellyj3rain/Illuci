/**
 * illuci datastore — episodic vector projection (sqlite-vec).
 *
 * Derived read-model: embeds the prose of seat.output records into a sqlite-vec
 * `vec0` index, kept in a SEPARATE db file so the trunk stays pure SQLite (for the
 * DuckDB attach) and the extension load is isolated. Functional when sqlite-vec
 * loads (the default once installed); a genuine noop only when the optional native
 * lib is absent. The embedder is injected (default: local Ollama nomic-embed-text);
 * tests pass a deterministic stub. Rebuilt incrementally from the trunk and fully
 * reconstructable from it (`reindex`), so a transient embed failure never loses
 * data — the trunk is the durable source of truth.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { openDatabase, enableWalMode } from "../../storage/sqlite-driver.js";

const require = createRequire(import.meta.url);
const NAME = "vector";

function loadablePath() {
  try {
    const vec = require("sqlite-vec");
    const get = vec.getLoadablePath || vec.default?.getLoadablePath;
    return typeof get === "function" ? get() : null;
  } catch {
    return null;
  }
}

async function ollamaEmbed(text) {
  const host = (process.env.ILLUCI_OLLAMA_HOST || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = process.env.ILLUCI_EMBED_MODEL || "nomic-embed-text";
  const res = await fetch(`${host}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.embedding)) throw new Error("ollama embed: missing embedding");
  return json.embedding;
}

const textOf = (r) => (r.type === "seat.output" ? (r.payload?.response || null) : null);

function noop(reason) {
  return {
    name: NAME,
    available: false,
    async rebuild() { return { applied: 0, skipped: reason }; },
    async reindex() { return { applied: 0, skipped: reason }; },
    async search() { return []; },
    health: () => ({ available: false, reason }),
    close() {},
  };
}

export function createVectorProjection({ dbPath, embedder, dim = 768 } = {}) {
  const extPath = loadablePath();
  if (!extPath) return noop("sqlite-vec not installed");

  const embed = embedder || ollamaEmbed;
  let db = null;

  function ensureDb() {
    if (db) return db;
    mkdirSync(dirname(dbPath), { recursive: true });
    db = openDatabase(dbPath, { allowExtension: true });
    enableWalMode(db);
    db.pragma("busy_timeout = 5000");
    db.loadExtension(extPath);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_records USING vec0(embedding float[${dim}]);`);
    db.exec(
      "CREATE TABLE IF NOT EXISTS vec_meta (seq INTEGER PRIMARY KEY, record_id TEXT, run_id TEXT, company_id TEXT, type TEXT, ts TEXT, text TEXT);"
    );
    return db;
  }

  async function indexRecords(recs) {
    const d = ensureDb();
    const insVec = d.prepare("INSERT OR REPLACE INTO vec_records(rowid, embedding) VALUES (?, ?)");
    const insMeta = d.prepare(
      "INSERT OR REPLACE INTO vec_meta(seq, record_id, run_id, company_id, type, ts, text) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    let applied = 0;
    for (const r of recs) {
      const text = textOf(r);
      if (!text) continue;
      let v;
      try {
        v = await embed(text);
      } catch {
        continue; // best-effort; reindex() can recover from the durable trunk
      }
      if (!Array.isArray(v) || v.length !== dim) continue;
      insVec.run(BigInt(r.seq), JSON.stringify(v));
      insMeta.run(r.seq, r.id, r.runId, r.companyId, r.type, r.ts, text.slice(0, 4000));
      applied += 1;
    }
    return applied;
  }

  async function rebuild(trunk, { batch = 200 } = {}) {
    const last = trunk.getOffset(NAME);
    const recs = trunk.since(last, batch);
    const applied = await indexRecords(recs);
    const max = recs.reduce((m, r) => Math.max(m, r.seq), last);
    if (max > last) trunk.setOffset(NAME, max);
    return { applied, lastSeq: max };
  }

  async function reindex(trunk) {
    const d = ensureDb();
    d.exec("DELETE FROM vec_records; DELETE FROM vec_meta;");
    trunk.setOffset(NAME, 0);
    let total = 0;
    for (;;) {
      const r = await rebuild(trunk, { batch: 500 });
      total += r.applied;
      if (r.lastSeq >= trunk.latestSeq()) break;
    }
    return { applied: total };
  }

  async function search(text, k = 5) {
    const d = ensureDb();
    const q = await embed(text);
    if (!Array.isArray(q) || q.length !== dim) throw new Error(`vector.search: query embedding must be length ${dim}`);
    return d
      .prepare(
        "SELECT v.rowid AS seq, v.distance AS distance, m.record_id, m.run_id, m.type, m.text " +
          "FROM vec_records v JOIN vec_meta m ON m.seq = v.rowid " +
          "WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance"
      )
      .all(JSON.stringify(q), BigInt(k));
  }

  return {
    name: NAME,
    available: true,
    rebuild,
    reindex,
    search,
    health: () => ({ available: true, dim }),
    close() { if (db) { try { db.close(); } catch {} db = null; } },
  };
}

export default { createVectorProjection };
