/**
 * illuci — Agenda + cursor + arrangement-timeline tests (node:test)
 *
 * M2 acceptance: ritual mode preserves the authored phase ORDER bit-for-bit
 * for every registered topology (the golden-order check), the cursor's
 * mutation primitives behave (the M3/M4 surface), and the arrangement
 * timeline records ordered events.
 *
 * Run: node --test illuci/core/topologies/agenda.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgenda, createCursor, createArrangementTimeline } from "./agenda.js";
import { TOPOLOGIES, getTopology } from "./index.js";

test("GOLDEN ORDER: ritual agenda step ids equal the authored phases for EVERY topology", () => {
  for (const id of Object.keys(TOPOLOGIES)) {
    const topo = getTopology(id);
    const agenda = buildAgenda(topo, { mode: "ritual" });
    assert.deepEqual(
      agenda.steps.map((s) => s.id),
      (topo.phases || []).map((p) => p.id),
      `ritual order diverged for topology "${id}"`,
    );
    // step objects are the SAME shape the executors consume (identity-compatible)
    for (let i = 0; i < agenda.steps.length; i++) {
      assert.equal(agenda.steps[i].type, topo.phases[i].type, `step type diverged in "${id}"`);
      assert.equal(agenda.steps[i].input, topo.phases[i].input, `step input spec diverged in "${id}"`);
    }
  }
});

test("'conducted' (M4, not yet available) falls back HARD to ritual and records it", () => {
  const topo = getTopology("adversarial-debate");
  const agenda = buildAgenda(topo, { mode: "conducted" });
  assert.equal(agenda.mode, "ritual");
  assert.equal(agenda.fallback, true);
  assert.equal(agenda.requestedMode, "conducted");
  assert.deepEqual(agenda.steps.map((s) => s.id), topo.phases.map((p) => p.id));
});

test("cursor iterates in order and snapshots executed/pending", () => {
  const agenda = buildAgenda(getTopology("adversarial-debate"));
  const cursor = createCursor(agenda);
  const seen = [];
  while (cursor.hasNext()) seen.push(cursor.next().id);
  assert.deepEqual(seen, agenda.steps.map((s) => s.id));
  assert.deepEqual(cursor.snapshot().pending, []);
  assert.deepEqual(cursor.snapshot().executed, seen);
});

test("cursor.insert places a step next; skip removes a pending step; reorder respects id order", () => {
  const agenda = { steps: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] };
  const cursor = createCursor(agenda);
  assert.equal(cursor.next().id, "a");

  cursor.insert({ id: "x" });
  assert.equal(cursor.next().id, "x", "inserted step executes next");

  assert.equal(cursor.skip("c"), true);
  assert.equal(cursor.skip("zz"), false);

  cursor.reorder(["d", "b"]);
  const rest = [];
  while (cursor.hasNext()) rest.push(cursor.next().id);
  assert.deepEqual(rest, ["d", "b"], "remaining steps reordered; skipped step gone");
});

test("arrangement timeline records ordered, timestamped events", () => {
  const tl = createArrangementTimeline();
  tl.record("run_started", { charter: "adversarial-debate" });
  tl.record("step_started", { stepId: "opening" });
  tl.record("step_completed", { stepId: "opening", latency: 12 });
  assert.equal(tl.events.length, 3);
  assert.deepEqual(tl.events.map((e) => e.type), ["run_started", "step_started", "step_completed"]);
  assert.ok(tl.events.every((e) => typeof e.t === "string" && e.t.includes("T")));
  assert.equal(tl.events[1].stepId, "opening");
});
