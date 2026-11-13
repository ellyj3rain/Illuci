/**
 * illuci/core/mcp/datastore-tools.js — read-shaped datastore query tool ([A19]).
 *
 * Companion to datastore-resource.js. A resource is a static/sync read; a tool is
 * computed — so the async/SQL surface lives here: read-only SQL over the trunk,
 * cost-by-model rollups, and episodic vector search. Read-only by construction: the
 * sql verb rejects any mutating/DDL statement and never touches record-writer.
 */
import { openDatastore, datastoreEnabled } from '../datastore/index.js';
import { scrub } from '../identity/surface.js';

const MUTATING = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex)\b/i;
const PRAGMA_WRITE = /pragma\s+[\w.]+\s*=/i;

export const DATASTORE_QUERY_TOOL = {
  name: 'datastore_query_v1',
  schema_version: '1.0.0',
  description: scrub(
    "Query illuci's datastore (read-only, computed). verb=sql runs a read-only SELECT over " +
    "the trunk's records + projection tables; verb=cost-by-model returns a token/usage " +
    'rollup; verb=vector-search runs episodic KNN. Lanes are indexed on demand before ' +
    'querying. NEVER writes — the lane writers remain the only mutation path.',
  ),
  inputSchema: {
    type: 'object',
    properties: {
      verb: { type: 'string', enum: ['sql', 'cost-by-model', 'vector-search'], description: 'sql | cost-by-model | vector-search' },
      sql: { type: 'string', description: 'Read-only SELECT statement (verb=sql).' },
      text: { type: 'string', description: 'Query text (verb=vector-search).' },
      k: { type: 'number', description: 'Top-k for vector-search (default 5).' },
    },
    required: ['verb'],
  },
  async handler(args = {}) {
    if (!datastoreEnabled()) return { error: 'datastore-disabled', hint: 'set ILLUCI_DATASTORE_ENABLED=1' };
    const store = openDatastore();
    try { store.indexLanes(); } catch { /* index is best-effort; query what is present */ }

    switch (args.verb) {
      case 'sql': {
        const sql = String(args.sql || '');
        if (!sql) return { error: 'sql required for verb=sql' };
        if (MUTATING.test(sql) || PRAGMA_WRITE.test(sql)) {
          return { error: 'read-only: only SELECT / PRAGMA-read queries are allowed' };
        }
        const rows = store.driver.prepare(sql).all();
        return { verb: 'sql', count: rows.length, rows };
      }
      case 'cost-by-model':
        return { verb: 'cost-by-model', data: await store.registry.costByModel() };
      case 'vector-search': {
        const text = String(args.text || '');
        if (!text) return { error: 'text required for verb=vector-search' };
        return { verb: 'vector-search', data: await store.registry.search(text, Number(args.k) || 5) };
      }
      default:
        return { error: `unknown verb: ${args.verb || '(none)'} — use sql | cost-by-model | vector-search` };
    }
  },
};

export const DATASTORE_TOOLS = [DATASTORE_QUERY_TOOL];
export default { DATASTORE_QUERY_TOOL, DATASTORE_TOOLS };
