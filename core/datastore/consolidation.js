/**
 * illuci datastore — legacy-store consolidation (strangler-fig).
 *
 * Lets the legacy SQLite stores (context, treasury, sessions, telemetry;
 * subagent-memory until its [A93]/F-128 retirement) share the single datastore trunk DB when consolidation is armed,
 * while staying BYTE-IDENTICAL (their own files, their own `_migrations`) when it
 * is off — the default.
 *
 * Dark-gated by ILLUCI_DATASTORE_CONSOLIDATE. When armed, a store: opens the trunk DB
 * instead of its legacy file (`storeDbPath`), namespaces its migrations table so the
 * shared `_migrations` cannot collide across stores (`migrationsTable`), and
 * one-time-ingests its existing legacy rows (`ingestLegacy`). Legacy files are NEVER
 * deleted here — they remain as fallback until a separately-governed retire step
 * after a green round-trip. This is the fix for the ILLUCI_CONTEXT_DB overload too:
 * consolidated stores share one dedicated trunk path, not the overloaded var.
 */
import { existsSync } from "node:fs";
import { trunkDbPath, datastoreFlags } from "./config.js";
import { sqliteAvailable } from "../storage/sqlite-driver.js";

export function consolidationEnabled() {
  return datastoreFlags().consolidate && sqliteAvailable();
}

/** Where a store opens its DB: the shared trunk when consolidated, else its legacy file. */
export function storeDbPath(legacyPath) {
  return consolidationEnabled() ? trunkDbPath() : legacyPath;
}

/**
 * Migrations table for a store: namespaced when consolidated (the shared-DB
 * `_migrations` collision fix); the plain `_migrations` on its own legacy file.
 */
export function migrationsTable(storeId) {
  return consolidationEnabled() ? `_migrations_${storeId}` : "_migrations";
}

const quote = (p) => String(p).replace(/\\/g, "/").replace(/'/g, "''");

/**
 * One-time, idempotent ingest of a store's legacy rows into the (already-open,
 * already-schema'd) trunk driver. Copies only columns shared between the legacy and
 * trunk tables (schema-drift-safe), INSERT OR IGNORE (dedupes on PK), guarded by a
 * `_consolidation` marker so re-opens never re-copy. The legacy file is read-only
 * here and never deleted. The caller invokes this only when consolidated.
 */
export function ingestLegacy(driver, { storeId, legacyPath, tables }) {
  driver.exec(
    "CREATE TABLE IF NOT EXISTS _consolidation (store_id TEXT PRIMARY KEY, migrated_at TEXT, copied INTEGER)"
  );
  if (driver.prepare("SELECT store_id FROM _consolidation WHERE store_id = ?").get(storeId)) {
    return { alreadyDone: true, copied: 0 };
  }
  let copied = 0;
  if (legacyPath && legacyPath !== trunkDbPath() && existsSync(legacyPath)) {
    driver.exec(`ATTACH '${quote(legacyPath)}' AS legacy`);
    try {
      const present = new Set(
        driver.prepare("SELECT name FROM legacy.sqlite_master WHERE type='table'").all().map((r) => r.name)
      );
      for (const t of tables) {
        if (!present.has(t)) continue;
        const legCols = driver.prepare(`SELECT name FROM pragma_table_info('${t}', 'legacy')`).all().map((c) => c.name);
        const mainCols = new Set(driver.prepare(`SELECT name FROM pragma_table_info('${t}', 'main')`).all().map((c) => c.name));
        const cols = legCols.filter((c) => mainCols.has(c));
        if (!cols.length) continue;
        const list = cols.map((c) => `"${c}"`).join(", ");
        const r = driver.prepare(`INSERT OR IGNORE INTO main."${t}" (${list}) SELECT ${list} FROM legacy."${t}"`).run();
        copied += Number(r.changes) || 0;
      }
    } finally {
      driver.exec("DETACH legacy");
    }
  }
  driver.prepare("INSERT INTO _consolidation(store_id, migrated_at, copied) VALUES (?, datetime('now'), ?)").run(storeId, copied);
  return { alreadyDone: false, copied };
}

export default { consolidationEnabled, storeDbPath, migrationsTable, ingestLegacy };
