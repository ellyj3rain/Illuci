/**
 * illuci datastore — composition root.
 *
 * openDatastore() opens the trunk DB through the shared sqlite-driver facade
 * (node:sqlite primary / better-sqlite3 fallback), sets WAL + busy_timeout (the
 * concurrency guard for the company parallel pool), and builds the trunk. A
 * process-level singleton mirrors the context/store.js getDB() pattern.
 *
 * Projections (vector / graph / analytics) wire in at [A16.3]; for now the trunk
 * is the spine. All write seams are gated by datastoreEnabled() (ILLUCI_DATASTORE_ENABLED,
 * default off) + a live SQLite backend, so importing this module is always safe.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, sqliteAvailable, enableWalMode } from "../storage/sqlite-driver.js";
import { trunkDbPath, vectorDbPath, datastoreFlags } from "./config.js";
import { openTrunk } from "./trunk.js";
import { createRegistry } from "./projections/registry.js";
import { indexObservationLanes } from "./jsonl-index.js";
import { indexLanes } from "./lane-index.js";

let store = null;

export function openDatastore({ path, embedder, dim } = {}) {
  if (store) return store;
  const dbPath = path || trunkDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const driver = openDatabase(dbPath);
  // Arm busy_timeout FIRST so DDL/INSERT wait out a held write lock under concurrent opens
  // (the company parallel pool, or a multi-process spike) instead of throwing SQLITE_BUSY.
  driver.pragma(`busy_timeout = ${Number(process.env.ILLUCI_DATASTORE_BUSY_TIMEOUT) || 5000}`); // override for high-contention setups
  // journal_mode=WAL is the one pragma busy_timeout can't cover (it needs a brief exclusive
  // lock that SQLite refuses to wait on, to avoid deadlock) — so retry it until an opener wins.
  enableWalMode(driver);

  const trunk = openTrunk(driver);
  // Derived projections (graph / vector / analytics) per the armed flags. Each is
  // degrade-safe and rebuilt from the trunk on read — the write path stays untouched.
  const registry = createRegistry({
    trunk,
    flags: datastoreFlags(),
    vectorDbPath: vectorDbPath(),
    trunkPath: dbPath,
    embedder,
    dim,
  });
  store = {
    trunk,
    registry,
    driver,
    // [A16.7] fold the per-kind observations.jsonl lanes into the trunk on demand.
    indexJsonlLanes: (opts) => indexObservationLanes({ trunk, ...opts }),
    // [A19] fold ALL .illuci/data lanes (incl. file-canonical read-only projections) into the trunk.
    indexLanes: (opts) => indexLanes({ trunk, ...opts }),
    close,
  };
  return store;
}

/** True only when the operator has armed the datastore AND a SQLite backend exists. */
export function datastoreEnabled() {
  return datastoreFlags().enabled && sqliteAvailable();
}

export function close() {
  if (store) {
    try { store.registry?.close(); } catch { /* best-effort */ }
    try { store.driver.close(); } catch { /* best-effort */ }
    store = null;
  }
}

export { indexObservationLanes, indexLanes };
export default { openDatastore, datastoreEnabled, close, indexObservationLanes, indexLanes };
