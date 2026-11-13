import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RUN_CONTROL,
  ToolAutonomyConfigError,
  deriveRunToolAutonomy,
  normalizeRunControl,
  phaseModeForRunControl,
  resolveToolAutonomy,
  runControlAgendaMode,
  runControlAutonomy,
  runControlBlocksPhaseMutation,
} from "./run-control.js";

test("normalizeRunControl returns the canonical default envelope", () => {
  assert.deepEqual(normalizeRunControl({}), DEFAULT_RUN_CONTROL);
});

test("normalizeRunControl composes agenda, execution, and tool autonomy independently", () => {
  const rc = normalizeRunControl({
    runControl: {
      agenda: { strategy: "ritual" },
      execution: { mutationAuthority: "blocked" },
      tools: { autonomy: "governed" },
    },
  });

  assert.equal(runControlAgendaMode(rc), "ritual");
  assert.equal(runControlAutonomy(rc), "governed");
  assert.equal(runControlBlocksPhaseMutation(rc), true);
  assert.equal(phaseModeForRunControl("write", rc), "respond");
  assert.equal(phaseModeForRunControl("read", rc), "read");
});

test("normalizeRunControl rejects malformed dimensions before dispatch", () => {
  assert.throws(() => normalizeRunControl({ runControl: [] }), /object/);
  assert.throws(() => normalizeRunControl({ runControl: { agenda: { strategy: "freeform" } } }), /agenda\.strategy/);
  assert.throws(() => normalizeRunControl({ runControl: { execution: { mutationAuthority: "anything" } } }), /mutationAuthority/);
  assert.throws(() => normalizeRunControl({ runControl: { tools: { autonomy: "idle" } } }), /tools\.autonomy/);
});

// [A96]/DR-189: the budget cascade rides the envelope, off by default, fail-closed.
test("normalizeRunControl: budget is null by default and normalizes a valid cascade", () => {
  assert.equal(normalizeRunControl({}).budget, null);
  const rc = normalizeRunControl({
    runControl: { budget: { member: { cap: 80000 }, seats: { arbiter: { floor: 20000 } }, reseatingMin: 4000 } },
  });
  assert.equal(rc.budget.memberCap, 80000);
  assert.deepEqual(rc.budget.seats.arbiter, { floor: 20000 });
  assert.equal(rc.budget.reseatingMin, 4000);
});

test("normalizeRunControl: a malformed budget stanza throws before dispatch (fail-closed, DR-129)", () => {
  assert.throws(() => normalizeRunControl({ runControl: { budget: 5 } }), /budget must be an object/);
  assert.throws(() => normalizeRunControl({ runControl: { budget: { member: { cap: -1 } } } }), /positive integer/);
  assert.throws(() => normalizeRunControl({ runControl: { budget: { seats: { x: { floor: 50, cap: 10 } } } } }), /floor 50 exceeds cap 10/);
});

test("tool autonomy resolves from the run-control envelope", () => {
  assert.deepEqual(resolveToolAutonomy("directed"), {
    level: "directed",
    seatLoop: false,
    checkpointRequired: false,
    capabilityPermitMandatory: false,
  });
  assert.throws(() => resolveToolAutonomy("checkpointed"), ToolAutonomyConfigError);
  const checkpointed = resolveToolAutonomy("checkpointed", { checkpointPort: async () => ({ action: "proceed" }) });
  assert.deepEqual([checkpointed.seatLoop, checkpointed.checkpointRequired], [true, true]);
  assert.deepEqual(resolveToolAutonomy("governed"), {
    level: "governed",
    seatLoop: true,
    checkpointRequired: false,
    capabilityPermitMandatory: true,
  });
});

test("deriveRunToolAutonomy preserves explicit seat-loop specificity", () => {
  const rc = normalizeRunControl({ runControl: { tools: { autonomy: "autonomous" } } });
  const derived = deriveRunToolAutonomy(rc, { seatLoop: ["architect"] });
  assert.deepEqual(derived.seatLoop, ["architect"]);
});
