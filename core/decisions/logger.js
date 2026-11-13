/**
 * illuci decision logger.
 *
 * Every runtime decision is stamped with human status, contributing model
 * status, timestamp, and context. New runtime data writes to the typed local
 * data root by default; committed seed/provenance logs remain readable so the
 * engine can use historical data without dirtying the source tree during tests
 * or normal runs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { committedProvenancePath, ensureRuntimeDataPath, runtimeDataPath } from "../data/paths.js";

const DECISIONS_FILE = "decisions.jsonl";

export function seedDecisionLogPath() {
  return committedProvenancePath("decisions", DECISIONS_FILE);
}

export function decisionLogPath() {
  if (process.env.ILLUCI_DECISIONS_FILE) return resolve(process.env.ILLUCI_DECISIONS_FILE);
  if (process.env.ILLUCI_DECISIONS_DIR) return resolve(process.env.ILLUCI_DECISIONS_DIR, DECISIONS_FILE);
  return runtimeDataPath("decisions", DECISIONS_FILE);
}

function ensureDecisionLogPath() {
  if (process.env.ILLUCI_DECISIONS_FILE || process.env.ILLUCI_DECISIONS_DIR) {
    const path = decisionLogPath();
    mkdirSync(dirname(path), { recursive: true });
    return path;
  }
  return ensureRuntimeDataPath("decisions", DECISIONS_FILE);
}

/**
 * Human status values.
 */
const VALID_HUMAN_STATUS = [
  "operator-initiated",
  "operator-approved",
  "operator-denied",
  "operator-absent",
  "operator-overridden",
];

/**
 * Log a decision with obligatory provenance.
 *
 * @param {object} decision
 * @param {string} decision.humanStatus
 * @param {object|object[]} decision.modelStatus
 * @param {string} decision.context
 * @param {string} decision.type
 * @param {string} decision.decision
 * @param {object} [decision.inputs]
 * @param {object} [decision.outputs]
 * @param {object} [decision.metadata]
 * @returns {object} The complete decision record with id and timestamp.
 */
export function logDecision(decision) {
  if (!decision.humanStatus) {
    throw new Error("Decision logging requires humanStatus - this is non-optional");
  }
  if (!VALID_HUMAN_STATUS.includes(decision.humanStatus)) {
    throw new Error(`Invalid humanStatus: ${decision.humanStatus}. Must be one of: ${VALID_HUMAN_STATUS.join(", ")}`);
  }
  if (!decision.modelStatus) {
    throw new Error("Decision logging requires modelStatus - this is non-optional");
  }
  if (!decision.context) {
    throw new Error("Decision logging requires context - this is non-optional");
  }
  if (!decision.type) {
    throw new Error("Decision logging requires type - this is non-optional");
  }
  if (!decision.decision) {
    throw new Error("Decision logging requires decision - this is non-optional");
  }

  const record = {
    id: `D-${Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    humanStatus: decision.humanStatus,
    modelStatus: Array.isArray(decision.modelStatus) ? decision.modelStatus : [decision.modelStatus],
    context: decision.context,
    type: decision.type,
    decision: decision.decision,
    inputs: decision.inputs || null,
    outputs: decision.outputs || null,
    metadata: decision.metadata || null,
  };

  appendFileSync(ensureDecisionLogPath(), JSON.stringify(record) + "\n", "utf-8");
  return record;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sourceFiles() {
  const seedPath = seedDecisionLogPath();
  const livePath = decisionLogPath();
  const files = [{ kind: "seed", path: seedPath }];
  if (livePath !== seedPath) files.push({ kind: "runtime", path: livePath });
  return files;
}

export function decisionLogSources() {
  return sourceFiles().map((source) => {
    const records = readJsonl(source.path);
    return {
      ...source,
      exists: existsSync(source.path),
      count: records.length,
    };
  });
}

/**
 * Read committed seed provenance plus the active runtime decision log.
 */
export function readDecisions(filter = {}) {
  const source = filter.source || "all";
  if (!["all", "seed", "runtime"].includes(source)) {
    throw new Error(`Invalid decision source: ${source}. Must be one of: all, seed, runtime`);
  }

  let files = sourceFiles();
  if (source !== "all") files = files.filter((file) => file.kind === source);
  let records = files.flatMap((file) =>
    readJsonl(file.path).map((record) =>
      filter.includeSource ? { ...record, _source: { kind: file.kind, path: file.path } } : record,
    ),
  );

  if (filter.type) records = records.filter((r) => r.type === filter.type);
  if (filter.humanStatus) records = records.filter((r) => r.humanStatus === filter.humanStatus);
  if (filter.since) {
    const since = new Date(filter.since).getTime();
    records = records.filter((r) => new Date(r.timestamp).getTime() >= since);
  }

  return records;
}

/**
 * Get the last N decisions.
 */
export function recentDecisions(n = 10, filter = {}) {
  return readDecisions(filter).slice(-n);
}

export { VALID_HUMAN_STATUS };
export default {
  logDecision,
  readDecisions,
  recentDecisions,
  decisionLogPath,
  seedDecisionLogPath,
  decisionLogSources,
  VALID_HUMAN_STATUS,
};
