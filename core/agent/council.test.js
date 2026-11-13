/**
 * illuci Agent SDK — Council Adapter tests (Phase 7 adversarial fix: council cancellation)
 *
 * Hermetic: runTopology + onEvent are injected via deps, so no real model / emitter / bridge is
 * touched. node:test only (this lane does not introduce a vitest dependency).
 *
 * Primary coverage (the fix): session/cancel must halt a COUNCIL run, not just a single-agent one.
 * runCouncil threads job.signal into runTopology's options object; runTopology honors options.signal
 * (it flows to dispatchOpts.signal -> company.js composeSignals -> runMember/runSeatLoop). These
 * tests assert the signal is PASSED through and that an abort observed by the (fake) runTopology
 * actually stops it.
 *
 * vitest-incompatible (node:test `test`); run with:
 *   node --test illuci/core/agent/council.test.js
 * Do NOT port to vitest (note-not-fix, per the lane charter).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCouncil } from "./council.js";

// A minimal stream sink mirroring EventStream.push.
function makeStream() {
  const events = [];
  return { events, push: (e) => events.push(e) };
}

// A fake job mirroring run.js's job shape: { stream, runId, direction, context, config, signal }.
function makeJob({ signal = null, config = {}, intent = "do the thing" } = {}) {
  return {
    stream: makeStream(),
    runId: "run-1",
    direction: { intent },
    context: {},
    config: { coordination: "dev-team", ...config },
    signal,
  };
}

// ─── the fix: job.signal is threaded into runTopology's options ───

test("runCouncil PASSES job.signal into runTopology options (so session/cancel can halt a council)", async () => {
  let observedOptions = null;
  const ctrl = new AbortController();
  const fakeRunTopology = async (_topologyId, _lineup, _prompt, options) => {
    observedOptions = options;
    return { runId: "topo-run", halted: false, phases: { p1: { responses: [{ response: "ok", usage: { total_tokens: 1 } }] } } };
  };

  const job = makeJob({ signal: ctrl.signal });
  const out = await runCouncil(job, { runTopology: fakeRunTopology, onEvent: () => () => {} });

  assert.ok(observedOptions, "runTopology was invoked");
  assert.equal(observedOptions.signal, ctrl.signal, "the run's abort signal was threaded into runTopology options");
  assert.equal(out.ok, true);
});

test("runCouncil: an aborted signal observed by runTopology halts the council run", async () => {
  const ctrl = new AbortController();
  // A fake runTopology that WAITS on options.signal — exactly how the real runner's seats observe
  // cancellation — then returns a halted trace once aborted. If the signal were not threaded, this
  // would hang forever (and the test would time out), proving the wiring is load-bearing.
  const fakeRunTopology = (_topologyId, _lineup, _prompt, options) =>
    new Promise((resolve) => {
      const finish = () =>
        resolve({ runId: "topo-run", halted: true, haltReason: "aborted", phases: {} });
      if (options.signal?.aborted) return finish();
      options.signal?.addEventListener("abort", finish, { once: true });
    });

  const job = makeJob({ signal: ctrl.signal });
  const councilPromise = runCouncil(job, { runTopology: fakeRunTopology, onEvent: () => () => {} });

  // Fire the abort (what session/cancel does to the run controller). The fake run only resolves
  // because it observed the threaded signal.
  ctrl.abort(new Error("session/cancel"));

  const out = await councilPromise;
  assert.equal(out.halted, true, "the council run halted on abort");
  assert.equal(out.haltReason, "aborted");
  assert.equal(out.ok, false, "a halted run is not ok");
});

// ─── back-compat: a council with no signal still runs (signal is undefined, not required) ───

test("BACK-COMPAT: runCouncil with no job.signal threads undefined and runs normally", async () => {
  let observedOptions = null;
  const fakeRunTopology = async (_t, _l, _p, options) => {
    observedOptions = options;
    return { runId: "topo-run", halted: false, phases: { p1: { responses: [{ response: "done", usage: { total_tokens: 2 } }] } } };
  };
  // No signal on the job at all (a consumer that never wired cancellation).
  const job = { stream: makeStream(), runId: "run-x", direction: { intent: "x" }, context: {}, config: { coordination: "dev-team" } };
  const out = await runCouncil(job, { runTopology: fakeRunTopology, onEvent: () => () => {} });

  assert.equal(observedOptions.signal, undefined, "no signal supplied -> threaded as undefined (no throw)");
  assert.equal(out.ok, true);
  // The synthesis event was still pushed from the trace.
  assert.ok(job.stream.events.some((e) => e.type === "synthesis"), "synthesis surfaced from the trace");
});

test("BACK-COMPAT: config.topologyOptions still wins over the threaded signal (explicit per-call override)", async () => {
  let observedOptions = null;
  const overrideSignal = new AbortController().signal;
  const jobSignal = new AbortController().signal;
  const fakeRunTopology = async (_t, _l, _p, options) => {
    observedOptions = options;
    return { runId: "r", halted: false, phases: {} };
  };
  const job = makeJob({ signal: jobSignal, config: { topologyOptions: { signal: overrideSignal } } });
  await runCouncil(job, { runTopology: fakeRunTopology, onEvent: () => () => {} });

  assert.equal(observedOptions.signal, overrideSignal, "topologyOptions.signal (spread last) overrides the job signal");
});
