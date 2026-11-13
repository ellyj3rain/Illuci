import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSeatDispositions,
  collectTopologySeatIdsByIds,
  validateSeatDispositions,
} from "./seat-disposition-config.js";

test("global disposition config fans out across every supplied seat", () => {
  const seatDispositions = buildSeatDispositions({
    seatIds: ["architect", "implementer", "reviewer", "qa"],
    globalConfig: { presetId: "executive", role: "implementer", skills: ["code-review"] },
  });

  assert.deepEqual(Object.keys(seatDispositions), ["architect", "implementer", "reviewer", "qa"]);
  assert.deepEqual(seatDispositions.qa, { presetId: "executive", role: "implementer", skills: ["code-review"] });
});

test("per-seat disposition config overrides the global config", () => {
  const seatDispositions = buildSeatDispositions({
    seatIds: ["architect", "reviewer"],
    globalConfig: { presetId: "executive", role: "implementer" },
    perSeatConfig: { reviewer: { presetId: "critic", skills: "security-audit" } },
  });

  assert.deepEqual(seatDispositions.architect, { presetId: "executive", role: "implementer" });
  assert.deepEqual(seatDispositions.reviewer, { presetId: "critic", role: "implementer", skills: ["security-audit"] });
});

test("topology seat collection returns the union across company members", () => {
  const topologies = {
    alpha: { seats: [{ id: "a" }, { id: "b" }] },
    beta: { seats: [{ id: "b" }, { id: "c" }] },
  };

  assert.deepEqual(collectTopologySeatIdsByIds(topologies, ["alpha", "beta"]), ["a", "b", "c"]);
});

test("disposition validation catches preset, role, profile, and skill drift", () => {
  const errors = validateSeatDispositions({
    a: { presetId: "not-a-preset" },
    b: { role: "not-a-role" },
    c: { skills: ["not-a-skill"] },
    d: { profile: { facets: { "C1-Competence": 2 } } },
  });

  assert.deepEqual(errors.map((error) => error.kind), ["preset", "role", "skills", "profile"]);
});

test("disposition validation rejects retired prototype keys", () => {
  const retiredKey = "personalityTypeId";
  const errors = validateSeatDispositions({
    reviewer: { [retiredKey]: "analyst" },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "ontology");
  assert.deepEqual(errors[0].keys, [retiredKey]);
});
