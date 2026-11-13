// node:test - the doc-pack-completeness floor atom (the canonical 9 + VERSION must stay whole
// at a GZS-managed root; a deletion that drops a member below the floor is the failure to catch).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_PACK,
  isDocPackRoot,
  checkDocPackComplete,
  checkDocPackPreserved,
} from "./doc-pack.js";

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

test("CANONICAL_PACK is the canonical 9 + VERSION, in order", () => {
  assert.deepEqual(CANONICAL_PACK, FULL);
});

test("allows a COMPLETE pack (all 10 present, plus unrelated files)", () => {
  const r = checkDocPackComplete([...FULL, "CLAUDE.md", "README.md", "package.json"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, "complete");
});

test("BLOCKS an incomplete pack - drops ROADMAP.md below the floor", () => {
  const r = checkDocPackComplete(FULL.filter((f) => f !== "ROADMAP.md"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "doc-pack-incomplete");
  assert.deepEqual(r.missing, ["ROADMAP.md"]);
});

test("BLOCKS the dropped root VERSION (the odometer source)", () => {
  const r = checkDocPackComplete(FULL.filter((f) => f !== "VERSION"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["VERSION"]);
});

test("reports MULTIPLE missing members in canonical order", () => {
  const r = checkDocPackComplete(["MEMORY.md", "CORE.md", "VERSION"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [
    "ARCHITECTURE.md",
    "GOVERNANCE.md",
    "DECISION_REGISTRY.md",
    "FINDINGS.md",
    "BATCH_LOG.md",
    "ROADMAP.md",
    "SESSION_STATE.md",
  ]);
});

test("GUARD: a non-pack root (no canonical files) is out of scope - not-a-pack", () => {
  const r = checkDocPackComplete(["index.js", "util.js", "README.md", "package.json"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-a-pack");
});

test("a root with even ONE canonical file is asserting pack-hood -> incomplete", () => {
  const r = checkDocPackComplete(["MEMORY.md", "index.js"]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "doc-pack-incomplete");
  assert.ok(r.missing.includes("VERSION"));
});

test("handles a non-array / missing listing safely (not-a-pack)", () => {
  assert.equal(checkDocPackComplete(undefined).code, "not-a-pack");
  assert.equal(checkDocPackComplete(null).code, "not-a-pack");
});

test("isDocPackRoot is true for any-member-present, false for none", () => {
  assert.equal(isDocPackRoot(["GOVERNANCE.md"]), true);
  assert.equal(isDocPackRoot(FULL), true);
  assert.equal(isDocPackRoot(["index.js", "README.md"]), false);
  assert.equal(isDocPackRoot([]), false);
});

// ---- preservation variant (false-positive-free on pre-existing partial packs) ----

test("preservation: allows a change that removes NOTHING from a full pack", () => {
  const r = checkDocPackPreserved(FULL, [...FULL, "CLAUDE.md"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, "preserved");
});

test("preservation: BLOCKS a change that REMOVES a pack member", () => {
  const r = checkDocPackPreserved(FULL, FULL.filter((f) => f !== "SESSION_STATE.md"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "doc-pack-member-removed");
  assert.deepEqual(r.removed, ["SESSION_STATE.md"]);
});

test("preservation: a PRE-EXISTING partial pack is NOT blamed on this change", () => {
  // The root was already missing ROADMAP.md before the change; this change touches an unrelated
  // file. The absolute floor would block, but the preservation variant must not.
  const prior = FULL.filter((f) => f !== "ROADMAP.md");
  const after = [...prior, "newfile.js"];
  const r = checkDocPackPreserved(prior, after);
  assert.equal(r.ok, true);
  assert.equal(r.code, "preserved");
});

test("preservation: out of scope when the root was never (and isn't) a pack root", () => {
  const r = checkDocPackPreserved(["a.js"], ["a.js", "b.js"]);
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-a-pack");
});

test("preservation: reports MULTIPLE removed members", () => {
  const after = FULL.filter((f) => f !== "FINDINGS.md" && f !== "VERSION");
  const r = checkDocPackPreserved(FULL, after);
  assert.equal(r.ok, false);
  assert.deepEqual(r.removed, ["FINDINGS.md", "VERSION"]);
});

test("deterministic: same inputs -> same verdict", () => {
  const a = checkDocPackComplete(FULL.filter((f) => f !== "CORE.md"));
  const b = checkDocPackComplete(FULL.filter((f) => f !== "CORE.md"));
  assert.deepEqual(a, b);
});
