/**
 * Phase 7 — operator surface lane: the live operator console.
 *
 * Two layers:
 *  1. HERMETIC: every external (onEvent, getTree, getAdapter, sendCommand) injected as a
 *     fake, so the console runs with no emitter / tree / company / SSE server.
 *  2. BACK-COMPAT / NO-OP: drive the REAL emitter + REAL awareness store and prove the
 *     console only READS — it never alters emit ordering, listener set after dispose, tree
 *     counts, or the awareness ring. With the console unused the existing modules are
 *     provably unchanged.
 *
 * node:test (vitest files can't run under node --test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachOperatorConsole } from "./console.js";

// ── A fake emitter onEvent: a Set of listeners + a manual emit() — mirrors emitter.js. ──
function makeFakeEmitter() {
  const listeners = new Set();
  return {
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (event) => { for (const fn of listeners) fn(event); },
    listenerCount: () => listeners.size,
  };
}

// ── A fake tree mirroring TopologyTree's public surface (snapshot + .nodes Map). ──
function makeFakeTree(sessionId) {
  const nodes = new Map([
    ["root", { parentRunId: null, topologyId: "dev-team", active: true, depthRemaining: 3, children: new Set(["c1"]) }],
    ["c1", { parentRunId: "root", topologyId: "research-swarm", active: true, depthRemaining: 2, children: new Set() }],
  ]);
  return {
    sessionId,
    nodes,
    snapshot: () => ({ sessionId, activeCount: 2, totalChildren: 1, nodes: nodes.size }),
  };
}

function makeFakeAdapter(events) {
  return { recent: (limit) => events.slice(0, limit), name: () => "fake" };
}

const ev = (type, payload, sessionId = "company-1", time = 0) => ({ type, payload, sessionId, time });

// ─── Hermetic: push projection + subscribe ───

test("console subscribes to the emitter and projects events for its session", async () => {
  const emitter = makeFakeEmitter();
  const seen = [];
  const c = attachOperatorConsole({
    sessionId: "company-1",
    deps: { onEvent: emitter.onEvent },
  });
  c.subscribe(({ event }) => seen.push(event.type));

  emitter.emit(ev("topology_start", { topologyId: "dev-team", topologyName: "Dev Team" }));
  emitter.emit(ev("phase_start", { phaseId: "p1" }));
  emitter.emit(ev("phase_complete", { phaseId: "p1", totalTokens: 50 }));

  assert.deepEqual(seen, ["topology_start", "phase_start", "phase_complete"]);
  const events = c.getEvents({ limit: 10 });
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "phase_complete", "newest-first");
  c.dispose();
});

test("console FILTERS events to its own session (emitter is a global multiplexer)", () => {
  const emitter = makeFakeEmitter();
  const c = attachOperatorConsole({ sessionId: "company-1", deps: { onEvent: emitter.onEvent } });
  emitter.emit(ev("phase_start", { phaseId: "p1" }, "company-1"));
  emitter.emit(ev("phase_start", { phaseId: "p2" }, "company-OTHER"));
  emitter.emit(ev("phase_start", { phaseId: "p3" }, "company-1"));
  assert.equal(c.getEvents({ limit: 10 }).length, 2, "other company's events ignored");
  c.dispose();
});

test("getLiveState merges push projection + live tree pull + awareness pull", async () => {
  const emitter = makeFakeEmitter();
  const tree = makeFakeTree("company-1");
  const adapter = makeFakeAdapter([
    { id: "aw-1", company: "company-1", topologyId: "dev-team", kind: "dispatch.out", summary: "scanned repo" },
    { id: "aw-2", company: "company-OTHER", topologyId: "x", kind: "dispatch.out", summary: "noise" },
  ]);
  const c = attachOperatorConsole({
    sessionId: "company-1",
    deps: { onEvent: emitter.onEvent, getTree: () => tree, getAdapter: () => adapter },
  });
  emitter.emit(ev("topology_start", { topologyId: "dev-team", topologyName: "Dev Team" }));

  const live = await c.getLiveState();
  assert.equal(live.sessionId, "company-1");
  assert.equal(live.tree.activeCount, 2);
  assert.equal(live.tree.totalChildren, 1);
  assert.equal(live.nodes.length, 2, "enriched node view read from tree.nodes");
  assert.ok(live.nodes.find((n) => n.runId === "c1" && n.parentRunId === "root"));
  assert.equal(live.awareness.length, 1, "awareness filtered to this company");
  assert.equal(live.awareness[0].id, "aw-1");
  assert.equal(live.teams.length, 1);
  c.dispose();
});

test("getTreeNodes prefers a snapshotNodes() deep getter when the registry lane provides one", async () => {
  const emitter = makeFakeEmitter();
  const tree = {
    snapshot: () => ({ sessionId: "company-1", activeCount: 1, totalChildren: 0, nodes: 1 }),
    snapshotNodes: () => [{ runId: "r", parentRunId: null, topologyId: "dev-team", active: true, childRunIds: [] }],
    nodes: new Map(), // would yield [] if reached; prove snapshotNodes wins
  };
  const c = attachOperatorConsole({ sessionId: "company-1", deps: { onEvent: emitter.onEvent, getTree: () => tree } });
  const nodes = await c.getTreeNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].topologyId, "dev-team");
  c.dispose();
});

test("getRunState reflects the run signal and active count", async () => {
  const emitter = makeFakeEmitter();
  const ctrl = new AbortController();
  const tree = makeFakeTree("company-1");
  const c = attachOperatorConsole({
    sessionId: "company-1",
    signal: ctrl.signal,
    deps: { onEvent: emitter.onEvent, getTree: () => tree },
  });
  let st = await c.getRunState();
  assert.equal(st.aborted, false);
  assert.equal(st.activeCount, 2);
  assert.equal(st.status, "running");
  ctrl.abort("operator stop");
  st = await c.getRunState();
  assert.equal(st.aborted, true);
  assert.equal(st.status, "aborted");
});

// ─── Hermetic: control pass-through ───

test("abort() delegates ONLY to the handle's own abort; no handle → unavailable", () => {
  const emitter = makeFakeEmitter();
  let abortedWith = null;
  const handle = { sessionId: "company-1", abort: (r) => { abortedWith = r; }, signal: new AbortController().signal };
  const c = attachOperatorConsole({ handle, deps: { onEvent: emitter.onEvent } });
  const r = c.abort("operator stop");
  assert.deepEqual(r, { ok: true });
  assert.equal(abortedWith, "operator stop");
  c.dispose();

  const c2 = attachOperatorConsole({ sessionId: "no-handle", deps: { onEvent: emitter.onEvent } });
  const r2 = c2.abort("x");
  assert.equal(r2.ok, false);
  assert.equal(r2.unavailable, true);
  c2.dispose();
});

test("inject() is unavailable unless a command port is injected; never throws, no sse-server dep", async () => {
  const emitter = makeFakeEmitter();
  const c = attachOperatorConsole({ sessionId: "company-1", deps: { onEvent: emitter.onEvent } });
  assert.deepEqual(await c.inject("claude", "hello"), { unavailable: true });
  c.dispose();

  let cmd = null;
  const c2 = attachOperatorConsole({
    sessionId: "company-1",
    deps: { onEvent: emitter.onEvent, sendCommand: async (x) => { cmd = x; return { queued: true }; } },
  });
  const r = await c2.inject("claude", "hello");
  assert.deepEqual(r, { queued: true });
  // The verb is `inject_prompt` (the shape events/sse-server.js consumes), keyed by modelId+content.
  assert.deepEqual(cmd, { type: "inject_prompt", sessionId: "company-1", modelId: "claude", content: "hello" });
  c2.dispose();
});

// ─── Lifecycle ───

test("dispose() unsubscribes the emitter listener and is idempotent (no leak)", () => {
  const emitter = makeFakeEmitter();
  const c = attachOperatorConsole({ sessionId: "company-1", deps: { onEvent: emitter.onEvent } });
  assert.equal(emitter.listenerCount(), 1, "attached one listener");
  c.dispose();
  assert.equal(emitter.listenerCount(), 0, "listener removed");
  c.dispose(); // idempotent — must not throw
  assert.equal(c.disposed, true);
  // events after dispose are not projected
  emitter.emit(ev("phase_start", { phaseId: "late" }));
  assert.equal(c.getEvents({ limit: 5 }).length, 0);
});

test("an aborting run signal auto-disposes the console (sheds the listener)", () => {
  const emitter = makeFakeEmitter();
  const ctrl = new AbortController();
  const c = attachOperatorConsole({ sessionId: "company-1", signal: ctrl.signal, deps: { onEvent: emitter.onEvent } });
  assert.equal(emitter.listenerCount(), 1);
  ctrl.abort("stop");
  assert.equal(emitter.listenerCount(), 0, "auto-disposed on abort");
  assert.equal(c.disposed, true);
});

test("a faulty subscriber never breaks the projection bus", () => {
  const emitter = makeFakeEmitter();
  const c = attachOperatorConsole({ sessionId: "company-1", deps: { onEvent: emitter.onEvent } });
  c.subscribe(() => { throw new Error("subscriber boom"); });
  let goodSaw = 0;
  c.subscribe(() => { goodSaw += 1; });
  emitter.emit(ev("phase_start", { phaseId: "p1" }));
  assert.equal(goodSaw, 1, "the good subscriber still fired");
  assert.equal(c.getEvents({ limit: 5 }).length, 1, "projection still advanced");
  c.dispose();
});

// ─── BACK-COMPAT / NO-OP against the REAL modules ───

test("BACK-COMPAT: attaching to the REAL emitter only ADDS a listener, removed cleanly on dispose", async () => {
  const emitter = await import("../events/emitter.js");
  // Capture the listener count by emitting and counting our own deliveries is indirect;
  // instead prove dispose() removes exactly what attach added by re-emitting after dispose.
  const c = attachOperatorConsole({ sessionId: "bc-session-1", deps: { onEvent: emitter.onEvent } });
  emitter.emit({ type: "phase_start", payload: { phaseId: "p1" }, sessionId: "bc-session-1" });
  assert.equal(c.getEvents({ limit: 5 }).length, 1, "real emitter delivered to the console");
  c.dispose();
  // After dispose the listener is removed, so a further emit is NOT projected — the ring
  // stays at the one event already captured (p1), it does not grow to include p2.
  emitter.emit({ type: "phase_start", payload: { phaseId: "p2" }, sessionId: "bc-session-1" });
  const after = c.getEvents({ limit: 5 });
  assert.equal(after.length, 1, "post-dispose emit was dropped — ring did not grow");
  assert.equal(after[0].payload.phaseId, "p1", "the dropped p2 never entered the ring");
});

test("BACK-COMPAT: the console does not perturb OTHER real emitter listeners or emit ordering", async () => {
  const emitter = await import("../events/emitter.js");
  const order = [];
  const off = emitter.onEvent((e) => order.push("pre:" + e.payload?.phaseId));
  const c = attachOperatorConsole({ sessionId: "bc-session-2", deps: { onEvent: emitter.onEvent } });
  emitter.emit({ type: "phase_start", payload: { phaseId: "x" }, sessionId: "bc-session-2" });
  assert.deepEqual(order, ["pre:x"], "the pre-existing listener still fired exactly once, unaffected");
  c.dispose();
  off();
  // after both removed, emit reaches neither
  emitter.emit({ type: "phase_start", payload: { phaseId: "y" }, sessionId: "bc-session-2" });
  assert.deepEqual(order, ["pre:x"]);
});

test("BACK-COMPAT: reading the REAL awareness store via recent() does not append or mutate the ring", async () => {
  const store = await import("../awareness/store.js");
  store.reset();
  store.publish({ company: "bc-session-3", topologyId: "dev-team", kind: "dispatch.out", summary: "one" });
  store.publish({ company: "bc-session-3", topologyId: "research-swarm", kind: "dispatch.out", summary: "two" });
  const before = store.getAdapter().recent(100).length;

  const emitter = await import("../events/emitter.js");
  const c = attachOperatorConsole({ sessionId: "bc-session-3", deps: { onEvent: emitter.onEvent } });
  const aware = await c.getAwareness({ limit: 10 });
  assert.equal(aware.length, 2, "read both company events");

  const after = store.getAdapter().recent(100).length;
  assert.equal(after, before, "recent() is a pure read — ring length unchanged");
  c.dispose();
  store.reset();
});

test("BACK-COMPAT: reading the REAL tree via getOrCreateTree is idempotent and never mutates counts", async () => {
  const spawn = await import("../orchestrate/spawn.js");
  spawn._resetTreesForTest();
  const tree = spawn.getOrCreateTree("bc-session-4");
  tree.registerRoot("root-run", "dev-team");
  const snapBefore = tree.snapshot();

  const emitter = await import("../events/emitter.js");
  const c = attachOperatorConsole({ sessionId: "bc-session-4", deps: { onEvent: emitter.onEvent } });
  const snap = await c.getTreeSnapshot();
  const nodes = await c.getTreeNodes();
  assert.equal(snap.sessionId, "bc-session-4");
  assert.equal(nodes.length, 1, "read the registered root node");
  assert.equal(nodes[0].runId, "root-run");

  const snapAfter = tree.snapshot();
  assert.deepEqual(snapAfter, snapBefore, "tree counts unchanged — console is read-only on the tree");
  c.dispose();
  spawn._resetTreesForTest();
});

test("READ-ONLY: observing a session with NO pre-created tree never inserts an orphan (peekTree, not getOrCreateTree)", async () => {
  const spawn = await import("../orchestrate/spawn.js");
  spawn._resetTreesForTest();
  const sid = "no-tree-session";
  // The registry has no tree for this session — a flat company that never spawned.
  assert.equal(spawn.peekTree(sid), null, "precondition: no tree exists for this session");

  const emitter = await import("../events/emitter.js");
  // Attach with ONLY onEvent injected, so getTree resolves to the live default. Under the old
  // getOrCreateTree default this pull would INSERT an orphan tree; under peekTree it creates nothing.
  const c = attachOperatorConsole({ sessionId: sid, deps: { onEvent: emitter.onEvent } });

  // Drive the read paths that pull the tree.
  await c.getRunState();
  await c.getLiveState();
  await c.getTreeSnapshot();
  await c.getTreeNodes();

  // The registry must NOT have gained an orphan tree for this session — before and after the pulls.
  assert.equal(spawn.peekTree(sid), null, "no orphan tree was inserted by observing a flat company");
  c.dispose();
  spawn._resetTreesForTest();
});
