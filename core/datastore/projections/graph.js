/**
 * illuci datastore — semantic graph projection (SQLite-native, bitemporal).
 *
 * A derived read-model over the trunk: folds run/company records into a node/edge
 * graph constrained to the ratified GRAPH_EDGE_TYPES / GRAPH_NODE_TYPES. No native
 * dependency — it shares the trunk driver (graph_nodes/graph_edges live in the
 * trunk DB). Edges carry bitemporal columns (valid_from/valid_to + tx_from/tx_to)
 * so a future reseat closes rather than deletes; today edges are insert-once and
 * idempotent (deterministic ids + INSERT OR IGNORE). Rebuilt incrementally from
 * projection_offsets; reconstructable from the trunk at any time.
 */
import { GRAPH_NODE_TYPES, GRAPH_EDGE_TYPES } from "../../composition/graph-preset.js";

const NAME = "graph";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id    TEXT PRIMARY KEY,
  node_type  TEXT NOT NULL,
  label      TEXT,
  attrs      TEXT,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  tx_from    TEXT NOT NULL DEFAULT (datetime('now')),
  tx_to      TEXT,
  created_seq INTEGER
);
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id    TEXT PRIMARY KEY,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  edge_type  TEXT NOT NULL,
  run_id     TEXT,
  company_id TEXT,
  attrs      TEXT,
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  tx_from    TEXT NOT NULL DEFAULT (datetime('now')),
  tx_to      TEXT,
  created_seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gedges_src ON graph_edges(src, edge_type);
CREATE INDEX IF NOT EXISTS idx_gedges_dst ON graph_edges(dst, edge_type);
`;

export function createGraphProjection(driver) {
  driver.exec(SCHEMA);

  const upsertNode = driver.prepare(
    "INSERT OR IGNORE INTO graph_nodes(node_id, node_type, label, valid_from, created_seq) VALUES (?, ?, ?, ?, ?)"
  );
  const upsertEdge = driver.prepare(
    "INSERT OR IGNORE INTO graph_edges(edge_id, src, dst, edge_type, run_id, company_id, valid_from, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  function node(id, type, label, ts, seq) {
    if (!GRAPH_NODE_TYPES.includes(type)) throw new Error(`graph: unknown node type "${type}"`);
    upsertNode.run(id, type, label ?? id, ts, seq ?? null);
  }
  function edge(src, dst, type, ts, seq, ids = {}) {
    if (!GRAPH_EDGE_TYPES.includes(type)) {
      throw new Error(`graph: edge type "${type}" is not in the ratified GRAPH_EDGE_TYPES`);
    }
    upsertEdge.run(`${src}|${type}|${dst}`, src, dst, type, ids.runId ?? null, ids.companyId ?? null, ts, seq ?? null);
  }

  /** Fold one trunk record into nodes/edges. Idempotent (deterministic ids). */
  function applyRecord(r) {
    const ts = r.ts;
    const seq = r.seq;
    if (r.type === "company.started" || r.type === "company.synthesis") {
      const cid = `company:${r.companyId}`;
      node(cid, "company", r.companyId, ts, seq);
      for (const m of r.payload?.members || []) {
        if (!m.runId) continue;
        const rid = `run:${m.runId}`;
        node(rid, "topology", m.topologyId, ts, seq);
        edge(cid, rid, "delegates-to", ts, seq, { companyId: r.companyId });
      }
    } else if (r.type === "run.started") {
      if (r.runId) node(`run:${r.runId}`, "topology", r.topologyId, ts, seq);
    } else if (r.type === "seat.output") {
      if (!r.runId) return;
      const rid = `run:${r.runId}`;
      node(rid, "topology", r.topologyId, ts, seq);
      if (r.seatId != null) {
        const sid = `seat:${r.runId}:${r.seatId}`;
        node(sid, "seat", String(r.seatId), ts, seq);
        edge(rid, sid, "contains", ts, seq, { runId: r.runId });
        if (r.modelId) {
          const mid = `model:${r.modelId}`;
          node(mid, "model", r.modelId, ts, seq);
          edge(sid, mid, "resolves-to", ts, seq, { runId: r.runId });
        }
      }
    }
  }

  /** Catch up from the trunk (incremental). Returns {applied, lastSeq}. */
  function rebuild(trunk, { batch = 2000 } = {}) {
    const last = trunk.getOffset(NAME);
    const recs = trunk.since(last, batch);
    let max = last;
    driver.transaction((rows) => {
      for (const r of rows) { applyRecord(r); if (r.seq > max) max = r.seq; }
    })(recs);
    if (max > last) trunk.setOffset(NAME, max);
    return { applied: recs.length, lastSeq: max };
  }

  /**
   * Recursive-CTE reachability. Current truth by default; pass `asOf` (ISO ts) for
   * time travel. Filter `nodeType` (e.g. "model") to answer "which models worked
   * transitively under this company".
   */
  function reach(rootId, opts = {}) {
    const { edgeTypes = ["contains", "delegates-to", "resolves-to"], asOf = null, nodeType = null, maxDepth = 16 } = opts;
    const inClause = edgeTypes.map(() => "?").join(",");
    const timeClause = asOf
      ? "AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?) AND e.tx_to IS NULL"
      : "AND e.valid_to IS NULL AND e.tx_to IS NULL";
    const sql =
      "WITH RECURSIVE reach(node_id, depth) AS (" +
      "  SELECT ?, 0" +
      "  UNION" +
      `  SELECT e.dst, r.depth + 1 FROM graph_edges e JOIN reach r ON e.src = r.node_id WHERE e.edge_type IN (${inClause}) ${timeClause} AND r.depth < ?` +
      ") SELECT DISTINCT n.node_id, n.node_type, n.label FROM reach JOIN graph_nodes n ON n.node_id = reach.node_id AND n.tx_to IS NULL" +
      (nodeType ? " WHERE n.node_type = ?" : "");
    const params = [rootId, ...edgeTypes, ...(asOf ? [asOf, asOf] : []), maxDepth, ...(nodeType ? [nodeType] : [])];
    return driver.prepare(sql).all(...params);
  }

  const counts = () => ({
    nodes: driver.prepare("SELECT COUNT(*) AS c FROM graph_nodes").get()?.c ?? 0,
    edges: driver.prepare("SELECT COUNT(*) AS c FROM graph_edges").get()?.c ?? 0,
  });

  return { name: NAME, available: true, applyRecord, rebuild, reach, counts, health: () => ({ available: true }) };
}

export default { createGraphProjection };
