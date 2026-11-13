// node:test - the ceiling elevation matrix + the five amendments.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEMANTIC_CLASSES,
  GATED_LANE,
  elevate,
  versionAction,
  failClosedOnEvidence,
  maxClass,
  haltDontDefault,
  unDrEdgeIsDoctrine,
} from "./elevation.js";

// ---------------------------------------------------------------------------
// Amendment 2 - fail-closed on evidence
// ---------------------------------------------------------------------------

test("Amendment 2: no evidence -> block", () => {
  const r = failClosedOnEvidence({ class: "PATCH" });
  assert.equal(r.block, true);
  assert.equal(r.code, "no-evidence");
});

test("Amendment 2: empty-string and empty-array evidence -> block", () => {
  assert.equal(failClosedOnEvidence({ evidence: "" }).block, true);
  assert.equal(failClosedOnEvidence({ evidence: "   " }).block, true);
  assert.equal(failClosedOnEvidence({ evidence: [] }).block, true);
});

test("Amendment 2: a cited DR string passes", () => {
  const r = failClosedOnEvidence({ class: "CONTRACT", evidence: "DR-099" });
  assert.equal(r.block, false);
  assert.equal(r.code, "evidenced");
});

test("Amendment 2: a non-empty evidence array passes", () => {
  assert.equal(failClosedOnEvidence({ evidence: ["scan-result", "DR-045"] }).block, false);
});

test("Amendment 2: a null/undefined record -> block (defensive)", () => {
  assert.equal(failClosedOnEvidence(null).block, true);
  assert.equal(failClosedOnEvidence(undefined).block, true);
});

// ---------------------------------------------------------------------------
// Amendment 3 - batch-level max
// ---------------------------------------------------------------------------

test("Amendment 3: batch is scored at its highest class", () => {
  assert.equal(maxClass(["COSMETIC", "PATCH", "MINOR"]), "MINOR");
  assert.equal(maxClass(["COSMETIC", "PATCH", "KOHAI"]), "KOHAI");
});

test("Amendment 3: a doctrine change cannot be diluted by cosmetics", () => {
  assert.equal(maxClass(["COSMETIC", "COSMETIC", "DOCTRINE", "PATCH"]), "DOCTRINE");
});

test("Amendment 3: CONTRACT outranks MINOR", () => {
  assert.equal(maxClass(["MINOR", "CONTRACT", "PATCH"]), "CONTRACT");
});

test("Amendment 3: empty batch -> floor class COSMETIC", () => {
  assert.equal(maxClass([]), "COSMETIC");
  assert.equal(maxClass(null), "COSMETIC");
});

test("Amendment 3: unknown entries are ignored for the max", () => {
  assert.equal(maxClass(["WEIRD", "PATCH", "garbage"]), "PATCH");
  assert.equal(maxClass(["WEIRD", "junk"]), "COSMETIC");
});

test("Amendment 3: case-insensitive entries", () => {
  assert.equal(maxClass(["cosmetic", "minor"]), "MINOR");
});

// ---------------------------------------------------------------------------
// Amendment 4 - halt, don't default
// ---------------------------------------------------------------------------

test("Amendment 4: UNRESOLVED -> halt + route operator", () => {
  const r = haltDontDefault("UNRESOLVED");
  assert.equal(r.halt, true);
  assert.equal(r.route, "operator");
  assert.equal(r.code, "unresolved-class");
});

test("Amendment 4: an unknown/empty class also halts (no silent default)", () => {
  assert.equal(haltDontDefault("WEIRD").halt, true);
  assert.equal(haltDontDefault("").halt, true);
  assert.equal(haltDontDefault(null).halt, true);
});

test("Amendment 4: a resolved known class passes", () => {
  const r = haltDontDefault("PATCH");
  assert.equal(r.halt, false);
  assert.equal(r.code, "resolved");
});

test("Amendment 4: case-insensitive (unresolved)", () => {
  assert.equal(haltDontDefault("unresolved").halt, true);
});

// ---------------------------------------------------------------------------
// Amendment 5 - an un-DR'd cross-spoke edge is doctrine
// ---------------------------------------------------------------------------

test("Amendment 5: an un-DR'd edge -> a DOCTRINE finding", () => {
  const r = unDrEdgeIsDoctrine([{ from: "claude", to: "otl" }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "undr-edge-doctrine");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].class, "DOCTRINE");
  assert.equal(r.findings[0].edge.from, "claude");
  assert.equal(r.findings[0].edge.to, "otl");
});

test("Amendment 5: multiple un-DR'd edges each become a DOCTRINE finding", () => {
  const r = unDrEdgeIsDoctrine([
    { from: "claude", to: "otl" },
    { from: "otl", to: "primitives" },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.findings.length, 2);
  assert.ok(r.findings.every((f) => f.class === "DOCTRINE"));
});

test("Amendment 5: no un-DR'd edges -> ok, empty findings", () => {
  const r = unDrEdgeIsDoctrine([]);
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-undr-edges");
  assert.equal(r.findings.length, 0);
});

// ---------------------------------------------------------------------------
// constants / wiring sanity
// ---------------------------------------------------------------------------

test("SEMANTIC_CLASSES are low->high and include the gated lane", () => {
  assert.deepEqual(SEMANTIC_CLASSES, ["COSMETIC", "PATCH", "KOHAI", "MINOR", "CONTRACT", "DOCTRINE"]);
  assert.deepEqual(GATED_LANE, ["CONTRACT", "DOCTRINE"]);
});