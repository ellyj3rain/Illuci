// node:test — remove_seat must not leave a single-seat phase pointing at a null/removed seat.
//
// Before the fix, mutateLiveTopology's "remove_seat" case set `phase.seat = null` for a
// single-seat phase whose only seat was being removed, leaving a `seat:null` phase that the
// runner's executeSingle (reads phase.seat directly) and the `phase.seats || [phase.seat]`
// extraction sites would dispatch/iterate against null. The fix drops that dead phase entirely
// while keeping parallel-phase behavior byte-identical (the seat is filtered out of `seats`,
// the phase is retained). These tests lock both halves: the hazard is gone, and a removal not
// referenced by any single-seat phase behaves exactly as before.
//
// vitest cannot run in this harness — node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerFreeformTopology,
  getTopology,
  mutateLiveTopology,
  compileGraph,
  getSeatModeRequirements,
  getSeatCapabilityDemand,
  TOPOLOGIES,
} from "./index.js";

// Register a fresh freeform topology, then override its phases with a deterministic fixture so
// the test controls exactly which phases are single-seat vs parallel (registerFreeformTopology's
// auto-layering is not the unit under test). The id is unique + deleted at the end so the global
// TOPOLOGIES registry is never polluted across tests.
function fixture(id, seats, phases) {
  registerFreeformTopology({ id, name: id, seats });
  getTopology(id).phases = phases;
  return getTopology(id);
}

test("remove_seat drops a single-seat phase pointing at the removed seat (no seat:null left behind)", () => {
  const TID = "__rmseat-single__";
  fixture(
    TID,
    [{ id: "alpha" }, { id: "beta" }],
    [
      // a parallel phase containing beta, plus beta's own single-seat phase
      { id: "p0", type: "parallel", seats: ["alpha", "beta"], input: "prompt", mode: "respond" },
      { id: "p1", type: "single", seat: "beta", input: "phase:p0", mode: "read" },
    ],
  );

  const res = mutateLiveTopology(TID, { type: "remove_seat", payload: { id: "beta" } });
  assert.equal(res.applied, true);

  const t = getTopology(TID);

  // (1) No phase is left pointing at a null or the removed seat — the core hazard.
  for (const ph of t.phases) {
    assert.notEqual(ph.seat, null, `phase ${ph.id} was left with seat:null`);
    assert.notEqual(ph.seat, "beta", `phase ${ph.id} still points at the removed seat`);
    if (ph.seats) assert.ok(!ph.seats.includes("beta"), `parallel phase ${ph.id} still lists beta`);
  }

  // The dead single-seat phase p1 was dropped entirely.
  assert.equal(t.phases.find((p) => p.id === "p1"), undefined, "single-seat phase p1 should be dropped");

  // The parallel phase p0 is RETAINED with beta filtered out (parallel behavior unchanged).
  const p0 = t.phases.find((p) => p.id === "p0");
  assert.ok(p0, "parallel phase p0 should remain");
  assert.deepEqual(p0.seats, ["alpha"]);

  // (2) compileGraph + the mode-requirement "dry run" stay consistent: the removed seat is gone
  // from the graph and no null/removed-seat key appears in the mode maps.
  const g = compileGraph(TID);
  assert.ok(!g.nodes.some((n) => n.id === "beta"), "compileGraph still emits the removed seat as a node");
  assert.ok(!g.nodes.some((n) => n.id === null), "compileGraph emits a null node");

  const reqs = getSeatModeRequirements(TID);
  assert.equal(reqs.has(null), false, "mode requirements contain a null seat key");
  assert.equal(reqs.has("beta"), false, "mode requirements still reference the removed seat");
  assert.equal(getSeatCapabilityDemand(TID, "beta"), null);
  assert.equal(getSeatCapabilityDemand(TID, null), null);

  // Simulate the runner's safe phase-iteration: no phase yields a null/removed participant.
  for (const ph of t.phases) {
    const seatIds = ph.seats || (ph.seat ? [ph.seat] : []);
    assert.ok(!seatIds.includes(null), `phase ${ph.id} iterates a null seat`);
    assert.ok(!seatIds.includes("beta"), `phase ${ph.id} iterates the removed seat`);
  }

  delete TOPOLOGIES[TID];
});

test("BACK-COMPAT: removing a seat referenced only by a parallel phase behaves exactly as today (filter, retain)", () => {
  const TID = "__rmseat-parallel-only__";
  fixture(
    TID,
    [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
    [
      { id: "p0", type: "parallel", seats: ["alpha", "beta", "gamma"], input: "prompt", mode: "respond" },
      { id: "p1", type: "single", seat: "alpha", input: "phase:p0" }, // gamma is in NO single-seat phase
    ],
  );

  const phasesBefore = getTopology(TID).phases.length;
  const res = mutateLiveTopology(TID, { type: "remove_seat", payload: { id: "gamma" } });
  assert.equal(res.applied, true);

  const t = getTopology(TID);
  // Same phase count (nothing dropped) — the parallel phase just loses gamma, as before the fix.
  assert.equal(t.phases.length, phasesBefore, "a parallel-only removal must not drop any phase");
  assert.deepEqual(t.phases.find((p) => p.id === "p0").seats, ["alpha", "beta"]);
  // The unrelated single-seat phase is untouched.
  assert.equal(t.phases.find((p) => p.id === "p1").seat, "alpha");

  delete TOPOLOGIES[TID];
});

test("BACK-COMPAT: removing a seat present in no phase changes no phase", () => {
  const TID = "__rmseat-no-phase__";
  fixture(
    TID,
    [{ id: "alpha" }, { id: "beta" }],
    [{ id: "p0", type: "single", seat: "alpha", input: "prompt" }], // beta is a seat but in no phase
  );

  const res = mutateLiveTopology(TID, { type: "remove_seat", payload: { id: "beta" } });
  assert.equal(res.applied, true);

  const t = getTopology(TID);
  assert.equal(t.phases.length, 1);
  assert.equal(t.phases[0].seat, "alpha");
  assert.equal(t.seats.find((s) => s.id === "beta"), undefined, "the seat itself should still be removed");

  delete TOPOLOGIES[TID];
});

test("remove_seat on an unknown seat is an unapplied error (unchanged behavior)", () => {
  const TID = "__rmseat-unknown__";
  fixture(TID, [{ id: "alpha" }], [{ id: "p0", type: "single", seat: "alpha", input: "prompt" }]);

  const res = mutateLiveTopology(TID, { type: "remove_seat", payload: { id: "nope" } });
  assert.equal(res.applied, false);
  assert.match(res.error, /not found/i);

  // Topology untouched.
  const t = getTopology(TID);
  assert.equal(t.phases.length, 1);
  assert.equal(t.seats.length, 1);

  delete TOPOLOGIES[TID];
});
