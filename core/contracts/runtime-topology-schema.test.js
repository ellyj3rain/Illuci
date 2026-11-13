// node:test — the runtime-topology border schema (Zod trust-boundary validator).

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRuntimeTopology, phaseShapeErrors } from "./runtime-topology-schema.js";

/** A minimal, fully-valid runtime topology (one seat, one single phase). */
function validSpec(overrides = {}) {
  return {
    id: "my-runtime-topo",
    name: "My Runtime Topo",
    description: "authored past the frozen registry",
    seats: [
      { id: "worker", label: "Worker", min: 1, max: 1, roleHint: null, weight: 1.0, relationships: [] },
    ],
    phases: [
      { id: "run", type: "single", seat: "worker", input: "prompt" },
    ],
    ...overrides,
  };
}

test("a valid runtime topology passes and is normalized to the stored shape", () => {
  const result = validateRuntimeTopology(validSpec());
  assert.equal(result.ok, true);
  assert.equal(result.value.runtime, true);
  assert.equal(result.value.id, "my-runtime-topo");
  assert.equal(result.value.name, "My Runtime Topo");
  assert.equal(result.value.seats.length, 1);
  assert.equal(result.value.phases.length, 1);
});

test("name and description default the way createRuntimeTopology defaults them", () => {
  const result = validateRuntimeTopology(validSpec({ name: undefined, description: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "my-runtime-topo"); // name || id
  assert.equal(result.value.description, ""); // description || ""
});

test("normalize-then-validate: an under-specified but defaultable seat is accepted (superset)", () => {
  // No weight, no label — createSeat defaults both; the runner would normalize the same way.
  const result = validateRuntimeTopology(validSpec({
    seats: [{ id: "a", min: 1, max: 1, roleHint: "analyst", relationships: [] }],
  }));
  assert.equal(result.ok, true);
});

test("a fan-out phase (parallel over seats) is valid", () => {
  const spec = validSpec({
    seats: [
      { id: "a", label: "A", min: 1, max: 3, roleHint: "analyst", weight: 0.8, relationships: [] },
    ],
    phases: [{ id: "fan", type: "parallel", seats: ["a"], input: "prompt" }],
  });
  const result = validateRuntimeTopology(spec);
  assert.equal(result.ok, true);
});

test("missing / empty id is rejected", () => {
  assert.equal(validateRuntimeTopology(validSpec({ id: undefined })).ok, false);
  assert.equal(validateRuntimeTopology(validSpec({ id: "" })).ok, false);
  assert.equal(validateRuntimeTopology(validSpec({ id: "   " })).ok, false); // empty after trim
});

test("at least one seat and at least one phase are required", () => {
  const noSeats = validateRuntimeTopology(validSpec({ seats: [] }));
  assert.equal(noSeats.ok, false);
  assert.ok(noSeats.errors.some((e) => /at least one seat/.test(e)));

  const noPhases = validateRuntimeTopology(validSpec({ phases: [] }));
  assert.equal(noPhases.ok, false);
  assert.ok(noPhases.errors.some((e) => /at least one phase/.test(e)));
});

test("additive-only: a reserved (source-canon) id is rejected", () => {
  const result = validateRuntimeTopology(validSpec({ id: "direct" }), { reservedIds: ["direct", "dev-team"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /additive-only/.test(e)));
});

test("a malformed seat is rejected via the delegated validateSeat (no divergence)", () => {
  const badWeight = validateRuntimeTopology(validSpec({
    seats: [{ id: "x", label: "X", min: 1, max: 1, roleHint: null, weight: 5, relationships: [] }],
  }));
  assert.equal(badWeight.ok, false);
  assert.ok(badWeight.errors.some((e) => /weight/.test(e)));

  const badRel = validateRuntimeTopology(validSpec({
    seats: [{
      id: "x", label: "X", min: 1, max: 1, roleHint: null, weight: 1,
      relationships: [{ type: "not-a-real-edge", target: "x", semantics: "loops" }],
    }],
  }));
  assert.equal(badRel.ok, false);
  assert.ok(badRel.errors.some((e) => /relationship/.test(e)));
});

test("a phase with neither seat nor seats (or both) is rejected", () => {
  const neither = validateRuntimeTopology(validSpec({ phases: [{ id: "p", type: "single", input: "prompt" }] }));
  assert.equal(neither.ok, false);
  assert.ok(neither.errors.some((e) => /exactly one of seat/.test(e)));

  const both = validateRuntimeTopology(validSpec({
    phases: [{ id: "p", type: "single", seat: "worker", seats: ["worker"], input: "prompt" }],
  }));
  assert.equal(both.ok, false);
});

test("a phase with an unknown type is rejected", () => {
  const result = validateRuntimeTopology(validSpec({
    phases: [{ id: "p", type: "telepathy", seat: "worker", input: "prompt" }],
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /type/.test(e)));
});

test("phaseShapeErrors is a pure, exported unit (empty for a valid phase)", () => {
  assert.deepEqual(phaseShapeErrors({ id: "ok", type: "single", seat: "s", input: "prompt" }), []);
  assert.ok(phaseShapeErrors({ id: "bad", type: "single", input: "prompt" }).length > 0);
  assert.ok(phaseShapeErrors(null).length > 0);
});

test("non-object / garbage input never throws — it returns ok:false", () => {
  for (const junk of [null, undefined, 42, "topology", [], {}]) {
    const result = validateRuntimeTopology(junk);
    assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(junk)}`);
    assert.ok(Array.isArray(result.errors));
  }
});
