/**
 * illuci — [A17.11] Golden traces: clean runs are adaptive-invariant (vitest, hermetic)
 *
 * The DR-113 D1 promise, executed: "Conservative default bounds keep a clean run
 * indistinguishable from a linear sweep." This is the FIRST test that actually
 * EXECUTES runTopology — every prior runner test was lexical (the AMD-8 pattern)
 * or shape-static. It runs EVERY registered topology end-to-end twice — once
 * adaptive-capable (the default), once pinned linear (`adaptive: false`) — over a
 * deterministic fake dispatch where every seat answers cleanly, and pins that the
 * two traces are semantically identical: same agenda, same phases in the same
 * order, same responses, same gate outcomes, no halt, and NO trace.adaptive on
 * either (the router is consulted only on gate FAIL; a never-rerouted run keeps
 * today's trace shape). If a future slice makes the adaptive machinery leak into
 * clean runs, this suite is the tripwire.
 *
 * Vitest lane (vi.mock on the ONE queryModel choke-point — runner.js dispatches
 * every seat through it, so mocking it makes the whole sweep hermetic: no bridge
 * calls, no model keys, no network). Runs ritual-mode (the authored order
 * bit-for-bit) and blocked mutation authority, with ILLUCI_HOME/ILLUCI_DATA_HOME
 * sandboxed for direct invocation parity
 * with scripts/run-test-lane.mjs.
 *
 * Run: npx vitest run core/topologies/runner.golden-trace.test.js
 */

import { describe, it, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";
import { join } from "node:path";

// Sandbox BEFORE any illuci module loads (all illuci imports below are dynamic): direct
// `npx vitest run` gets the same hermetic home the lane script provides.
process.env.ILLUCI_HOME ||= join(process.cwd(), ".tmp", "illuci-test-home");
process.env.ILLUCI_DATA_HOME ||= join(process.cwd(), ".tmp", "illuci-test-data");
process.env.ILLUCI_GATE_MODE ||= "headless";
// [A48]/DR-128: this sweep pins the STATIC (pre-reliability) seating baseline as
// the D1 executable tripwire. With DRL now default-ON, cross-topology reliability
// accrual would reorder later seatings and break byte-equality — so the baseline
// is pinned by holding DRL off explicitly. The DRL-on reliability ranking has its
// own dedicated coverage (seating reliability tests), not this determinism guard.
process.env.ILLUCI_DRL_ENABLED ||= "0";

// The deterministic clean fleet: every seat answers non-empty, error-free, with
// fixed usage — so every content gate passes and the router is never consulted.
// Response text is a pure function of the model id (no time, no randomness).
vi.mock("../dispatch/dispatch.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    queryModel: async (model) => ({
      model,
      response: `[golden:${model}] deterministic clean answer for the golden-trace sweep.`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      latency: 1,
    }),
  };
});

let runTopology;
let listTopologies;
let getTopology;
let MODEL_POOL;

beforeAll(async () => {
  ({ runTopology } = await import("./runner.js"));
  ({ listTopologies, getTopology } = await import("./index.js"));
  // The SOURCE-STATIC model roster (Object.keys of the matrix registry) — the
  // same on every host at the same commit, unlike availability-filtered views.
  const { MODELS } = await import("../matrix/capability-matrix.js");
  MODEL_POOL = [...MODELS].sort();
});

/**
 * The golden projection: every semantically load-bearing field of a trace, none
 * of the volatile ones (timestamps, latencies, token budgets, decision ids). A
 * clean run's projection must be IDENTICAL between adaptive-on and adaptive-off.
 *
 * Response entries are projected GENERICALLY (all fields minus the volatile set)
 * because phase executors emit two shapes: single/parallel/sequential entries
 * carry { seat, model, response, ... } while ROTATING entries carry
 * { round, facilitator, question, mergedArtifact } with no `response` field at
 * all (runner.js executeRotating) — both shapes are part of the golden contract.
 */
const VOLATILE_RESPONSE_KEYS = new Set(["usage", "latency", "latencyMs", "totalTokens", "durationMs", "duration"]);

function projectResponseEntry(entry) {
  if (!entry || typeof entry !== "object") return entry ?? null;
  return Object.fromEntries(Object.entries(entry).filter(([k]) => !VOLATILE_RESPONSE_KEYS.has(k)));
}

function goldenProjection(trace) {
  return {
    topologyId: trace.topologyId,
    agenda: { mode: trace.agenda?.mode ?? null, steps: trace.agenda?.steps ?? [] },
    phases: Object.fromEntries(
      Object.entries(trace.phases || {}).map(([id, p]) => [
        id,
        {
          responses: (p.responses || []).map(projectResponseEntry),
          gateStatus: p.gateStatus ?? null,
          gateReason: p.gateReason ?? null,
        },
      ]),
    ),
    halted: !!trace.halted,
    haltedAt: trace.haltedAt ?? null,
    haltReason: trace.haltReason ?? null,
    // Lazily attached only on a reroute — a clean run must never carry it.
    adaptive: trace.adaptive ?? null,
    // The step flow, order-sensitive; the volatile `t` and per-event payloads
    // (latencies, budgets) are deliberately not part of the golden shape.
    arrangementTypes: (trace.arrangement || []).map((e) => e.type),
  };
}

const RUN_OPTIONS = Object.freeze({
  // Ritual pins the authored phase order bit-for-bit (DR-114's golden baseline)
  // so the sweep exercises every authored phase without an anchor planning call.
  runControl: {
    agenda: { strategy: "ritual" },
    execution: { mutationAuthority: "blocked" },
    tools: { autonomy: "directed" },
  },
  // Respond-only: no tool mutations anywhere in the sweep (the safety posture —
  // identical on both runs, so the comparison is untouched).
  projectId: null,
});

/**
 * An explicit, deterministic lineup from the topology's OWN seat specs: every
 * declared seat gets exactly max(min, 1) REAL model ids cycled from the
 * source-static matrix roster. Explicit assignment wins over matrix auto-fill,
 * which is the point — the first CI run of this sweep failed on darwinian
 * ("organism requires at least 4, got 3") because auto-fill draws on the HOST's
 * resolvable fleet, which differs between environments; and synthetic ids die
 * in selection resolution (modelResourceId). Real ids + a source-pinned pool =
 * every resolution path exercised, identically, everywhere.
 */
function goldenLineup(topology) {
  const lineup = {};
  let slot = 0;
  for (const seat of topology.seats || []) {
    const count = Math.min(Math.max(seat.min || 0, 1), seat.max ?? Infinity);
    lineup[seat.id] = Array.from({ length: count }, () => MODEL_POOL[slot++ % MODEL_POOL.length]);
  }
  return lineup;
}

describe("A17.11 golden traces — clean runs are adaptive-invariant (DR-113 D1)", () => {
  it("the topology census is pinned (update deliberately when a topology lands)", async () => {
    assert.equal(listTopologies().length, 34, "the registry census changed — re-pin the golden sweep deliberately");
  });

  it(
    "every registered topology: a clean run is byte-equivalent between adaptive-default and pinned-linear, with no adaptive residue",
    { timeout: 180_000 },
    async () => {
      for (const id of listTopologies()) {
        const topology = getTopology(id);
        const authoredPhaseIds = (topology.phases || []).map((p) => p.id);

        // Distinct sessions per run so per-session registries (spawn tree, detached
        // runs) cannot bleed between the two runs or between topologies.
        const lineup = goldenLineup(topology);
        const onTrace = await runTopology(id, lineup, "Golden-trace sweep task.", { ...RUN_OPTIONS }, `golden-${id}-on`);
        const offTrace = await runTopology(id, lineup, "Golden-trace sweep task.", { ...RUN_OPTIONS, adaptive: false }, `golden-${id}-off`);

        for (const [label, trace] of [["adaptive-default", onTrace], ["pinned-linear", offTrace]]) {
          assert.ok(trace && typeof trace === "object", `${id}/${label}: run returned a trace`);
          assert.ok(!trace.halted, `${id}/${label}: a clean run must not halt (haltReason: ${trace.haltReason ?? "none"})`);
          assert.equal(trace.adaptive, undefined, `${id}/${label}: a never-rerouted run must not carry trace.adaptive`);
          for (const phaseId of authoredPhaseIds) {
            assert.ok(trace.phases[phaseId], `${id}/${label}: authored phase "${phaseId}" must execute in the ritual sweep`);
            const responses = trace.phases[phaseId].responses || [];
            assert.ok(responses.length > 0, `${id}/${label}/${phaseId}: at least one seat responded`);
            const phaseSpec = (topology.phases || []).find((p) => p.id === phaseId) || {};
            if (phaseSpec.type === "rotating") {
              // Rotating entries are round records ({ round, facilitator, question,
              // mergedArtifact }) — clean means every round has a facilitator question
              // and a merged artifact, and no error surfaced.
              assert.ok(
                responses.every((r) => !r.error && r.question && r.mergedArtifact),
                `${id}/${label}/${phaseId}: every rotating round clean (question + merged artifact, no error)`,
              );
            } else if (phaseSpec.dynamic === true) {
              // TODAY'S pinned behavior (found by this sweep's first execution, F-077):
              // dynamic seat resolution is UNIMPLEMENTED — market-auction's `execute`
              // (`seat: "awarded-bidder"`, the registry's only dynamic phase) always
              // yields executeSingle's honest empty-seat error entry, and being ungated
              // the run advances anyway. When dynamic seats are implemented, this arm
              // should fail and be removed deliberately.
              assert.ok(
                responses.every((r) => r.model === "none" && r.error && !r.response),
                `${id}/${label}/${phaseId}: a dynamic (unresolved) seat pins today's honest empty-seat error shape`,
              );
            } else {
              assert.ok(responses.every((r) => r.response && !r.error), `${id}/${label}/${phaseId}: every response clean`);
            }
          }
          const rerouteEvents = (trace.arrangement || []).filter((e) => e.type === "adaptive_route" || e.type === "halted");
          assert.equal(rerouteEvents.length, 0, `${id}/${label}: no adaptive_route/halted events on a clean run`);
        }

        assert.deepEqual(
          goldenProjection(onTrace),
          goldenProjection(offTrace),
          `${id}: the clean-run golden projection must be identical between adaptive-default and adaptive:false`,
        );
      }
    },
  );
});
