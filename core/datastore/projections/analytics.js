/**
 * illuci datastore — analytics projection (DuckDB, read-only attach).
 *
 * Pull-based: DuckDB opens its own database and ATTACHes the trunk SQLite file
 * READ_ONLY, so it never writes the trunk (clean boundary, sidesteps SQLite's
 * single writer) and needs no materialization — rollups run on demand against
 * the live trunk. Functional when @duckdb/node-api loads (the default once
 * installed); a genuine noop only when the optional native lib is absent.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const NAME = "analytics";

function loadDuck() {
  try {
    return require("@duckdb/node-api");
  } catch {
    return null;
  }
}

function noop(reason) {
  return {
    name: NAME,
    available: false,
    async query() { return []; },
    async costByModel() { return []; },
    health: () => ({ available: false, reason }),
    async close() {},
  };
}

const coerce = (v) => (typeof v === "bigint" ? Number(v) : v);

export function createAnalyticsProjection({ trunkPath } = {}) {
  const duck = loadDuck();
  if (!duck) return noop("@duckdb/node-api not installed");
  if (!trunkPath) return noop("no trunk path");

  let conn = null;
  async function ensureConn() {
    if (conn) return conn;
    const instance = await duck.DuckDBInstance.create(":memory:");
    conn = await instance.connect();
    await conn.run("INSTALL sqlite; LOAD sqlite;");
    await conn.run(`ATTACH '${String(trunkPath).replace(/\\/g, "/")}' AS trunk (TYPE sqlite, READ_ONLY)`);
    return conn;
  }

  /** Run read-only analytical SQL over `trunk.*`. Returns array of plain objects. */
  async function query(sql) {
    const c = await ensureConn();
    const reader = await c.runAndReadAll(sql);
    const cols = reader.columnNames();
    return reader.getRows().map((row) => Object.fromEntries(row.map((v, i) => [cols[i], coerce(v)])));
  }

  const costByModel = () =>
    query(
      "SELECT model_id, count(*) AS records, " +
        "coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens " +
        "FROM trunk.records WHERE model_id IS NOT NULL GROUP BY model_id ORDER BY records DESC"
    );

  return {
    name: NAME,
    available: true,
    query,
    costByModel,
    health: () => ({ available: true }),
    async close() { if (conn) { try { conn.closeSync?.(); } catch {} conn = null; } },
  };
}

export default { createAnalyticsProjection };
