/**
 * Runtime graph preset plan/run records.
 *
 * These records are local runtime data, not source canon. They make plan/run
 * outputs available for later analysis without committing traces or operator
 * state into the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveIlluciHomeDir } from "../agents/home-dir.js";

const DEFAULT_FILE = "graph-preset-records.json";
const TRANSCRIPT_DIR = "transcripts";
const cache = new Map();

function recordStoreFile(options = {}) {
  return options.recordStoreFile || process.env.ILLUCI_GRAPH_PRESET_RECORD_STORE || resolveIlluciHomeDir("presets", DEFAULT_FILE);
}

// The full run trace (every phase response at full length) is persisted to a
// per-run sibling file so a completed run's deliverable is recoverable from
// disk. The record store itself stays a compact index of resultSummaries; the
// heavy trace lives here, one file per record id. Default location sits beside
// the record store under the illuci home; ILLUCI_GRAPH_PRESET_TRANSCRIPT_DIR (or the
// transcriptDir option) relocates it for isolation/tests.
export function graphPresetTranscriptFile(recordId, options = {}) {
  if (options.transcriptFile) return options.transcriptFile;
  const dir =
    options.transcriptDir ||
    process.env.ILLUCI_GRAPH_PRESET_TRANSCRIPT_DIR ||
    resolveIlluciHomeDir("presets", TRANSCRIPT_DIR);
  return join(dir, `${recordId}.json`);
}

function emptyStore() {
  return { records: [] };
}

function loadStore(options = {}) {
  const file = recordStoreFile(options);
  if (cache.has(file)) return cache.get(file);
  if (!existsSync(file)) {
    const store = emptyStore();
    cache.set(file, store);
    return store;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const store = parsed && typeof parsed === "object" && Array.isArray(parsed.records)
      ? { records: parsed.records }
      : emptyStore();
    cache.set(file, store);
    return store;
  } catch {
    const store = emptyStore();
    cache.set(file, store);
    return store;
  }
}

function persistStore(options = {}) {
  const file = recordStoreFile(options);
  const store = loadStore(options);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2), "utf-8");
}

function nextRecordId(kind, now = new Date()) {
  return `${kind}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Pre-generate a record id so the runner can name the transcript file BEFORE the
// record is appended (the transcript filename is <recordId>.json).
export function newGraphPresetRecordId(kind, now = new Date()) {
  if (kind !== "plan" && kind !== "run") {
    throw new Error(`graph preset record kind must be plan or run; got ${kind}`);
  }
  return nextRecordId(kind, now);
}

// Persist the full run trace to the per-run transcript file. Returns the path
// and byte size so the runner can carry a pointer in the compact record. The
// trace is written verbatim (no truncation) — a completed run's deliverable is
// recoverable in full from this file. See DR-129 (explicit disclosed controls):
// the runner writes this by default and discloses the path; `--record-trace
// false` opts out.
export function writeGraphPresetTranscript(recordId, trace, options = {}) {
  const file = graphPresetTranscriptFile(recordId, options);
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify(trace, null, 2);
  writeFileSync(file, body, "utf-8");
  return { path: file, bytes: Buffer.byteLength(body, "utf-8") };
}

export function readGraphPresetTranscript(recordId, options = {}) {
  const file = graphPresetTranscriptFile(recordId, options);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function appendGraphPresetRecord(kind, payload = {}, options = {}) {
  if (kind !== "plan" && kind !== "run") {
    throw new Error(`graph preset record kind must be plan or run; got ${kind}`);
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const record = {
    id: options.recordId || nextRecordId(kind, now),
    kind,
    createdAt: now.toISOString(),
    ...payload,
  };
  const store = loadStore(options);
  store.records.push(record);
  persistStore(options);
  return record;
}

export function listGraphPresetRecords(options = {}) {
  const store = loadStore(options);
  return [...store.records];
}

export function _resetGraphPresetRecordStoreCache() {
  cache.clear();
}

export default {
  appendGraphPresetRecord,
  listGraphPresetRecords,
  newGraphPresetRecordId,
  graphPresetTranscriptFile,
  writeGraphPresetTranscript,
  readGraphPresetTranscript,
  _resetGraphPresetRecordStoreCache,
};
