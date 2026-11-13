/**
 * illuci datastore — JSONL observation-lane indexing ([A16.7]).
 *
 * Folds the per-kind `observations.jsonl` lanes (core/data/observations.js) into the
 * trunk as records. An observation is already the record envelope's superset, so each
 * line maps 1:1 through the trunk's normalize+append. Idempotent: the observation `id`
 * is preserved as the record id, so re-indexing is INSERT OR IGNORE (first write wins).
 * Read-only over the JSONL — the lanes remain the durable intake.
 *
 * Scope: the observation lanes only. The file-canonical `decisions.jsonl` (DR-004) and
 * persona-memory's `active.jsonl` (AM-23) live in DIFFERENT files and are never read
 * here; telemetry's SQLite index already reached the trunk via [A16.6].
 */
import { readObservations } from "../data/observations.js";
import { DATA_KINDS } from "../data/paths.js";

export function indexObservationLanes({ trunk, kinds = Object.keys(DATA_KINDS), source = "jsonl-index" } = {}) {
  if (!trunk) throw new Error("indexObservationLanes requires a trunk");
  const perKind = {};
  let indexed = 0;
  for (const kind of kinds) {
    if (!DATA_KINDS[kind]) continue; // ignore unknown kinds rather than throw
    const observations = readObservations(kind);
    if (!observations.length) continue;
    for (const obs of observations) {
      trunk.append({ ...obs, ts: obs.ts || obs.timestamp, source: obs.source || source });
      indexed += 1;
    }
    perKind[kind] = observations.length;
  }
  return { indexed, perKind };
}

export default { indexObservationLanes };
