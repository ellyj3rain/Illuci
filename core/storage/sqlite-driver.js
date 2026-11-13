/**
 * illuci — SQLite driver abstraction (F-016 defuse).
 *
 * Defuses the F-016 landmine: a static `import Database from "better-sqlite3"`
 * crashes module *evaluation* when the native addon is absent, and because
 * context/store.js, treasury/ledger.js and sessions/store.js (and, until
 * [A93], agents/subagent-memory.js) are reachable through static-import chains on the
 * dispatch path (composer.js -> context/manager.js -> context/store.js), that
 * one crash cascades and takes the runner + the unified dispatch layer down even
 * for backends that need no SQLite. The ratified context layer (buildView /
 * maybeCompress compaction) has been dead-on-arrival as a result.
 *
 * This module exposes ONE factory, `openDatabase(path)`, returning a handle with
 * the small better-sqlite3-compatible surface the illuci stores actually use
 * (prepare / run / get / all / exec / pragma / transaction / close), backed by,
 * in order:
 *   1. node:sqlite (DatabaseSync) — the operator-ratified primary (see the F-016
 *      driver entry in DECISION_REGISTRY). Built into Node (>= 22.5 flagged,
 *      >= 23.4 / Electron unflagged), no native install, confirmed available in
 *      this runtime. Choosing it makes the context layer genuinely LIVE and
 *      converges with OTL's node:sqlite path ([A11]).
 *   2. better-sqlite3 via lazy `createRequire` — fallback for runtimes/tests that
 *      pin it, mirroring the telemetry/store.js [A65] / DR-075 lazy pattern.
 * If NEITHER loads, `openDatabase` throws a clear error; callers that must degrade
 * gracefully (telemetry) keep their existing try/catch guards.
 *
 * Resolution is memoized and overridable via `ILLUCI_SQLITE_DRIVER=node|better`
 * (operability; the since-retired subagent-memory test was its first exerciser — [A93]).
 *
 * node:sqlite vs better-sqlite3 API gaps bridged by the facade:
 *   - `.pragma("k = v")`  → `exec("PRAGMA k = v")`
 *   - `.transaction(fn)`  → BEGIN / COMMIT / ROLLBACK wrapper returning a callable
 * run/get/all/exec/close pass through (compatible shapes: run -> {changes,
 * lastInsertRowid}, get -> row|undefined, all -> rows[]). The illuci stores bind
 * positional `?` params only and never nest transactions, so the facade stays thin.
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let resolved = null; // memoized { kind: 'node'|'better'|'none', ... }

function resolveBackend() {
  if (resolved) return resolved;

  const forced = (process.env.ILLUCI_SQLITE_DRIVER || "").toLowerCase();

  // 1. node:sqlite — the ratified primary. Built in; no native compile step.
  if (forced !== "better") {
    try {
      const sqlite = require("node:sqlite");
      if (sqlite && sqlite.DatabaseSync) {
        resolved = { kind: "node", DatabaseSync: sqlite.DatabaseSync };
        return resolved;
      }
    } catch {
      /* node:sqlite unavailable (older Node, or flag-gated) — fall through */
    }
  }

  // 2. better-sqlite3 — lazy fallback (mirrors telemetry/store.js [A65] / DR-075).
  if (forced !== "node") {
    try {
      const Better = require("better-sqlite3");
      resolved = { kind: "better", Better };
      return resolved;
    } catch {
      /* not installed — fall through */
    }
  }

  resolved = { kind: "none" };
  return resolved;
}

/** Which backend resolved: 'node' | 'better' | 'none'. */
export function sqliteBackend() {
  return resolveBackend().kind;
}

/** True when some SQLite backend is available. */
export function sqliteAvailable() {
  return resolveBackend().kind !== "none";
}

/**
 * Open a SQLite database with a better-sqlite3-compatible surface. Throws if no
 * backend is available; callers that must degrade wrap in try/catch as before.
 *
 * @param {string} path  filesystem path to the database file
 * @param {object} [options]  passed through to better-sqlite3 when that backend is used
 */
export function openDatabase(path, options = {}) {
  const b = resolveBackend();
  if (b.kind === "better") {
    // better-sqlite3 already exposes the full surface the stores expect.
    return new b.Better(path, options);
  }
  if (b.kind === "node") {
    // Pass allowExtension to the node:sqlite constructor only when asked (sqlite-vec
    // needs it); existing callers keep the exact single-arg behavior unchanged.
    const db = options.allowExtension
      ? new b.DatabaseSync(path, { allowExtension: true })
      : new b.DatabaseSync(path);
    return wrapNodeSqlite(db);
  }
  throw new Error(
    "[sqlite-driver] no SQLite backend available — node:sqlite requires Node >= 22.5 " +
      "(unflagged on >= 23.4 / Electron) and better-sqlite3 is not installed. " +
      "Install better-sqlite3 or run on a Node that provides node:sqlite."
  );
}

/**
 * Switch a connection to WAL, retrying on "database is locked".
 *
 * journal_mode=WAL rewrites the journal header under a brief EXCLUSIVE lock; under
 * concurrent opens (multi-process, or the company parallel pool) SQLite returns
 * SQLITE_BUSY ("database is locked") IMMEDIATELY for that upgrade rather than invoking
 * the busy handler — it declines to wait, to avoid deadlock — so `busy_timeout` does NOT
 * cover this one pragma (it does cover the DDL/INSERT that follow). The first opener to
 * win the lock switches the file to WAL; every later `journal_mode=WAL` then sees WAL
 * already set and returns without needing the exclusive lock. A bounded synchronous retry
 * converges in a couple of attempts (~<1s worst case). Works on any handle exposing
 * `.pragma("k = v")` — the facade OR a raw better-sqlite3 db — so every illuci store shares
 * one WAL-switch guard instead of an unretried `db.pragma("journal_mode = WAL")`.
 *
 * @param {{ pragma: (statement: string) => unknown }} db
 * @param {{ attempts?: number, backoffMs?: number }} [opts]
 */
export function enableWalMode(db, { attempts = 40, backoffMs = 20 } = {}) {
  let sleeper = null; // allocated lazily — the success path (no contention) stays alloc-free
  for (let attempt = 1; ; attempt += 1) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      const locked = /database is locked|SQLITE_BUSY/i.test(String(err && err.message));
      if (!locked || attempt >= attempts) throw err;
      if (!sleeper) sleeper = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleeper, 0, 0, backoffMs); // synchronous backoff — store opens are sync
    }
  }
}

/**
 * Wrap a node:sqlite DatabaseSync in the small better-sqlite3-compatible surface
 * the illuci stores use. prepare/run/get/all/exec/close pass through; pragma() and
 * transaction() are the only two methods node:sqlite lacks.
 */
function wrapNodeSqlite(db) {
  return {
    // StatementSync.run/get/all accept positional params as rest args and return
    // {changes,lastInsertRowid} / row|undefined / rows[] — compatible with the
    // stores' `.run(...p)` / `.get(...p)` / `.all(...p)` usage.
    prepare(sql) {
      return db.prepare(sql);
    },
    exec(sql) {
      return db.exec(sql);
    },
    // better-sqlite3 `db.pragma("k = v")` (return value unused by the stores) ->
    // node:sqlite has no .pragma; route through exec.
    pragma(statement) {
      return db.exec(`PRAGMA ${statement};`);
    },
    // better-sqlite3 `db.transaction(fn)` returns a callable that runs fn inside a
    // transaction. node:sqlite has no .transaction; emulate with BEGIN/COMMIT and
    // a fail-safe ROLLBACK. Not reentrant — the illuci stores never nest transactions.
    transaction(fn) {
      return (...args) => {
        db.exec("BEGIN");
        try {
          const result = fn(...args);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* best-effort rollback */
          }
          throw err;
        }
      };
    },
    close() {
      return db.close();
    },
    // Load a SQLite extension (e.g. sqlite-vec). Requires the handle to have been
    // opened with { allowExtension: true }. Additive — better-sqlite3 exposes its
    // own .loadExtension on the raw instance openDatabase returns directly.
    loadExtension(file) {
      if (typeof db.enableLoadExtension === "function") db.enableLoadExtension(true);
      return db.loadExtension(file);
    },
    // Escape hatch for any caller that needs the raw node:sqlite handle.
    get raw() {
      return db;
    },
  };
}

/** Test/operability helper: drop the memoized backend so it re-resolves. */
export function _resetBackendForTest() {
  resolved = null;
}
