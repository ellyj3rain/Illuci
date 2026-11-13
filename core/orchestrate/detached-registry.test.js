/**
 * Phase 7 — same-loop detached-run registry. Hermetic: a fake runner (a hand-resolved
 * promise) stands in for runTopology, so every test is deterministic with no real dispatch.
 *
 * Covers the ratified-design risks head-on:
 *  - register returns the childRunId SYNCHRONOUSLY; the run is NOT awaited by the caller
 *  - status auto-flips running -> done / failed on settle
 *  - an unhandled rejection with NO collect caller yet attached never escapes (the internal
 *    .catch is attached synchronously at register())
 *  - await(timeoutMs) races a timer; the entry SURVIVES a timeout (still 'running')
 *  - multiple poll/await callers share ONE settlement (the runner runs once)
 *  - release frees a terminal entry, REFUSES a running one
 *  - disposeRegistry refuses a session with a run in flight, accepts a clean one
 *
 * vitest-incompatible (uses node:test's `test` + the singleton-map module state); run with
 *   node --test illuci/core/orchestrate/detached-registry.test.js
 * Do NOT port to vitest (note-not-fix, per the lane charter).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DetachedRunRegistry,
  getOrCreateRegistry,
  disposeRegistry,
  _resetRegistriesForTest,
} from "./detached-registry.js";

// A controllable fake run: returns a promise the test resolves/rejects on demand.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ─── register: synchronous return, detached kick, status auto-flip ───

test("register returns the childRunId synchronously and starts as 'running'", () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  let runnerInvoked = false;
  const id = reg.register({
    childRunId: "c1", topologyId: "dev-team", parentRunId: "p",
    runner: () => { runnerInvoked = true; return d.promise; },
  });
  assert.equal(id, "c1");
  assert.equal(runnerInvoked, true, "the runner is kicked on this loop");
  const snap = reg.poll("c1");
  assert.equal(snap.status, "running");
  assert.equal(snap.topologyId, "dev-team");
  assert.equal(snap.parentRunId, "p");
});

test("status auto-flips to 'done' on settle, result carried", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  assert.equal(reg.poll("c1").status, "running");
  d.resolve({ runId: "real-run-7", halted: false });
  const snap = await reg.await("c1", { timeoutMs: 100 });
  assert.equal(snap.status, "done");
  assert.equal(snap.result.runId, "real-run-7");
});

test("snapshot result is a COPY — a collector mutating it cannot corrupt the registry's stored trace", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  d.resolve({ runId: "real-run-7", halted: false, phases: { p1: { responses: ["a"] } } });
  await reg.await("c1", { timeoutMs: 100 });

  // First collector mutates the result it received.
  const first = reg.poll("c1");
  assert.equal(first.result.runId, "real-run-7");
  first.result.runId = "TAMPERED";
  first.result.phases.p1.responses.push("injected");
  delete first.result.halted;

  // A second collector must see the PRISTINE stored trace — the mutation stayed local.
  const second = reg.poll("c1");
  assert.equal(second.result.runId, "real-run-7", "top-level field unchanged by the prior collector");
  assert.equal(second.result.halted, false, "deleted field still present");
  assert.deepEqual(second.result.phases.p1.responses, ["a"], "nested array not mutated (deep copy)");
  // And the two snapshots are distinct objects (not the same reference).
  assert.notEqual(first.result, second.result, "each snapshot gets its own result object");
});

test("status auto-flips to 'failed' on rejection, error carried", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  d.reject(new Error("child blew up"));
  const snap = await reg.await("c1", { timeoutMs: 100 });
  assert.equal(snap.status, "failed");
  assert.match(snap.error, /child blew up/);
});

test("a synchronously-throwing runner is captured as a failure, never propagated to register", async () => {
  const reg = new DetachedRunRegistry("s");
  // register must NOT throw even though the runner throws synchronously.
  reg.register({ childRunId: "c1", runner: () => { throw new Error("sync boom"); } });
  const snap = await reg.await("c1", { timeoutMs: 100 });
  assert.equal(snap.status, "failed");
  assert.match(snap.error, /sync boom/);
});

// ─── the load-bearing risk: an orphaned rejection must never escape ───

test("a rejecting run with NO collect caller does not surface as an unhandled rejection", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  // Register and then NEVER poll/await before settle. The internal .catch (attached
  // synchronously at register) must handle the rejection so the loop does not crash.
  reg.register({ childRunId: "c1", runner: () => d.promise });
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);
  d.reject(new Error("orphaned"));
  // Let microtasks + a macrotask flush so any unhandledRejection would have fired.
  await new Promise((r) => setTimeout(r, 10));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null, "the registry handled the rejection internally");
  // And a LATER collect still reads the failure from the snapshot.
  assert.equal(reg.poll("c1").status, "failed");
});

// ─── await(timeoutMs): the entry survives a timeout ───

test("await with a timeout returns a 'running' snapshot and the entry SURVIVES", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred(); // never resolved within the timeout
  reg.register({ childRunId: "c1", runner: () => d.promise });
  const snap = await reg.await("c1", { timeoutMs: 5 });
  assert.equal(snap.status, "running", "timed out -> still running");
  // entry survives — a later await still finds it and can complete.
  d.resolve({ runId: "r" });
  const snap2 = await reg.await("c1", { timeoutMs: 100 });
  assert.equal(snap2.status, "done");
});

test("await with timeoutMs<=0 is a pure poll (no await)", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  const snap = await reg.await("c1", { timeoutMs: 0 });
  assert.equal(snap.status, "running");
});

// ─── shared settlement: the runner runs exactly once ───

test("multiple poll/await callers share ONE settlement; the runner is invoked once", async () => {
  const reg = new DetachedRunRegistry("s");
  let runs = 0;
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => { runs += 1; return d.promise; } });
  // several concurrent awaiters
  const a = reg.await("c1", { timeoutMs: 100 });
  const b = reg.await("c1", { timeoutMs: 100 });
  d.resolve({ runId: "r" });
  const [sa, sb] = await Promise.all([a, b]);
  assert.equal(runs, 1, "the runner ran once, not once-per-collector");
  assert.equal(sa.status, "done");
  assert.equal(sb.status, "done");
});

// ─── poll on an unknown / released id ───

test("poll on an unregistered id is 'unknown'", () => {
  const reg = new DetachedRunRegistry("s");
  assert.equal(reg.poll("ghost").status, "unknown");
});

// ─── release: frees terminal, refuses running ───

test("release refuses a running run, frees a terminal one", async () => {
  const reg = new DetachedRunRegistry("s");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  assert.equal(reg.release("c1"), false, "cannot release a live run");
  assert.equal(reg.poll("c1").status, "running");
  d.resolve({ runId: "r" });
  await reg.await("c1", { timeoutMs: 100 });
  assert.equal(reg.release("c1"), true, "terminal run released");
  assert.equal(reg.poll("c1").status, "unknown", "gone from the map");
});

test("release on an unknown id returns false", () => {
  const reg = new DetachedRunRegistry("s");
  assert.equal(reg.release("ghost"), false);
});

// ─── list + snapshot ───

test("list filters by parentRunId; snapshot counts running vs settled", async () => {
  const reg = new DetachedRunRegistry("s");
  const d1 = deferred(); const d2 = deferred();
  reg.register({ childRunId: "c1", parentRunId: "pA", runner: () => d1.promise });
  reg.register({ childRunId: "c2", parentRunId: "pB", runner: () => d2.promise });
  assert.equal(reg.list("pA").length, 1);
  assert.equal(reg.list().length, 2);
  let counts = reg.snapshot();
  assert.equal(counts.running, 2);
  assert.equal(counts.settled, 0);
  d1.resolve({ runId: "r" });
  await reg.await("c1", { timeoutMs: 100 });
  counts = reg.snapshot();
  assert.equal(counts.running, 1);
  assert.equal(counts.settled, 1);
});

// ─── duplicate / bad-args guards ───

test("register rejects a duplicate childRunId", () => {
  const reg = new DetachedRunRegistry("s");
  reg.register({ childRunId: "c1", runner: () => deferred().promise });
  assert.throws(() => reg.register({ childRunId: "c1", runner: () => deferred().promise }), /already registered/);
});

test("register requires a childRunId and a runner function", () => {
  const reg = new DetachedRunRegistry("s");
  assert.throws(() => reg.register({ runner: () => deferred().promise }), /childRunId/);
  assert.throws(() => reg.register({ childRunId: "c1" }), /runner/);
});

// ─── per-session singleton + dispose guard ───

test("getOrCreateRegistry returns one instance per session", () => {
  _resetRegistriesForTest();
  const a = getOrCreateRegistry("sess-1");
  const b = getOrCreateRegistry("sess-1");
  const c = getOrCreateRegistry("sess-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("disposeRegistry REFUSES a session with a run in flight, ACCEPTS a clean one", async () => {
  _resetRegistriesForTest();
  const reg = getOrCreateRegistry("sess-1");
  const d = deferred();
  reg.register({ childRunId: "c1", runner: () => d.promise });
  assert.equal(disposeRegistry("sess-1"), false, "live run -> refuse to drop");
  // same instance still returned (not orphaned)
  assert.equal(getOrCreateRegistry("sess-1"), reg);
  d.resolve({ runId: "r" });
  await reg.await("c1", { timeoutMs: 100 });
  assert.equal(disposeRegistry("sess-1"), true, "all terminal -> drop");
  // a fresh instance now
  assert.notEqual(getOrCreateRegistry("sess-1"), reg);
});

test("disposeRegistry on an unknown session is a no-op true", () => {
  _resetRegistriesForTest();
  assert.equal(disposeRegistry("never-seen"), true);
});
