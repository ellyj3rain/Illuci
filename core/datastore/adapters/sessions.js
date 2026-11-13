/**
 * Lane adapters — non-JSONL operational lanes ([A19] Phase 1).
 *
 * sessions are one immutable JSON object per file (stratum 4); pipeline-runs are
 * JSON payloads; runs are raw-text transcripts (one record per .raw.txt, with a
 * deterministic stableId so re-indexing never duplicates).
 */
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { runtimeDataHome } from "../../data/paths.js";
import { tsOf, pickLineage, stableId } from "./lane-adapter.js";

function listFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export const SESSIONS_ADAPTER = {
  lane: "sessions",
  kind: "sessions",
  authority: "operational",
  source: "lane-index:sessions",
  sources: () => listFiles(join(runtimeDataHome(), "sessions"), ".json").map((path) => ({ path, format: "json" })),
  toRecord: (raw) => ({
    id: raw.sessionId || raw.id,
    ts: raw.startedAt || raw.recordedAt || tsOf(raw),
    kind: "sessions",
    type: "session.record",
    sessionId: raw.sessionId || null,
    topologyId: raw.topologyId || null,
    ...pickLineage(raw),
    payload: raw,
  }),
};

export const PIPELINE_RUNS_ADAPTER = {
  lane: "pipeline-runs",
  kind: "pipeline-runs",
  authority: "operational",
  source: "lane-index:pipeline-runs",
  sources: () => listFiles(join(runtimeDataHome(), "pipeline-runs"), ".json").map((path) => ({ path, format: "json" })),
  toRecord: (raw, src) => ({
    id: raw.id || raw.runId || stableId("pln", src && src.path),
    ts: tsOf(raw),
    kind: "pipeline-runs",
    type: raw.status ? `pipeline.${raw.status}` : "pipeline.run",
    ...pickLineage(raw),
    payload: raw,
  }),
};

function runTextSources() {
  const base = join(runtimeDataHome(), "runs");
  if (!existsSync(base)) return [];
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const runDir of entries) {
    const full = join(base, runDir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of listFiles(full, ".raw.txt")) out.push({ path: f, format: "text", runId: runDir });
  }
  return out;
}

export const RUNS_ADAPTER = {
  lane: "runs",
  kind: "runs",
  authority: "operational",
  source: "lane-index:runs",
  sources: () => runTextSources(),
  // one record per transcript file; `raw` is the whole file text.
  toRecord: (raw, src) => ({
    id: stableId("run", src && src.path),
    kind: "runs",
    type: "run.transcript",
    runId: (src && src.runId) || null,
    payload: { path: (src && src.path) || null, text: typeof raw === "string" ? raw : (raw && raw.text) || "" },
  }),
};

export default [SESSIONS_ADAPTER, PIPELINE_RUNS_ADAPTER, RUNS_ADAPTER];
