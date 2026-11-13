/**
 * Lane adapters — operational `illuci.<domain>.record/1` lanes ([A19] Phase 1).
 *
 * infrastructure (account-posture) and the gitops sublanes share the same dialect:
 * a `schema` + `timestamp` + a `subject`/body, with lineage often nested under
 * `subject`. pickLineage lifts lineage out of subject; the whole envelope is kept
 * as the payload so nothing is lost.
 */
import { runtimeDataPath } from "../../data/paths.js";
import { tsOf, pickLineage } from "./lane-adapter.js";

// Shared mapping for the illuci.X.record/1 family.
function driftRecord(kind, sourceTag) {
  return (raw) => ({
    id: raw.id,
    ts: tsOf(raw),
    kind,
    type: raw.type || (raw.subject && raw.subject.kind) || raw.schema || "record",
    source: raw.source || sourceTag,
    ...pickLineage(raw),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    payload: raw,
  });
}

export const INFRASTRUCTURE_ADAPTER = {
  lane: "infrastructure",
  kind: "infrastructure",
  authority: "operational",
  source: "lane-index:infrastructure",
  sources: () => [{ path: runtimeDataPath("infrastructure", "account-posture/records.jsonl"), format: "jsonl" }],
  toRecord: driftRecord("infrastructure", "lane-index:infrastructure"),
};

// Each gitops sublane writes its own records.jsonl (paths mirror the *_RECORDS_RELPATH
// constants in core/governance/gitops/*). All share the drift mapping.
const GITOPS_SUBLANES = [
  "pr-automation/records.jsonl",
  "pr-classifications/records.jsonl",
  "token-readiness/records.jsonl",
  "pr-outcome-observations/records.jsonl",
  "pr-outcomes/records.jsonl",
];

export const GITOPS_ADAPTER = {
  lane: "gitops",
  kind: "gitops",
  authority: "operational",
  source: "lane-index:gitops",
  sources: () => GITOPS_SUBLANES.map((rel) => ({ path: runtimeDataPath("gitops", rel), format: "jsonl" })),
  toRecord: driftRecord("gitops", "lane-index:gitops"),
};

export default [INFRASTRUCTURE_ADAPTER, GITOPS_ADAPTER];
