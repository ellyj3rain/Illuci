/**
 * illuci datastore — configuration & path resolution.
 *
 * The unified datastore trunk + sibling projection stores live under a dedicated
 * `datastore/` directory inside the typed runtime data home (relocatable wholesale
 * via ILLUCI_DATA_HOME). A DEDICATED `ILLUCI_DATASTORE_DB` override exists deliberately —
 * it must NOT reuse the overloaded `ILLUCI_CONTEXT_DB` (which already points
 * context/treasury — and, until its [A93]/F-128 retirement, subagent-memory —
 * at data/context.db), or an operator override
 * would silently mis-point the trunk (recorded as a FINDINGS hazard).
 *
 * Everything ships dark: ILLUCI_DATASTORE_ENABLED (+ per-projection flags) default
 * off, so the write seams are no-ops until armed. Importing the datastore is
 * always safe regardless of flags.
 */
import { join } from "node:path";
import { runtimeDataHome } from "../data/paths.js";

function flag(name) {
  return /^(1|true|on|yes)$/i.test(String(process.env[name] || "").trim());
}

export function datastoreDir() {
  return join(runtimeDataHome(), "datastore");
}

/** Canonical append-only trunk. Dedicated env var — never ILLUCI_CONTEXT_DB. */
export function trunkDbPath() {
  return process.env.ILLUCI_DATASTORE_DB || join(datastoreDir(), "trunk.db");
}

/** Episodic vector store (sqlite-vec) — separate file keeps the trunk pure SQLite. */
export function vectorDbPath() {
  return process.env.ILLUCI_DATASTORE_VEC_DB || join(datastoreDir(), "episodic.vec.db");
}

/** Analytics store (DuckDB) — its own file; ATTACHes the trunk read-only. */
export function analyticsDbPath() {
  return process.env.ILLUCI_DATASTORE_DUCKDB_PATH || join(datastoreDir(), "analytics.duckdb");
}

export function datastoreFlags() {
  const enabled = flag("ILLUCI_DATASTORE_ENABLED");
  return {
    enabled,
    // graph is SQLite-native (no extra dep) → rides with `enabled` unless opted out.
    graph: enabled && !flag("ILLUCI_DATASTORE_GRAPH_OFF"),
    // vector / duckdb add optional native deps → each needs its own explicit flag.
    vector: enabled && flag("ILLUCI_DATASTORE_VEC"),
    duckdb: enabled && flag("ILLUCI_DATASTORE_DUCKDB"),
    // legacy-store consolidation is independently armable (it reroutes dispatch-path
    // stores), so it has its own flag rather than riding ILLUCI_DATASTORE_ENABLED.
    consolidate: flag("ILLUCI_DATASTORE_CONSOLIDATE"),
  };
}

export default { datastoreDir, trunkDbPath, vectorDbPath, analyticsDbPath, datastoreFlags };
