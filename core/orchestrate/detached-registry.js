// Phase 7 — same-loop detached-run registry. The non-blocking complement to Phase 5's
// recursive spawn.
//
// Today a spawned child runs AWAITED INLINE: spawn.js does `const trace = await
// runTopology(...)`, so a seat's spawn_topology call can only return once the whole child
// run completes. That is fine for a fan-out-then-join sub-team, but it forecloses the
// "kick off a sub-team and keep working, collect its result later" pattern.
//
// This registry is that second pattern. It is a per-session map of in-flight child runs.
// `register()` stores a run as 'running', KICKS the runner (the same-loop promise, NOT
// awaited by the caller), synchronously attaches an internal .then/.catch that flips the
// status on settle, and returns the childRunId IMMEDIATELY. `poll()` is a non-blocking
// snapshot; `await()` races the stored promise against a timer (the entry survives a
// timeout). A later collect_topology call reads the snapshot by childRunId.
//
// SAME-LOOP, NOT ISOLATION. A detached child still shares THIS event loop — there is no
// worker thread and no child process here. A CPU-bound or tight-await child still degrades
// the parent's responsiveness; detached buys you a non-blocking *control flow*, not
// parallelism. True isolation is deferred to Phase F. Do not mistake detached for parallel.
//
// BOUNDING RIDES THE EXISTING TopologyTree. This registry adds NO new counter and mutates
// NO spawn.js accounting math. The reserve/commit/release discipline in spawn.js is the
// sole authority on depth/fan-out/active/total/cycle bounds. The registry adds only a
// per-session pending Set so disposeRegistry can refuse to drop a session that still holds
// a live promise.
//
// OPT-IN / ADDITIVE. Nothing imports this module until the runner threads it behind the
// already-existing dispatchOpts.spawn gate, and even then only when dispatchOpts
// .spawnDetached is armed. The awaited-spawn path stays byte-identical (it is the else
// branch in spawn.js).

const RUNNING = "running";
const DONE = "done";
const FAILED = "failed";
const UNKNOWN = "unknown";

/**
 * Copy a stored result before handing it to a collector, so a mutating collector cannot corrupt the
 * registry's single shared trace. Prefers a deep structuredClone; falls back to a shallow spread for
 * a non-cloneable trace (functions, AbortSignals, etc.) and passes through non-objects untouched.
 */
function copyResult(result) {
  if (result == null || typeof result !== "object") return result;
  try {
    return structuredClone(result);
  } catch {
    return Array.isArray(result) ? [...result] : { ...result };
  }
}

/**
 * A per-session registry of detached (same-loop, not-awaited-by-the-spawner) child runs.
 *
 * Entry shape: childRunId -> {
 *   status: 'running'|'done'|'failed',
 *   promise,                 // the single stored settlement promise (shared by all collectors)
 *   result,                  // the trace on 'done'
 *   error,                   // the Error message string on 'failed'
 *   startedAt, settledAt,    // epoch ms
 *   topologyId, parentRunId,
 * }
 */
export class DetachedRunRegistry {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.runs = new Map();   // childRunId -> entry
    this.pending = new Set(); // childRunIds still 'running' — the dispose guard
  }

  /**
   * Register a detached run and KICK it on this same loop. Synchronous return of the
   * childRunId; the runner is invoked but NOT awaited by the caller.
   *
   * The internal .then/.catch is attached SYNCHRONOUSLY here, before we return, for two
   * reasons: (1) a runner that rejects with no collect caller yet attached must never
   * surface as an unhandled rejection that crashes the loop — our .catch always handles
   * it; (2) the settle flips status + stashes result/error so a later poll/await reads a
   * terminal snapshot. The promise is stored once and reused, so multiple poll/await
   * callers share ONE settlement — the runner is never invoked twice.
   *
   * @param {object} a
   * @param {string} a.childRunId   — the registry key (minted by the caller before the run mints its real trace.runId)
   * @param {string} [a.topologyId]
   * @param {string} [a.parentRunId]
   * @param {() => Promise<any>} a.runner — the same-loop run, invoked detached
   * @returns {string} childRunId (synchronous)
   */
  register({ childRunId, topologyId = null, parentRunId = null, runner }) {
    if (!childRunId) throw new Error("detached-registry: register requires a childRunId");
    if (typeof runner !== "function") throw new Error("detached-registry: register requires a runner function");
    if (this.runs.has(childRunId)) throw new Error(`detached-registry: childRunId "${childRunId}" already registered`);

    const entry = {
      status: RUNNING,
      promise: null,
      result: undefined,
      error: null,
      startedAt: Date.now(),
      settledAt: null,
      topologyId,
      parentRunId,
    };

    // Kick the runner ON THIS LOOP. Wrap so a runner that throws SYNCHRONOUSLY (before
    // returning a promise) is captured as a rejection too, not propagated to the caller.
    let raw;
    try {
      raw = Promise.resolve(runner());
    } catch (err) {
      raw = Promise.reject(err);
    }

    // The single stored, internally-chained promise. Settling it flips status. The chain
    // RESOLVES (never rejects) so an await() caller racing it never has to try/catch the
    // shared promise — the error rides the snapshot.
    entry.promise = raw.then(
      (result) => {
        entry.status = DONE;
        entry.result = result;
        entry.settledAt = Date.now();
        this.pending.delete(childRunId);
        return entry;
      },
      (err) => {
        entry.status = FAILED;
        entry.error = String(err?.message || err);
        entry.settledAt = Date.now();
        this.pending.delete(childRunId);
        return entry;
      },
    );

    this.runs.set(childRunId, entry);
    this.pending.add(childRunId);
    return childRunId;
  }

  /** Non-blocking snapshot of one run. status 'unknown' if the id was never registered (or was released). */
  poll(childRunId) {
    const entry = this.runs.get(childRunId);
    if (!entry) return { status: UNKNOWN, childRunId };
    return this._snap(childRunId, entry);
  }

  /**
   * Await a run, bounded. timeoutMs <= 0 is a PURE poll (no await at all — identical to
   * poll). timeoutMs > 0 races the stored promise against a timer; on timeout the entry
   * SURVIVES (still 'running') and the snapshot reflects that, so a later collect can try
   * again. The shared promise means racing it does not re-run anything.
   */
  async await(childRunId, { timeoutMs = 0 } = {}) {
    const entry = this.runs.get(childRunId);
    if (!entry) return { status: UNKNOWN, childRunId };
    if (entry.status !== RUNNING || !(timeoutMs > 0)) {
      return this._snap(childRunId, entry);
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), timeoutMs);
    });
    try {
      await Promise.race([entry.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return this._snap(childRunId, entry);
  }

  /** Snapshot every run, optionally filtered to one parent. */
  list(parentRunId = null) {
    const out = [];
    for (const [id, entry] of this.runs) {
      if (parentRunId && entry.parentRunId !== parentRunId) continue;
      out.push(this._snap(id, entry));
    }
    return out;
  }

  /**
   * Drop a TERMINAL run from the map (the collect-on-terminal-read release that keeps a
   * long company run from accumulating settled entries unbounded). Refuses to drop a run
   * that is still 'running' — returns false — so a live promise is never orphaned.
   */
  release(childRunId) {
    const entry = this.runs.get(childRunId);
    if (!entry) return false;
    if (entry.status === RUNNING) return false;
    this.runs.delete(childRunId);
    return true;
  }

  /** Counts snapshot for observability. */
  snapshot() {
    let running = 0;
    let settled = 0;
    for (const entry of this.runs.values()) {
      if (entry.status === RUNNING) running += 1;
      else settled += 1;
    }
    return { sessionId: this.sessionId, running, settled };
  }

  /** True if any run is still in flight — the dispose guard reads this. */
  hasRunning() {
    return this.pending.size > 0;
  }

  _snap(childRunId, entry) {
    const snap = {
      childRunId,
      status: entry.status,
      topologyId: entry.topologyId,
      parentRunId: entry.parentRunId,
      startedAt: entry.startedAt,
      settledAt: entry.settledAt,
    };
    // Return the stored result by COPY, not by reference. The trace is stored once and shared by
    // every collect/poll/await caller; handing out the live object lets a collector that mutates
    // snap.result corrupt the registry's stored result for the next reader. A shallow copy makes
    // the top-level result immutable to collectors (structuredClone for a deep copy when the trace
    // is structured-cloneable; shallow spread as the fallback for a trace carrying non-cloneable
    // values such as functions/AbortSignals). error is a primitive string — no copy needed.
    if (entry.status === DONE) snap.result = copyResult(entry.result);
    if (entry.status === FAILED) snap.error = entry.error;
    return snap;
  }
}

// ── Per-session singleton map, mirroring spawn.js's _trees lifecycle exactly ──
const _registries = new Map();

/** Get (or lazily create) the per-session detached-run registry. */
export function getOrCreateRegistry(sessionId) {
  if (!_registries.has(sessionId)) _registries.set(sessionId, new DetachedRunRegistry(sessionId));
  return _registries.get(sessionId);
}

/**
 * Drop a session's registry. REFUSES (returns false, leaves the registry in place) if the
 * session still holds a run in flight — dropping it would orphan a live same-loop promise
 * and leak the TopologyTree active slot the runner's settle callback is waiting to free.
 * A clean session (all runs terminal, or empty) is dropped and returns true.
 */
export function disposeRegistry(sessionId) {
  const reg = _registries.get(sessionId);
  if (!reg) return true;
  if (reg.hasRunning()) return false;
  _registries.delete(sessionId);
  return true;
}

/** Test seam — wipe every session's registry (mirrors _resetTreesForTest). */
export function _resetRegistriesForTest() {
  _registries.clear();
}

export default {
  DetachedRunRegistry,
  getOrCreateRegistry,
  disposeRegistry,
  _resetRegistriesForTest,
};
