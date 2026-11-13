import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { composeBehavioralDisposition, buildSeatAssignments } from "../composition/disposition-resolver.js";
import { resolveAgent } from "../composition/resolve-agent.js";
import {
  DISPOSITION_SURFACE_MAP,
  DISPOSITION_SURFACE_POSTURES,
  assertDispositionSurfaceMapCoverage,
  classifyDispositionSurfacePath,
  getDispositionSurface,
  listDispositionSurfaces,
} from "./disposition-surface-map.js";

function trackedPaths() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test("disposition map records are unique and tracked", () => {
  const coverage = assertDispositionSurfaceMapCoverage(trackedPaths());

  assert.deepEqual(coverage.duplicateIds, []);
  assert.deepEqual(coverage.invalidPostures, []);
  assert.deepEqual(coverage.missingPaths, []);
  assert.deepEqual(coverage.missingConsumers, []);
  assert.deepEqual(coverage.missingActiveSmoke, []);
  assert.equal(coverage.ok, true);
});

test("map helpers return defensive copies and classify active paths", () => {
  const entries = listDispositionSurfaces();
  entries[0].paths.push("not-real/");

  assert.equal(DISPOSITION_SURFACE_MAP[0].paths.includes("not-real/"), false);
  assert.deepEqual(getDispositionSurface("seat-disposition-resolver"), listDispositionSurfaces()[0]);
  assert.equal(
    classifyDispositionSurfacePath("core/composition/disposition-resolver.js")[0].id,
    "seat-disposition-resolver"
  );
});

test("postures preserve active, forward, and dark-forward lanes", () => {
  for (const posture of ["active-runtime", "forward-shim", "dark-forward"]) {
    assert.ok(DISPOSITION_SURFACE_POSTURES.includes(posture), `${posture} should be declared`);
    assert.ok(DISPOSITION_SURFACE_MAP.some((entry) => entry.posture === posture), `${posture} should be represented`);
  }
});

test("active dimensional disposition path composes disposition, role intent, and skills", async () => {
  const result = await composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "reviewer",
    seatDef: {},
    dispatchOpts: {
      seatDispositions: {
        reviewer: { presetId: "O5C6E0A2N4", role: "reviewer", skills: ["code-review"] },
      },
    },
  });

  assert.equal(result.engine, "dimensional");
  assert.match(result.block, /^\[Behavioral Disposition\]/);
  assert.ok(!result.block.includes("[Disposition:"), "disposition label is stripped (DR-162)");
  assert.match(result.block, /\[Role: /);
  assert.equal(result.meta.role, "reviewer");
  assert.equal(result.meta.matrixRole, "reviewer");
  assert.deepEqual(result.meta.skills, ["code-review"]);
  assert.equal(result.audit[0].source, "composition");
});

test("retired catalog disposition keys are rejected instead of preserved as compatibility", async () => {
  const retiredKey = "personalityTypeId";
  await assert.rejects(() => composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "analyst",
    seatDef: {},
    dispatchOpts: {
      seatDispositions: {
        analyst: { [retiredKey]: "analyst" },
      },
    },
  }), /retired disposition key/);
});

test("seat assignment summary preserves only active dimensional shapes", () => {
  const assignments = buildSeatAssignments({
    architect: { presetId: "O5C6E6A3N0", role: "implementer" },
  });

  assert.equal(assignments.architect.engine, "dimensional");
  assert.equal(assignments.architect.presetId, "O5C6E6A3N0");
  const retiredKey = "personalityTypeId";
  assert.throws(() => buildSeatAssignments({ analyst: { [retiredKey]: "analyst" } }), /retired disposition key/);
});

test("resolveAgent shim delegates disposition output without re-pointing runtime behavior", async () => {
  const dispatchOpts = {
    seatDispositions: {
      reviewer: { presetId: "O5C6E0A2N4", role: "reviewer" },
    },
  };
  const direct = await composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "reviewer",
    seatDef: {},
    dispatchOpts,
  });
  const resolved = await resolveAgent({
    modelId: "test-model",
    seatId: "reviewer",
    seatDef: {},
    dispatchOpts,
  });

  assert.equal(getDispositionSurface("agent-resolver-coherence-shim").posture, "forward-shim");
  assert.equal(resolved.layers.disposition, direct.block);
  assert.equal(resolved.preamble, direct.block);
  assert.equal(resolved.dispositionMeta.engine, "dimensional");
});
