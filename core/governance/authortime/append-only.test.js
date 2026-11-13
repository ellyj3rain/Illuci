// node:test - the append-only-intact floor atom (the forked-ledger / history-rewrite guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAppendOnly, APPEND_ONLY_LEDGERS } from "./append-only.js";

test("allows pure appends (normal ledger growth)", () => {
  const r = checkAppendOnly("- DR-001\n- DR-002\n", "- DR-001\n- DR-002\n- DR-003\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "appended");
  assert.equal(r.added, 1);
});

test("allows unchanged content", () => {
  const r = checkAppendOnly("- DR-001\n", "- DR-001\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "unchanged");
});

test("allows a brand-new ledger (no prior content)", () => {
  assert.equal(checkAppendOnly("", "- DR-001\n").ok, true);
});

test("BLOCKS modifying an existing line (history rewrite)", () => {
  const r = checkAppendOnly("- DR-001 original\n- DR-002\n", "- DR-001 EDITED\n- DR-002\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "append-only-violation");
  assert.equal(r.line, 1);
});

test("BLOCKS deleting an existing line (the forked-ledger class)", () => {
  const r = checkAppendOnly("- DR-001\n- DR-002\n- DR-003\n", "- DR-001\n- DR-003\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "append-only-violation");
});

test("BLOCKS a middle insertion (not append-only growth)", () => {
  const r = checkAppendOnly("- DR-001\n- DR-002\n", "- DR-001\n- DR-001b\n- DR-002\n");
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
});

test("CRLF vs LF is not a false positive", () => {
  const r = checkAppendOnly("- DR-001\r\n- DR-002\r\n", "- DR-001\n- DR-002\n- DR-003\n");
  assert.equal(r.ok, true);
});

test("ALLOWS a label-only re-index (VERSION-preserving relabel; DR-119)", () => {
  // Prior headers relabeled ([A23.3] -> [A26.2], [A25.2] -> [A26.3]) with content preserved,
  // plus an appended correction entry. This is the sanctioned honest-index re-index.
  const prior = "## [A23.3] | ts | Skill gate\nbody one\n## [A25.2] | ts | Git honest\nbody two\n";
  const reindexed =
    "## [A26.2] | ts | Skill gate\nbody one\n## [A26.3] | ts | Git honest\nbody two\n## [A29] | ts | Re-index\ncorrection\n";
  const r = checkAppendOnly(prior, reindexed);
  assert.equal(r.ok, true);
  assert.equal(r.code, "re-indexed");
});

test("BLOCKS a content change disguised alongside a relabel (the exception stays strict)", () => {
  // Label changed AND the title text changed on the same line -> not a pure re-index.
  const r = checkAppendOnly("## [A23.3] | ts | Skill gate\nbody\n", "## [A26.2] | ts | Skill gate REWRITTEN\nbody\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "append-only-violation");
});

test("BLOCKS a content edit with no label at all (the exception never widens the guard)", () => {
  const r = checkAppendOnly("- DR-001 original\n", "- DR-001 EDITED\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "append-only-violation");
});

test("names the three GZDS append-only ledgers", () => {
  assert.deepEqual(APPEND_ONLY_LEDGERS, ["BATCH_LOG.md", "DECISION_REGISTRY.md", "FINDINGS.md"]);
});
