/**
 * illuci/core/mcp/datastore-resource.js — the unified datastore as an MCP resource ([A19]).
 *
 * Tier-1 read-only resource surface (mirrors decision-log-resource.js). Exposes illuci's
 * event-sourced datastore — the .illuci/data lanes folded into the trunk — for an MCP host
 * to READ: records by lineage, graph reachability, store health. Sync verbs only; the
 * computed/async surface (read-only SQL, cost rollups, vector search) lives in the
 * companion read-shaped tool (datastore-tools.js).
 *
 * READ-ONLY by construction: it calls only the trunk's fold/read API and the projection
 * read side — NEVER record-writer. File-canonical lanes (decisions/governance/memory) are
 * projected read-only; the lane writers remain the only mutation path. The store is indexed
 * on demand before each read so the surface always reflects current lane state.
 */
import { openDatastore, datastoreEnabled } from '../datastore/index.js';
import { surfaceUri, scrub } from '../identity/surface.js';

const RESOURCE_URI = surfaceUri('datastore');
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function wrap(payload) {
  return {
    contents: [
      { uri: RESOURCE_URI, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

export const DATASTORE_RESOURCE = {
  name: 'datastore_v1',
  schema_version: '1.0.0',
  uri: RESOURCE_URI,
  mimeType: 'application/json',
  description: scrub(
    "illuci's unified event-sourced datastore (read-only). The .illuci/data lanes folded into " +
    'one queryable trunk: read records by lineage, graph reachability, and store health — ' +
    'for audit, cost/lineage introspection, and cross-run analysis. NEVER writes; the lane ' +
    'writers remain the only mutation path, and file-canonical lanes are projected read-only.',
  ),
  arguments: [
    { name: 'verb', description: 'records | by-run | graph-reach | health (default records).', required: false },
    { name: 'runId', description: 'Filter records / fold one run (records, by-run).', required: false },
    { name: 'kind', description: 'Filter records by lane kind (records).', required: false },
    { name: 'type', description: 'Filter records by type (records).', required: false },
    { name: 'rootId', description: 'Root node id for graph-reach.', required: false },
    { name: 'limit', description: `Max records (default ${DEFAULT_LIMIT}, capped ${MAX_LIMIT}).`, required: false },
  ],
  /** Read the datastore. Read-only + sync by construction. Returns MCP resource `contents`. */
  read({ verb = 'records', runId = null, kind = null, type = null, rootId = null, limit = DEFAULT_LIMIT } = {}) {
    if (!datastoreEnabled()) {
      return wrap({ schema_version: '1.0.0', error: 'datastore-disabled', hint: 'set ILLUCI_DATASTORE_ENABLED=1' });
    }
    const store = openDatastore();
    try { store.indexLanes(); } catch { /* index is best-effort; read what is present */ }
    const cap = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    let data;
    let meta = { verb };
    switch (verb) {
      case 'by-run':
        data = store.trunk.byRun(runId);
        meta = { verb, runId };
        break;
      case 'graph-reach':
        data = store.registry.reach(rootId, {});
        meta = { verb, rootId };
        break;
      case 'health':
        data = { count: store.trunk.count(), latestSeq: store.trunk.latestSeq(), projections: store.registry.health() };
        break;
      case 'records':
      default: {
        const filter = {};
        if (runId) filter.runId = runId;
        if (kind) filter.kind = kind;
        if (type) filter.type = type;
        data = store.trunk.records(filter).slice(-cap);
        meta = { verb: 'records', ...filter, limit: cap };
      }
    }

    return wrap({ schema_version: '1.0.0', ...meta, count: Array.isArray(data) ? data.length : 1, data });
  },
};

export default { DATASTORE_RESOURCE };
