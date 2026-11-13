/**
 * illuci — Fleet reliability: the process singleton + persistence.
 *
 * One reliability store per process, persisted to ILLUCI_DATA_HOME/reliability.json
 * (atomic write) so learned standing survives service restarts — "over time you
 * get metrics based on model reliability" (operator). Recording and ranking are
 * gated by the DRL master flag: with DRL off the store is never written or read,
 * so seating is byte-identical to the pre-rebuild behavior (the golden-trace
 * determinism the sweep pins). Import-light: the store atom + node fs only.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createReliabilityStore } from "./reliability-store.js";
import { isDrlEnabled } from "../resilience/config.js";

function dataHome() {
  return process.env.ILLUCI_DATA_HOME || join(homedir(), ".illuci", "data");
}
function storePath() {
  return process.env.ILLUCI_RELIABILITY_PATH || join(dataHome(), "reliability.json");
}

function loadSnapshot() {
  try {
    const p = storePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8")) || {};
  } catch { return {}; }
}
function persistSnapshot(snap) {
  try {
    const p = storePath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, p); // atomic on the same volume
  } catch { /* best-effort — reliability persistence never breaks a dispatch */ }
}

// v1 keys reliability per MODEL (the operator's words: "metrics based on model
// reliability"), using one global bucket. The store stays (model, role)-capable
// so a later slice can split reliability per seat-role without a data migration.
export const GLOBAL_ROLE = "*";

// Debounced persistence: a long-running service records reliability on EVERY
// dispatch — writing the file each time is wasteful and, under a parallel test
// run, a flake surface. The in-memory map is authoritative within the process;
// disk is a durability convenience. So coalesce writes onto an unref'd timer
// (never holds the process open) plus a beforeExit flush for graceful shutdown.
const FLUSH_DEBOUNCE_MS = 2000;
let _pendingSnap = null;
let _flushTimer = null;
let _exitHooked = false;

function debouncedPersist(snap) {
  _pendingSnap = snap;
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    const s = _pendingSnap; _pendingSnap = null;
    if (s) persistSnapshot(s);
  }, FLUSH_DEBOUNCE_MS);
  if (typeof _flushTimer.unref === "function") _flushTimer.unref();
  if (!_exitHooked) {
    _exitHooked = true;
    try { process.once("beforeExit", () => { if (_pendingSnap) persistSnapshot(_pendingSnap); }); } catch { /* no process hook */ }
  }
}

let _store = null;
/** The lazily-created process singleton. */
export function reliabilityStore() {
  if (!_store) _store = createReliabilityStore({ load: loadSnapshot, persist: debouncedPersist });
  return _store;
}

/** Test seam: drop the singleton + any pending flush (the on-disk file is left alone). */
export function _resetReliabilityForTest() {
  _store = null;
  _pendingSnap = null;
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
}

/**
 * Record a dispatch outcome into per-model reliability. No-op unless DRL is
 * enabled. `success` should already reflect the breaker taxonomy — callers pass
 * `true` for a clean success and `false` for a terminal_failure; an `ignored`
 * outcome (transient/aborted/paused/blocked) must NOT be recorded (pass nothing).
 */
export function recordReliability(modelId, success, role = GLOBAL_ROLE) {
  if (!isDrlEnabled()) return;
  if (!modelId) return;
  try { reliabilityStore().record(modelId, role, !!success); } catch { /* never break dispatch */ }
}

/** Reliability score in [0,1] for a model; NEUTRAL (0.5) when DRL off or unseen. */
export function reliabilityScore(modelId, role = GLOBAL_ROLE) {
  if (!isDrlEnabled() || !modelId) return 0.5;
  try { return reliabilityStore().score(modelId, role); } catch { return 0.5; }
}

export default { reliabilityStore, recordReliability, reliabilityScore, _resetReliabilityForTest, GLOBAL_ROLE };
