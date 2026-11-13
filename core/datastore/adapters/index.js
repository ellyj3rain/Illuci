/**
 * illuci datastore — lane adapter registry ([A19] Phase 1).
 *
 * The single place every indexed lane is enumerated. The universal indexer
 * (lane-index.js) iterates LANE_ADAPTERS; nothing else should hardcode the lane set.
 */
import OBSERVATIONS from "./observations.js";
import INFRASTRUCTURE from "./infrastructure.js";
import FILE_CANONICAL from "./decisions.js";
import NON_JSONL from "./sessions.js";

export const LANE_ADAPTERS = [
  ...OBSERVATIONS, // telemetry, observations
  ...INFRASTRUCTURE, // infrastructure, gitops
  ...FILE_CANONICAL, // decisions, governance, memory (read-only projection)
  ...NON_JSONL, // sessions, pipeline-runs, runs
];

export function adapterFor(lane) {
  return LANE_ADAPTERS.find((a) => a.lane === lane) || null;
}

export default LANE_ADAPTERS;
