/**
 * illuci datastore — projection registry (CQRS read-side coordinator).
 *
 * Owns the derived projections (graph / vector / analytics), each gated by its
 * config flag and degrade-safe. Read methods catch the projection up from the
 * durable trunk (incrementally, via projection_offsets) and then read — so a
 * projection is always current at query time WITHOUT coupling the write path.
 * Nothing here is the system-of-record; everything is reconstructable from the
 * trunk, which is the clean source of truth.
 */
import { createGraphProjection } from "./graph.js";
import { createVectorProjection } from "./vector.js";
import { createAnalyticsProjection } from "./analytics.js";

export function createRegistry({ trunk, flags = {}, vectorDbPath, trunkPath, embedder, dim } = {}) {
  const projections = {};
  if (flags.graph) projections.graph = createGraphProjection(trunk.driver);
  if (flags.vector) projections.vector = createVectorProjection({ dbPath: vectorDbPath, embedder, dim });
  if (flags.duckdb) projections.analytics = createAnalyticsProjection({ trunkPath });

  /** Catch the materialized projections (graph, vector) up from the trunk. */
  async function rebuild() {
    const out = {};
    if (projections.graph) out.graph = projections.graph.rebuild(trunk);
    if (projections.vector) out.vector = await projections.vector.rebuild(trunk);
    return out;
  }

  /** Transitive reachability over the semantic graph (catches up first). */
  function reach(rootId, opts) {
    if (!projections.graph) return [];
    projections.graph.rebuild(trunk);
    return projections.graph.reach(rootId, opts);
  }

  /** KNN over episodic memory (catches up first). */
  async function search(text, k = 5) {
    if (!projections.vector?.available) return [];
    await projections.vector.rebuild(trunk);
    return projections.vector.search(text, k);
  }

  /** Token/usage rollup by model (pull-based; reads the live trunk). */
  async function costByModel() {
    if (!projections.analytics?.available) return [];
    return projections.analytics.costByModel();
  }

  const get = (name) => projections[name] || null;
  const health = () => Object.fromEntries(Object.entries(projections).map(([k, p]) => [k, p.health()]));
  function close() {
    try { projections.vector?.close?.(); } catch { /* best-effort */ }
    try { projections.analytics?.close?.(); } catch { /* best-effort */ }
  }

  return { projections, get, rebuild, reach, search, costByModel, health, close };
}

export default { createRegistry };
