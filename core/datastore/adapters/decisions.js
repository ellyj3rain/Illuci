/**
 * Lane adapters — FILE-CANONICAL lanes, read-only projection ([A19] Phase 1).
 *
 * decisions (DR-004), governance/cognitive-classifications, and memory (AM-23) are
 * authoritative as files and are NEVER trunk-written. The indexer appends these
 * directly to the trunk (bypassing record-writer's write guard, which is the legal
 * path for a read-only projection) and markFileCanonical stamps each row so the
 * projection is auditable and never mistaken for writable state.
 */
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runtimeDataHome, runtimeDataPath } from "../../data/paths.js";
import { decisionLogPath, seedDecisionLogPath } from "../../decisions/logger.js";
import { tsOf, pickLineage, markFileCanonical, stableId } from "./lane-adapter.js";

export const DECISIONS_ADAPTER = {
  lane: "decisions",
  kind: "decisions",
  authority: "file-canonical",
  source: "file-canonical",
  // Both the committed seed log and the runtime log (reuses logger's path resolvers,
  // which honor ILLUCI_DECISIONS_FILE/_DIR).
  sources: () => {
    const paths = [...new Set([seedDecisionLogPath(), decisionLogPath()])];
    return paths.filter(existsSync).map((path) => ({ path, format: "jsonl" }));
  },
  toRecord: (raw) => markFileCanonical({
    id: raw.id || stableId("dec", raw.timestamp, raw.type, raw.decision),
    ts: tsOf(raw),
    kind: "decisions",
    type: raw.type || "decision",
    ...pickLineage(raw),
    payload: raw,
  }),
};

export const GOVERNANCE_ADAPTER = {
  lane: "governance",
  kind: "governance",
  authority: "file-canonical",
  source: "file-canonical",
  sources: () => [{ path: runtimeDataPath("governance", "cognitive-classifications/records.jsonl"), format: "jsonl" }],
  toRecord: (raw) => markFileCanonical({
    id: raw.id || stableId("gov", raw.timestamp, raw.schema),
    ts: tsOf(raw),
    kind: "governance",
    type: (raw.subject && raw.subject.kind) || raw.schema || "classification",
    ...pickLineage(raw),
    payload: raw,
  }),
};

// memory lessons: project.jsonl + agents/<slug>.jsonl + personas/<slug>.jsonl
function memorySources() {
  const out = [];
  const project = runtimeDataPath("memory", "project.jsonl");
  if (existsSync(project)) out.push({ path: project, format: "jsonl" });
  for (const sub of ["agents", "personas"]) {
    const dir = join(runtimeDataHome(), "memory", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) out.push({ path: join(dir, f), format: "jsonl" });
    }
  }
  return out;
}

export const MEMORY_ADAPTER = {
  lane: "memory",
  kind: "memory",
  authority: "file-canonical",
  source: "file-canonical",
  sources: () => memorySources(),
  toRecord: (raw) => markFileCanonical({
    id: raw.id || stableId("mem", tsOf(raw), JSON.stringify(raw).slice(0, 120)),
    ts: tsOf(raw),
    kind: "memory",
    type: raw.type || "lesson",
    ...pickLineage(raw),
    payload: raw,
  }),
};

export default [DECISIONS_ADAPTER, GOVERNANCE_ADAPTER, MEMORY_ADAPTER];
