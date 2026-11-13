// Phase 7 — operator surface lane: the live operator API (the core of the lane).
//
// attachOperatorConsole({ handle, sessionId, signal, deps }) -> OperatorConsole.
//
// A NON-MC operator surface over a LIVE topology tree. GREENFIELD. It pulls EVERY datum
// through public APIs already exported by emitter.js, spawn.js, awareness/store.js, and
// the runCompany() handle. It edits NONE of them — onEvent only ADDS a Set listener
// (removed cleanly on dispose), getOrCreateTree(sessionId) is idempotent and only READ
// (snapshot + the public .nodes Map, never reserve/commit/release/registerNode), and the
// awareness adapter is read via .recent() (a pure ring read, no append). Control is opt-in
// pass-through: abort() calls the handle's OWN already-public abort; inject() is
// unavailable unless a command port is explicitly injected.
//
// Every external is INJECTED via a deps seam with a LIVE default (mirroring company.js /
// spawn.js test conventions), so the module is pure/headless and node:test-friendly with
// fakes — no SSE HTTP server, no live company required. With the console unused, nothing
// in the codebase imports this file, so every existing council/dispatch/company path
// loads and runs byte-identically.
//
// READ-ONLY ON THE TREE: the tree is read via spawn.peekTree(sessionId) — a NON-creating
// lookup that returns null when no tree exists. getOrCreateTree (which INSERTS a tree) is NOT
// used, so observing a flat company that never spawned leaks no orphan tree into the registry.
//
// IN-PROCESS CONSTRAINT: emitter.onEvent is in-process only (cross-process events arrive
// via postToRemote, not onEvent); the tree + awareness reads are also in-process. So a
// console must be attached IN THE SAME PROCESS as the runCompany it observes. This matches
// how sse-server consumes onEvent. Documented, not worked-around.

import { initialState, reduceEvent, buildLiveState } from "./state.js";

const DEFAULT_EVENT_RING = 512;

/** Resolve the live default deps lazily, so importing this module pulls in nothing until used. */
async function resolveDeps(deps = {}) {
  const resolved = { ...deps };
  if (!resolved.getTree) {
    const spawn = await import("../orchestrate/spawn.js");
    // peekTree (NOT getOrCreateTree): a read-only observer must never INSERT a tree. Watching a
    // flat company that never spawned would otherwise leak an orphan tree into the registry and
    // break the console's read-only contract. peekTree returns null when no tree exists yet.
    resolved.getTree = spawn.peekTree;
  }
  if (!resolved.onEvent) {
    const emitter = await import("../events/emitter.js");
    resolved.onEvent = emitter.onEvent;
  }
  if (!resolved.getAdapter) {
    const store = await import("../awareness/store.js");
    resolved.getAdapter = store.getAdapter;
  }
  // sendCommand is intentionally NOT defaulted: inject() is unavailable unless a command
  // port is explicitly injected (no static dependency on sse-server, no new control authority).
  return resolved;
}

/**
 * Attach a live operator console to a running company.
 *
 * Synchronous: the emitter subscription is wired immediately if onEvent is injected (or as
 * soon as the lazy default resolves). The returned console is usable right away; pulls that
 * need a not-yet-resolved live default await internally.
 *
 * @param {object}      opts
 * @param {object|null} opts.handle    — the runCompany() return { abort, signal, sessionId }
 * @param {string|null} opts.sessionId — falls back to handle.sessionId (the bus/tree grouping key)
 * @param {AbortSignal|null} opts.signal — falls back to handle.signal (read-only liveness flag)
 * @param {object}      opts.deps      — { getTree, onEvent, getAdapter, sendCommand } injection seam
 * @param {number}      opts.eventRing — bounded recent-event ring size (default 512)
 * @returns {OperatorConsole}
 */
export function attachOperatorConsole({ handle = null, sessionId = null, signal = null, deps = {}, eventRing = DEFAULT_EVENT_RING } = {}) {
  const sid = sessionId ?? handle?.sessionId ?? null;
  const liveSignal = signal ?? handle?.signal ?? null;
  const ringCap = Math.max(1, eventRing | 0);

  // ── push projection state ──
  let projection = initialState(sid);
  const events = [];                 // bounded ring of raw events for THIS session (oldest→newest)
  const subscribers = new Set();     // fan-out: fn({ event, delta })
  let unsubscribeEmitter = null;     // the emitter onEvent teardown
  let disposed = false;
  let depsP = null;                  // memoized resolved deps

  function getDeps() {
    if (!depsP) depsP = resolveDeps(deps);
    return depsP;
  }

  // The emitter is a global unfiltered multiplexer (it calls every listener for every
  // run's events). We filter by sessionId ourselves — an early cheap check.
  function onEmit(event) {
    if (disposed) return;
    if (!event || typeof event !== "object") return;
    // Only project events for THIS company session. (When sid is null — no handle given —
    // we accept all, so a test or a single-company process still sees its trace.)
    if (sid != null && event.sessionId != null && event.sessionId !== sid) return;

    projection = reduceEvent(projection, event);
    if (projection.startedAt == null) projection.startedAt = Date.now();

    events.push(event);
    while (events.length > ringCap) events.shift();

    const delta = { eventCount: projection.eventCount, lastEventTs: projection.lastEventTs };
    for (const fn of subscribers) {
      try { fn({ event, delta, state: projection }); } catch { /* a subscriber fault never breaks the bus */ }
    }
    // NOTE on auto-dispose: a long-lived process (the ACP server) attaching a console per
    // company would leak emitter listeners if it never disposed. We do NOT auto-dispose on
    // topology_complete here — a multi-member company emits one per member, so the first
    // would tear down the console mid-run. Disposal is the caller's contract (dispose() is
    // mandatory) plus the abort auto-dispose wired below. dispose() is idempotent and safe.
  }

  // Wire the subscription. If onEvent is injected (tests), wire synchronously; otherwise
  // resolve the live default then wire (still effectively immediate).
  if (typeof deps.onEvent === "function") {
    unsubscribeEmitter = deps.onEvent(onEmit);
  } else {
    getDeps().then((d) => {
      if (disposed) return;        // disposed before the async wire landed — never attach
      unsubscribeEmitter = d.onEvent(onEmit);
    }).catch(() => { /* emitter unavailable — push trace simply stays empty */ });
  }

  // Auto-dispose when the run's signal aborts, so an aborted company sheds its listener.
  if (liveSignal && typeof liveSignal.addEventListener === "function") {
    liveSignal.addEventListener("abort", () => { try { api.dispose(); } catch { /* idempotent */ } }, { once: true });
  }

  // ── live pulls (read-only on shared modules) ──

  async function readTree() {
    if (sid == null) return null;
    const d = await getDeps();
    try {
      // NON-creating peek (spawn.peekTree by default). null means "no tree yet" — the company is
      // flat / hasn't spawned. We create NOTHING: getTreeSnapshot/getTreeNodes treat null as an
      // empty/zero snapshot, so observing a flat company never leaks an orphan tree.
      const tree = d.getTree(sid);
      return tree || null;
    } catch { return null; }
  }

  async function getTreeSnapshot() {
    const tree = await readTree();
    if (!tree || typeof tree.snapshot !== "function") {
      return { sessionId: sid, activeCount: 0, totalChildren: 0, nodes: 0 };
    }
    try { return tree.snapshot(); } catch { return { sessionId: sid, activeCount: 0, totalChildren: 0, nodes: 0 }; }
  }

  // FOLLOW-UP (risk #1): TopologyTree.snapshot() returns only scalar counts; the rich
  // per-node map (tree.nodes) has no public deep getter. Reading the public .nodes Map is
  // legal + read-only, but reaching into another module's internal Map is a coupling smell.
  // CLEANER: spawn.js gains snapshotNodes() — spawn.js is the registry lane's file and that
  // lane is already adding a registry module, so we PROPOSE snapshotNodes() to them rather
  // than this lane editing spawn.js. Until then, read defensively below. If the registry
  // lane lands tree.snapshotNodes(), prefer it automatically.
  async function getTreeNodes() {
    const tree = await readTree();
    if (!tree) return [];
    try {
      if (typeof tree.snapshotNodes === "function") {
        // Registry lane's deep getter, if/when it lands — preferred, no internal reach.
        return tree.snapshotNodes();
      }
      const map = tree.nodes;
      if (!map || typeof map.entries !== "function") return [];
      return Array.from(map.entries()).map(([runId, n]) => ({
        runId,
        parentRunId: n.parentRunId ?? null,
        topologyId: n.topologyId ?? null,
        active: n.active !== false,
        depthRemaining: typeof n.depthRemaining === "number" ? n.depthRemaining : null,
        childRunIds: n.children ? Array.from(n.children) : [],
      }));
    } catch { return []; }
  }

  async function getAwareness({ limit = 32 } = {}) {
    const d = await getDeps();
    try {
      const adapter = d.getAdapter && d.getAdapter();
      if (!adapter || typeof adapter.recent !== "function") return [];
      // recent() is newest-first, UNBUDGETED (operator view, not a seat frame). Filter to
      // this company; NOT store.recall() (that is seat-frame-budgeted and excludes self).
      const window = adapter.recent(Math.max(limit * 4, 64));
      const filtered = sid == null ? window : window.filter((e) => e && e.company === sid);
      return filtered.slice(0, Math.max(0, limit | 0));
    } catch { return []; }
  }

  // ── public API ──
  const api = {
    // ── observe (push) ──
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    async getLiveState() {
      const [snapshot, nodes, awareness] = await Promise.all([
        getTreeSnapshot(),
        getTreeNodes(),
        getAwareness({ limit: 16 }),
      ]);
      return buildLiveState(projection, snapshot, nodes, awareness);
    },

    getEvents({ limit = 50 } = {}) {
      const n = Math.max(0, limit | 0);
      // newest-first
      return events.slice(Math.max(0, events.length - n)).reverse();
    },

    // ── query (pull, read-only on shared modules) ──
    getTreeSnapshot,
    getTreeNodes,
    getAwareness,

    async getRunState() {
      const snapshot = await getTreeSnapshot();
      return {
        sessionId: sid,
        aborted: liveSignal?.aborted ?? false,
        activeCount: snapshot.activeCount ?? 0,
        status: (liveSignal?.aborted ?? false) ? "aborted" : (disposed ? "detached" : "running"),
      };
    },

    // ── control (delegates ONLY to handles already exposed for control) ──
    abort(reason) {
      if (handle && typeof handle.abort === "function") {
        handle.abort(reason);
        return { ok: true };
      }
      return { ok: false, unavailable: true, detail: "no handle with abort() was provided" };
    },

    async inject(modelId, content) {
      // Soft, opt-in: delegates to deps.sendCommand if (and only if) a command port was
      // injected. Absent it, returns { unavailable } — never throws, never hard-deps
      // sse-server, introduces no new control authority.
      const d = await getDeps();
      const send = d.sendCommand;
      if (typeof send !== "function") return { unavailable: true };
      try {
        // The command shape the only real port (events/sse-server.js) consumes: the
        // `inject_prompt` verb keyed by modelId + content (sse-server.js:253-264). Sending the
        // old `{ type: 'inject' }` would silently no-op against that port. sessionId is carried
        // for any port that wants to scope by session; sse-server keys by its activeSession.
        const r = await send({ type: "inject_prompt", sessionId: sid, modelId, content });
        return r && typeof r === "object" ? r : { queued: true };
      } catch (err) {
        return { unavailable: true, error: String(err?.message || err) };
      }
    },

    // ── lifecycle ──
    dispose() {
      if (disposed) return;          // idempotent
      disposed = true;
      try { if (typeof unsubscribeEmitter === "function") unsubscribeEmitter(); } catch { /* ignore */ }
      unsubscribeEmitter = null;
      subscribers.clear();
    },

    // ── introspection (no shared-state access; for callers/tests) ──
    get sessionId() { return sid; },
    get disposed() { return disposed; },
  };

  return api;
}

export default { attachOperatorConsole };
