// @ts-check
/**
 * illuci/core/topologies/runtime-topologies.js - the writable runtime topology-overlay store.
 *
 * A persisted, process-global overlay over the frozen topology registry (index.js TOPOLOGIES).
 * Runtime topology ids are additive-only when callers pass the canonical id set as reservedIds:
 * a runtime topology is a new authored topology, not a shadow of a source-owned topology.
 * Persisted to a home .illuci leaf (~/.illuci/topologies/runtime-topologies.json), process-global,
 * single-operator-tenant.
 *
 * A runtime topology carries the same shape the frozen ones do (id, name, description, seats[],
 * phases[]); createRuntimeTopology requires at least one seat and one phase to be a usable shape.
 *
 * [A33] `// @ts-check`'d against the typed spine — the accessors are declared to return the
 * canonical RuntimeTopologySpec, so drift between this store and core/contracts/topology.d.ts
 * is a compile error.
 *
 * @module core/topologies/runtime-topologies
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveIlluciHomeDir } from "../agents/home-dir.js";
import { validateRuntimeTopology } from "../contracts/runtime-topology-schema.js";

/** @typedef {import("../contracts/topology.d.ts").RuntimeTopologySpec} RuntimeTopologySpec */

const DEFAULT_STORE_FILE = "runtime-topologies.json";
const cache = new Map();

/** @param {{ storeFile?: string }} [options] @returns {string} */
function storeFile(options = {}) {
  return options.storeFile || process.env.ILLUCI_RUNTIME_TOPOLOGY_STORE || resolveIlluciHomeDir("topologies", DEFAULT_STORE_FILE);
}

/** @param {{ storeFile?: string }} [options] */
function load(options = {}) {
  const file = storeFile(options);
  if (cache.has(file)) return cache.get(file);
  if (!existsSync(file)) {
    const empty = { topologies: {} };
    cache.set(file, empty);
    return empty;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const store = parsed && typeof parsed === "object" && parsed.topologies && typeof parsed.topologies === "object"
      ? { topologies: parsed.topologies }
      : { topologies: {} };
    cache.set(file, store);
    return store;
  } catch {
    const empty = { topologies: {} };
    cache.set(file, empty);
    return empty;
  }
}

/** @param {{ storeFile?: string }} [options] */
function persist(options = {}) {
  const file = storeFile(options);
  const store = load(options);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2));
}

/** @param {{ reservedIds?: string[] }} [options] @returns {Set<string>} */
function reservedIdSet(options = {}) {
  return new Set(Array.isArray(options.reservedIds) ? options.reservedIds : []);
}

/**
 * Create (or replace) a runtime topology. Requires a non-empty id and at least one seat and one
 * phase. Additive-only when reservedIds are supplied: a runtime id may not shadow source canon.
 * Returns the stored topology, or null when invalid.
 *
 * @param {string} id
 * @param {{ name?: string, description?: string, seats?: object[], phases?: object[] }} [spec]
 * @param {{ storeFile?: string, reservedIds?: string[] }} [options]
 * @returns {RuntimeTopologySpec | null}
 */
export function createRuntimeTopology(id, spec = {}, options = {}) {
  if (typeof id !== "string") return null;
  const tid = id.trim();
  if (tid === "") return null;
  if (reservedIdSet(options).has(tid)) return null;
  const seats = Array.isArray(spec.seats) ? spec.seats : [];
  const phases = Array.isArray(spec.phases) ? spec.phases : [];
  if (seats.length === 0 || phases.length === 0) return null;
  // [A31] Deep border validation. The shallow checks above only prove id/arity; the
  // typed border schema rejects a genuinely-invalid runtime topology (a seat with an
  // out-of-range weight / unknown relationship type / unknown roleHint, or a malformed
  // phase) that would otherwise be stored and fail opaquely at run time. Superset-
  // preserving: the validator normalizes seats the way the runner does, so an under-
  // specified but defaultable seat is still accepted. Seats/phases are stored RAW.
  if (!validateRuntimeTopology({ id: tid, name: spec.name, description: spec.description, seats, phases }).ok) {
    return null;
  }
  const topology = {
    id: tid,
    name: typeof spec.name === "string" ? spec.name : tid,
    description: typeof spec.description === "string" ? spec.description : "",
    seats,
    phases,
    runtime: true,
  };
  const store = load(options);
  store.topologies[tid] = topology;
  persist(options);
  // Sound post-validation: the object passed the border schema, so it is a RuntimeTopologySpec
  // (seats/phases are raw object[] at the type level but validated at run time).
  return /** @type {RuntimeTopologySpec} */ (topology);
}

/**
 * The runtime topology for an id, or null if not a runtime topology OR the stored entry
 * fails the border schema. [A32] read-path defense-in-depth: a stored runtime topology that
 * no longer satisfies the border schema (a hand-edited ~/.illuci file, or an entry written
 * before the write-path guard) is treated as ABSENT rather than handed to the runner to
 * fail opaquely deep in a run. Superset-preserving via createSeat, so a defaultable stored
 * seat still loads. The file is never mutated — listRuntimeTopologies still shows the id so
 * the operator can see and remove it.
 *
 * @param {string} id
 * @param {{ storeFile?: string }} [options]
 * @returns {RuntimeTopologySpec | null}
 */
export function getRuntimeTopology(id, options = {}) {
  if (typeof id !== "string") return null;
  const topology = load(options).topologies[id] || null;
  if (topology && !validateRuntimeTopology(topology).ok) return null;
  return topology;
}

/**
 * Is this a runtime (overlay) topology id?
 * @param {string} id
 * @param {{ storeFile?: string }} [options]
 */
export function isRuntimeTopology(id, options = {}) {
  return getRuntimeTopology(id, options) !== null;
}

/**
 * All runtime topology ids (raw store inventory — includes an entry even if it fails the
 * border schema, so getRuntimeTopology returns null for it but the operator can still see it).
 * @param {{ storeFile?: string }} [options]
 * @returns {string[]}
 */
export function listRuntimeTopologies(options = {}) {
  return Object.keys(load(options).topologies);
}

/**
 * Remove a runtime topology (test cleanup). Returns whether one was removed.
 * @param {string} id
 * @param {{ storeFile?: string }} [options]
 * @returns {boolean}
 */
export function removeRuntimeTopology(id, options = {}) {
  const store = load(options);
  if (store.topologies[id]) { delete store.topologies[id]; persist(options); return true; }
  return false;
}

/** Drop the in-memory cache so the next read re-loads from disk (test hermeticity). */
export function _resetRuntimeTopologiesCache() { cache.clear(); }

export default { createRuntimeTopology, getRuntimeTopology, isRuntimeTopology, listRuntimeTopologies, removeRuntimeTopology };
