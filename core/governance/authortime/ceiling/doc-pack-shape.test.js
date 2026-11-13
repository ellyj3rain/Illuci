// node:test - the doc-pack SHAPE ceiling rule (advisory tier-judgment, complement of the
// ../doc-pack.js floor atom). Judges the TIER of a change to a pack root's membership; never blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDocPackShape } from "./doc-pack-shape.js";

const FULL = [
  "MEMORY.md",
  "CORE.md",
  "ARCHITECTURE.md",
  "GOVERNANCE.md",
  "DECISION_REGISTRY.md",
  "FINDINGS.md",
  "BATCH_LOG.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
  "VERSION",
];

test("a REMOVED member is DOCTRINE and HALTS to the operator", () => {
  const r = classifyDocPackShape(FULL, FULL.filter((f) => f !== "ROADMAP.md"));
  assert.equal(r.class, "DOCTRINE");
  assert.equal(r.halt, true);
  assert.equal(r.route, "operator");
  assert.equal(r.code, "doc-pack-member-removed");
  assert.deepEqual(r.removed, ["ROADMAP.md"]);
});

test("removing VERSION (the odometer source) is DOCTRINE + halt", () => {
  const r = classifyDocPackShape(FULL, FULL.filter((f) => f !== "VERSION"));
  assert.equal(r.class, "DOCTRINE");
  assert.equal(r.halt, true);
});

test("an ADDED member (pack formation) is MINOR, no halt", () => {
  const partial = ["MEMORY.md", "CORE.md"];
  const r = classifyDocPackShape(partial, [...partial, "VERSION"]);
  assert.equal(r.class, "MINOR");
  assert.equal(r.halt, false);
  assert.equal(r.code, "doc-pack-member-added");
  assert.deepEqual(r.added, ["VERSION"]);
});

test("instantiating the full pack from nothing is MINOR (additive)", () => {
  const r = classifyDocPackShape([], FULL);
  assert.equal(r.class, "MINOR");
  assert.equal(r.halt, false);
  assert.deepEqual(r.added, FULL);
});

test("membership unchanged at a pack root is COSMETIC, no halt", () => {
  const r = classifyDocPackShape([...FULL, "x.js"], [...FULL, "x.js", "y.js"]);
  assert.equal(r.class, "COSMETIC");
  assert.equal(r.halt, false);
  assert.equal(r.code, "membership-unchanged");
});

test("a non-pack root in both states is out of scope (not-a-pack)", () => {
  const r = classifyDocPackShape(["a.js"], ["a.js", "b.js"]);
  assert.equal(r.halt, false);
  assert.equal(r.code, "not-a-pack");
});

test("the ceiling rule NEVER blocks - even the heaviest case only halts", () => {
  const r = classifyDocPackShape(FULL, FULL.filter((f) => f !== "GOVERNANCE.md"));
  assert.ok(!("ok" in r), "shape rule returns a class/halt verdict, not a floor ok/block");
  assert.equal(r.halt, true); // routes to operator, does not gate the commit
});

test("reports MULTIPLE removed members", () => {
  const after = FULL.filter((f) => f !== "FINDINGS.md" && f !== "SESSION_STATE.md");
  const r = classifyDocPackShape(FULL, after);
  assert.deepEqual(r.removed, ["FINDINGS.md", "SESSION_STATE.md"]);
});

test("deterministic: same inputs -> same verdict", () => {
  const a = classifyDocPackShape(FULL, FULL.filter((f) => f !== "CORE.md"));
  const b = classifyDocPackShape(FULL, FULL.filter((f) => f !== "CORE.md"));
  assert.deepEqual(a, b);
});

test("handles non-array inputs safely (out of scope)", () => {
  const r = classifyDocPackShape(undefined, null);
  assert.equal(r.code, "not-a-pack");
});
