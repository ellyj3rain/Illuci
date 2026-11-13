/**
 * illuci — Conductor (edge-rule deriver) tests (node:test)
 *
 * M3 acceptance: order is COMPUTED from relationship semantics, not array
 * index. The arbiter closes because its integrates-from edges make it a sink;
 * the executive brackets its reports because of parent-of; pure-lateral
 * councils have no derivable order and fall back to ritual.
 *
 * Run: node --test illuci/core/topologies/conductor.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveAgenda } from "./conductor.js";
import { buildAgenda } from "./agenda.js";
import { getTopology, TOPOLOGIES } from "./index.js";

test("adversarial-debate: arbiter CLOSES because integrates-from makes it a sink (not because it's phases[2])", () => {
  const d = deriveAgenda(getTopology("adversarial-debate"));
  assert.ok(d);
  const last = d.steps[d.steps.length - 1];
  assert.equal(last.type, "single");
  assert.equal(last.seat, "arbiter", "arbiter is the final, integrating step");
  // red+blue exchange before the ruling: two parallel layers of [red,blue] precede the arbiter
  const before = d.steps.slice(0, -1);
  assert.ok(before.every((s) => s.type === "parallel"));
  assert.ok(before.every((s) => s.seats.includes("red") && s.seats.includes("blue")));
  assert.equal(before.length, 2, "open + rebuttal exchange");
  // the ruling consumes the exchange, not the prompt alone
  assert.match(last.input, /phase:/);
});

test("corporate-hierarchy: executive BRACKETS its reports (brief first, synth last) via parent-of", () => {
  const d = deriveAgenda(getTopology("corporate-hierarchy"));
  assert.ok(d);
  const seatsInOrder = d.steps.map((s) => s.seat || s.seats);
  assert.equal(d.steps[0].seat, "executive", "executive briefs first");
  assert.equal(d.steps[d.steps.length - 1].seat, "executive", "executive synthesizes last");
  assert.ok(d.steps.some((s) => (s.seat || s.seats?.[0]) === "report"), "reports work in the middle");
  // the synth consumes the report layer
  assert.match(d.steps[d.steps.length - 1].input, /phase:report/);
});

test("devops-pipeline: precedes edges derive a linear chain ending at monitor", () => {
  const d = deriveAgenda(getTopology("devops-pipeline"));
  assert.ok(d);
  assert.equal(d.steps[0].seat, "build", "build is the source");
  assert.equal(d.steps[d.steps.length - 1].seat, "monitor", "monitor is the sink");
  // each non-root phase consumes a prior phase
  for (const s of d.steps.slice(1)) assert.match(s.input, /phase:/);
});

test("a pure-lateral council (no orderable edges) returns null → ritual fallback", () => {
  // find a topology whose edges are all lateral (peer-of/etc.) — deriveAgenda returns null
  let foundNull = false;
  for (const id of Object.keys(TOPOLOGIES)) {
    if (deriveAgenda(getTopology(id)) === null) {
      foundNull = true;
      // and buildAgenda('derived') falls back to ritual, recorded
      const a = buildAgenda(getTopology(id), { mode: "derived" });
      assert.equal(a.mode, "ritual");
      assert.equal(a.fallback, true);
      assert.equal(a.requestedMode, "derived");
      assert.deepEqual(a.steps.map((s) => s.id), getTopology(id).phases.map((p) => p.id));
      break;
    }
  }
  assert.ok(foundNull, "at least one topology has no derivable order (expected: pure-peer councils)");
});

test("buildAgenda('derived') yields derived mode with a non-empty plan where derivable", () => {
  const a = buildAgenda(getTopology("adversarial-debate"), { mode: "derived" });
  assert.equal(a.mode, "derived");
  assert.equal(a.fallback, false);
  assert.ok(a.steps.length >= 2);
  // derived order differs from ritual (different number/shape of phases is allowed and expected)
  const ritual = getTopology("adversarial-debate").phases.map((p) => p.id);
  const derived = a.steps.map((s) => s.id);
  assert.notDeepEqual(derived, ritual, "derived is a distinct plan, not the authored ritual");
});

test("every derived step has the exact shape the executors consume", () => {
  for (const id of Object.keys(TOPOLOGIES)) {
    const d = deriveAgenda(getTopology(id));
    if (!d) continue;
    for (const s of d.steps) {
      assert.ok(typeof s.id === "string" && s.id.length > 0);
      assert.ok(s.type === "single" || s.type === "parallel");
      assert.ok(typeof s.input === "string" && s.input.length > 0);
      if (s.type === "single") assert.ok(typeof s.seat === "string");
      else assert.ok(Array.isArray(s.seats) && s.seats.length >= 1);
    }
  }
});
