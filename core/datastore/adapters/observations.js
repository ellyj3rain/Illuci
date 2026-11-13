/**
 * Lane adapters — observation-style operational lanes ([A19] Phase 1).
 *
 * telemetry/events.jsonl is `illuci.observation.v1`, a strict superset of the trunk
 * record envelope, so it normalizes through unchanged. The substrate `observations`
 * lane is `illuci.project.data.record/1` (a different dialect) and gets the standard
 * id/ts/kind/lineage map with the whole envelope preserved as payload.
 */
import { join } from "node:path";
import { runtimeDataHome, runtimeDataPath } from "../../data/paths.js";
import { tsOf, pickLineage } from "./lane-adapter.js";

export const TELEMETRY_ADAPTER = {
  lane: "telemetry",
  kind: "telemetry",
  authority: "operational",
  source: "lane-index:telemetry",
  sources: () => [{ path: runtimeDataPath("telemetry", "events.jsonl"), format: "jsonl" }],
  // illuci.observation.v1 is already a record superset; just ensure ts is set.
  toRecord: (raw) => ({ ...raw, ts: tsOf(raw) }),
};

export const OBSERVATIONS_ADAPTER = {
  lane: "observations",
  kind: "observations",
  authority: "operational",
  source: "lane-index:observations",
  // "observations" is a substrate project-data lane, not a DATA_KINDS kind, so the
  // path is resolved directly off the runtime data home.
  sources: () => [{ path: join(runtimeDataHome(), "observations", "records.jsonl"), format: "jsonl" }],
  toRecord: (raw) => ({
    id: raw.id,
    ts: tsOf(raw),
    kind: "observations",
    type: raw.type || "observation",
    source: raw.source || "lane-index:observations",
    ...pickLineage(raw),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    payload: raw,
  }),
};

export default [TELEMETRY_ADAPTER, OBSERVATIONS_ADAPTER];
