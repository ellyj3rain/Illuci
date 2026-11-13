/**
 * illuci datastore — company writer. Persists the COMPANY-LEVEL records for a
 * CompanyResult: company.started + company.synthesis (the manifest: status,
 * counts, and per-member {index, topologyId, runId, status}). The per-member SEAT
 * outputs are persisted by run-writer at the runTopology seam (each member runs
 * through runTopology) and linked to this company by the shared sessionId — so
 * this writer does NOT re-emit them (no double-write). Deterministic ids →
 * idempotent. Fires at the orchestrate() seam. Never throws into the run.
 */
import { writeRecords } from "./record-writer.js";

export function persistCompany(result) {
  if (!result || typeof result !== "object") return [];
  const companyId = result.sessionId || null;
  if (!companyId) return [];
  const base = { companyId, sessionId: companyId, kind: "company" };
  const members = Array.isArray(result.members) ? result.members : [];

  const manifest = members.map((m) => ({
    index: m.index,
    topologyId: m.topologyId,
    runId: m.runId || null,
    status: m.status,
    error: m.error || null,
  }));

  const recs = [
    {
      ...base,
      id: `rec-co-${companyId}-started`,
      type: "company.started",
      spanKind: "AGENT",
      genAiOperation: "invoke_agent",
      payload: { members: manifest.map(({ index, topologyId }) => ({ index, topologyId })) },
    },
    {
      ...base,
      id: `rec-co-${companyId}-completed`,
      type: "company.synthesis",
      spanKind: "AGENT",
      payload: {
        status: result.status,
        counts: result.counts || null,
        aborted: !!result.aborted,
        members: manifest,
      },
    },
  ];

  return writeRecords(recs);
}

export default { persistCompany };
