/**
 * Phase 4 — the concurrent composer (runCompany). Hermetic: a fake runTopology is
 * injected via deps, so no real model/bridge/filesystem. The tests are the mutator
 * survival matrix the darwinian cycle hardened the design against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompany, runPool, composeSignals } from "./company.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake runTopology that records its calls and returns a trace carrying a real runId
// (mirroring the augmented wrapper). topologyId "throws" rejects on the first phase.
function makeFake() {
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options, parentSessionId) => {
    calls.push({ topologyId, lineup, prompt, options, parentSessionId, awareness: options?.awareness });
    if (topologyId === "throws") throw new Error("first-phase boom");
    if (options?.signal?.aborted) {
      return { topologyId, runId: "run-" + topologyId, sessionId: parentSessionId, halted: true, haltReason: "aborted", phases: {} };
    }
    return { topologyId, runId: "run-" + topologyId, sessionId: parentSessionId, halted: false, phases: {} };
  };
  return { fn, calls };
}

// ─── Happy path: concurrent members, one company ───

test("runCompany runs members concurrently under one sessionId, awareness on, real runIds", async () => {
  const { fn, calls } = makeFake();
  const result = await runCompany(
    { topologies: [{ topologyId: "dev-team" }, { topologyId: "adversarial-debate" }] },
    { runTopology: fn },
  );
  assert.equal(result.status, "complete");
  assert.equal(result.ok, true);
  assert.equal(result.counts.ok, 2);
  // All members share the company sessionId (so they are bus siblings)…
  assert.ok(result.sessionId.startsWith("company-"));
  for (const c of calls) {
    assert.equal(c.parentSessionId, result.sessionId, "member ran under the company sessionId");
    assert.equal(c.awareness, true, "members are mutually aware by default");
  }
  // …and each carries the REAL runId captured from its trace (not a pre-mint).
  assert.deepEqual(result.members.map((m) => m.runId).sort(), ["run-adversarial-debate", "run-dev-team"]);
});

test("runCompany honors the concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const fn = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(15);
    active -= 1;
    return { runId: "r", phases: {} };
  };
  await runCompany(
    { topologies: Array.from({ length: 6 }, (_, i) => ({ topologyId: "t" + i })), concurrency: 2 },
    { runTopology: fn },
  );
  assert.ok(maxActive <= 2, "never more than the limit concurrent (saw " + maxActive + ")");
  assert.ok(maxActive >= 1);
});

// ─── Mutator survival matrix ───

test("mutator: a member that throws on its first phase is isolated, company continues (partial)", async () => {
  const { fn } = makeFake();
  const result = await runCompany(
    { topologies: [{ topologyId: "ok-1" }, { topologyId: "throws" }, { topologyId: "ok-2" }] },
    { runTopology: fn },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.counts.ok, 2);
  assert.equal(result.counts.errored, 1);
  const bad = result.members.find((m) => m.topologyId === "throws");
  assert.equal(bad.status, "error");
  assert.match(bad.error, /first-phase boom/);
});

test("mutator: an operator abort propagates to in-flight peers and short-circuits not-yet-started ones", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const fn = async (topologyId, lineup, prompt, options) => {
    calls.push(topologyId);
    await gate;
    if (options?.signal?.aborted) return { runId: "r", halted: true, haltReason: "aborted", phases: {} };
    return { runId: "r", halted: false, phases: {} };
  };
  // concurrency 1: member 0 starts and stalls; member 1 has not started yet.
  const p = runCompany(
    { topologies: [{ topologyId: "a" }, { topologyId: "b" }], concurrency: 1 },
    { runTopology: fn },
  );
  await delay(5);
  p.abort("operator stop");
  release();
  const result = await p;
  assert.equal(calls.length, 1, "the not-yet-started member never invoked runTopology");
  assert.equal(result.status, "aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.members.every((m) => m.status === "aborted"), true);
});

test("mutator: a degenerate company of exactly one runs", async () => {
  const { fn } = makeFake();
  const result = await runCompany({ topologies: [{ topologyId: "solo" }] }, { runTopology: fn });
  assert.equal(result.status, "complete");
  assert.equal(result.counts.total, 1);
  assert.equal(result.members[0].runId, "run-solo");
});

test("mutator: an invalid member (no topologyId) fails without crashing the company", async () => {
  const { fn } = makeFake();
  const result = await runCompany(
    { topologies: [{ topologyId: "good" }, { lineup: {} }] },
    { runTopology: fn },
  );
  assert.equal(result.status, "partial");
  const bad = result.members.find((m) => m.topologyId === null);
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /topologyId/);
});

test("council fix: a halt with the REAL operator-abort reason maps to aborted, not silently ok", async () => {
  // The old code guessed haltReason === "aborted"; the real reason is
  // "Operator aborted at fire-control checkpoint", so an aborted member was mislabeled "ok".
  const fn = async () => ({ runId: "r", halted: true, haltReason: "Operator aborted at fire-control checkpoint", phases: {} });
  const result = await runCompany({ topologies: [{ topologyId: "a" }] }, { runTopology: fn });
  assert.equal(result.members[0].status, "aborted");
});

test("a member that halts on budget is marked halted (not ok), company is partial", async () => {
  const fn = async (topologyId) =>
    topologyId === "broke"
      ? { runId: "r", halted: true, haltReason: "Token budget exhausted", phases: {} }
      : { runId: "r", halted: false, phases: {} };
  const result = await runCompany({ topologies: [{ topologyId: "good" }, { topologyId: "broke" }] }, { runTopology: fn });
  assert.equal(result.status, "partial");
  assert.equal(result.counts.halted, 1);
  const halted = result.members.find((m) => m.topologyId === "broke");
  assert.equal(halted.status, "halted");
  assert.match(halted.error, /budget/i);
});

// ─── Input validation + the control handle ───

test("runCompany rejects an empty company and a non-AbortSignal signal", () => {
  assert.throws(() => runCompany({ topologies: [] }), /non-empty array/);
  assert.throws(() => runCompany({ topologies: [{ topologyId: "x" }], signal: {} }), /AbortSignal/);
});

test("runCompany returns a control handle (abort, signal, sessionId)", async () => {
  const { fn } = makeFake();
  const p = runCompany({ topologies: [{ topologyId: "x" }] }, { runTopology: fn });
  assert.equal(typeof p.abort, "function");
  assert.ok(p.signal && typeof p.signal.aborted === "boolean");
  assert.ok(p.sessionId.startsWith("company-"));
  await p;
});

// ─── Unit: the concurrency + signal primitives ───

test("runPool preserves order, respects the limit, handles empty", async () => {
  assert.deepEqual(await runPool([], 4, async () => 1), []);
  const out = await runPool([1, 2, 3, 4], 2, async (n) => n * 10);
  assert.deepEqual(out, [10, 20, 30, 40]); // input order regardless of completion order
});

test("composeSignals aborts when either input aborts", () => {
  const a = new AbortController();
  const b = new AbortController();
  const composed = composeSignals(a.signal, b.signal);
  assert.equal(composed.aborted, false);
  b.abort("b tripped");
  assert.equal(composed.aborted, true);
  // single signal passes through; neither -> undefined
  assert.equal(composeSignals(a.signal, null), a.signal);
  assert.equal(composeSignals(null, undefined), undefined);
});

// ─── [A91]/DR-184 — the company-level childIdentity carry ───

test("A91: a company armed inherit threads agents + genome to members; member options win; default none threads nothing", async () => {
  const manifest = { agents: { "worker-a": {} } };
  const genome = { projectDir: "/p", childIdentity: "inherit" };
  const { fn, calls } = makeFake();
  await runCompany(
    {
      topologies: [
        { topologyId: "dev-team" },
        { topologyId: "adversarial-debate", options: { genome: { projectDir: "/member-own", childIdentity: "inherit" } } },
      ],
      genome,
      agents: manifest,
    },
    { runTopology: fn },
  );
  const byTopo = Object.fromEntries(calls.map((c) => [c.topologyId, c.options]));
  assert.deepEqual(byTopo["dev-team"].agents, manifest, "the shared manifest reached the bare member");
  assert.deepEqual(byTopo["dev-team"].genome, genome, "the genome control reached the bare member");
  assert.equal(byTopo["adversarial-debate"].genome.projectDir, "/member-own", "an explicit member option wins over the carry");

  const fake2 = makeFake();
  await runCompany({ topologies: [{ topologyId: "dev-team" }], genome: { projectDir: "/p" }, agents: manifest }, { runTopology: fake2.fn });
  assert.equal(fake2.calls[0].options.agents, undefined, "default none: nothing crosses");
  assert.equal(fake2.calls[0].options.genome, undefined);
});
