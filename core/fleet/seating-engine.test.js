// core/fleet/seating-engine.test.js — [A48]/DR-128
import test from "node:test";
import assert from "node:assert/strict";
import { seatRole, MIN_CANDIDATES } from "./seating-engine.js";

const healthyAll = () => true;

test("ranks healthy candidates by reliability; the most reliable is seated", () => {
  const r = seatRole({
    role: "auditor",
    candidates: ["kimi-cloud", "deepseek", "qwen3.5"],
    isHealthy: healthyAll,
    reliabilityScore: (m) => ({ "kimi-cloud": 0.9, deepseek: 0.7, "qwen3.5": 0.5 })[m],
  });
  assert.equal(r.seated, "kimi-cloud");
  assert.deepEqual(r.ranked.map((x) => x.model), ["kimi-cloud", "deepseek", "qwen3.5"]);
  assert.equal(r.invariant.ok, true);
});

test("KILLS THE LIE: an unhealthy (installed-but-dead) lane is never seated", () => {
  const dead = new Set(["claude-sonnet", "grok-build"]); // present but 402 / no-headless
  const r = seatRole({
    role: "architect",
    candidates: ["claude-sonnet", "grok-build", "deepseek", "kimi-cloud"],
    isHealthy: (m) => !dead.has(m),
    reliabilityScore: () => 0.5,
  });
  assert.ok(!r.ranked.some((x) => dead.has(x.model)), "dead lanes excluded from the ranking");
  assert.deepEqual(r.unhealthy.sort(), ["claude-sonnet", "grok-build"]);
  assert.ok(["deepseek", "kimi-cloud"].includes(r.seated));
});

test("no-exclusive-candidates: a role only ONE model declares is a data-bug invariant miss", () => {
  const r = seatRole({ role: "auditor", candidates: ["claude-sonnet"], isHealthy: healthyAll });
  assert.equal(r.invariant.ok, false);
  assert.equal(r.invariant.code, "exclusive-candidate");
  assert.equal(r.invariant.declaredCount, 1);
});

test("single-healthy-candidate: declared-by-many but only one live => degraded, flagged, still seats", () => {
  const r = seatRole({
    role: "architect",
    candidates: ["a", "b", "c"],
    isHealthy: (m) => m === "b",
    reliabilityScore: () => 0.5,
  });
  assert.equal(r.seated, "b", "still seats the lone survivor");
  assert.equal(r.invariant.code, "single-healthy-candidate");
  assert.equal(r.invariant.ok, false);
});

test("no-healthy-candidate: declared-by-many but none live => nothing seated, flagged", () => {
  const r = seatRole({ role: "x", candidates: ["a", "b"], isHealthy: () => false });
  assert.equal(r.seated, null);
  assert.equal(r.invariant.code, "no-healthy-candidate");
});

test("tiebreak breaks equal scores deterministically (no lock-in on model name alone)", () => {
  const r = seatRole({
    role: "r", candidates: ["a", "b", "c"], isHealthy: healthyAll,
    reliabilityScore: () => 0.5, tiebreak: (m) => ({ a: 1, b: 3, c: 2 })[m],
  });
  assert.equal(r.seated, "b");
});

test("MIN_CANDIDATES is the 2-model floor", () => {
  assert.equal(MIN_CANDIDATES, 2);
});
