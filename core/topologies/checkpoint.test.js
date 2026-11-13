/**
 * illuci — Fire-Control Checkpoint tests (node:test)
 *
 * M4a acceptance: the dead semi/burst/auto vocabulary becomes the operator's
 * baton. Effective mode is the strictest seat; absent a port nothing blocks;
 * proceed/redirect/skip/abort behave; a flaky port never strands a run.
 *
 * Run: node --test illuci/core/topologies/checkpoint.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stepFiringMode, needsCheckpoint, resolveCheckpoint } from "./checkpoint.js";
import { buildMandate } from "./mandate.js";
import { getSeatFireControl } from "./index.js";

test("stepFiringMode is the STRICTEST seat (semi > burst > auto)", () => {
  const fc = { red: "auto", blue: "burst", arbiter: "semi" };
  assert.equal(stepFiringMode({ seats: ["red", "blue"] }, fc), "burst");
  assert.equal(stepFiringMode({ seats: ["red", "blue", "arbiter"] }, fc), "semi");
  assert.equal(stepFiringMode({ seat: "red" }, fc), "auto");
  assert.equal(stepFiringMode({ seat: "missing" }, fc), "auto", "unknown seat defaults auto");
});

test("needsCheckpoint only for semi/burst", () => {
  assert.equal(needsCheckpoint({ seat: "x" }, { x: "auto" }), false);
  assert.equal(needsCheckpoint({ seat: "x" }, { x: "burst" }), true);
  assert.equal(needsCheckpoint({ seat: "x" }, { x: "semi" }), true);
});

test("audit #1 regression: accepts getSeatFireControl's OBJECT shape, not only the mode string", () => {
  // The runner builds fireControl[seat] = getSeatFireControl(topologyId, seat), which
  // returns { firingMode, burstCount, stabilityThreshold } — an OBJECT. Read as a bare
  // string it was RANK[object] === undefined -> "auto", so no seat ever needed a
  // checkpoint and the entire fire-control surface was dead even when a port was supplied.
  const architect = getSeatFireControl("dev-team", "architect"); // dev-team seats architect: "semi"
  assert.equal(architect.firingMode, "semi", "precondition: getSeatFireControl returns the rich object");
  const fc = {
    architect,                                        // object, firingMode "semi"
    other: getSeatFireControl("dev-team", "unlisted"), // object, default firingMode "burst"
  };
  assert.equal(stepFiringMode({ seat: "architect" }, fc), "semi");
  assert.equal(needsCheckpoint({ seat: "architect" }, fc), true, "a semi seat needs a checkpoint from the object shape");
  assert.equal(needsCheckpoint({ seat: "other" }, fc), true, "a burst seat too");
  // strings still resolve (back-compat), and a mixed string+object map still takes the strictest
  assert.equal(stepFiringMode({ seats: ["architect", "other"] }, { architect: "auto", other: getSeatFireControl("dev-team", "unlisted") }), "burst");
});

const M = buildMandate({ prompt: "ship it" });

test("absent a port → proceed (headless/CLI never blocks)", async () => {
  const d = await resolveCheckpoint({ step: { seat: "x" }, firingMode: "semi", mandate: M, port: null });
  assert.deepEqual(d, { action: "proceed" });
});

test("the port receives the step + firing mode + mandate digest", async () => {
  let seen = null;
  await resolveCheckpoint({
    step: { id: "ruling", type: "single", seat: "arbiter" }, firingMode: "semi", mandate: M,
    port: async (ctx) => { seen = ctx; return { action: "proceed" }; },
  });
  assert.equal(seen.step.id, "ruling");
  assert.equal(seen.firingMode, "semi");
  assert.equal(seen.mandate.intent, "ship it");
});

test("redirect requires a non-empty intent; otherwise degrades to proceed", async () => {
  const ok = await resolveCheckpoint({ step: { seat: "x" }, firingMode: "semi", mandate: M, port: async () => ({ action: "redirect", intent: "actually, just review" }) });
  assert.deepEqual(ok, { action: "redirect", intent: "actually, just review" });
  const bad = await resolveCheckpoint({ step: { seat: "x" }, firingMode: "semi", mandate: M, port: async () => ({ action: "redirect" }) });
  assert.deepEqual(bad, { action: "proceed" }, "redirect with no intent is not actioned");
});

test("skip + abort pass through; unknown actions degrade to proceed", async () => {
  assert.deepEqual(await resolveCheckpoint({ step: {}, firingMode: "semi", mandate: M, port: async () => ({ action: "skip" }) }), { action: "skip" });
  assert.deepEqual(await resolveCheckpoint({ step: {}, firingMode: "semi", mandate: M, port: async () => ({ action: "abort" }) }), { action: "abort" });
  assert.deepEqual(await resolveCheckpoint({ step: {}, firingMode: "semi", mandate: M, port: async () => ({ action: "nonsense" }) }), { action: "proceed" });
});

test("a throwing port never strands the run (resolves proceed)", async () => {
  const d = await resolveCheckpoint({ step: {}, firingMode: "semi", mandate: M, port: async () => { throw new Error("UI died"); } });
  assert.deepEqual(d, { action: "proceed" });
});
