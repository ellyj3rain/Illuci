// node:test - the batch-prefix COHERENCE ceiling rule (right-but-valid vs wrong-but-valid).
// Pure: every case is a literal subject + open-batch anchor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBatchCoherence } from "./batch-coherence.js";

test("a matching prefix is coherent", () => {
  const r = checkBatchCoherence("[A128] role-governance Phase 2", "[A128]");
  assert.equal(r.ok, true);
  assert.equal(r.code, "coherent");
  assert.equal(r.prefix, "[A128]");
});

test("matches regardless of bracket form on the anchor (A128 vs [A128])", () => {
  const r = checkBatchCoherence("[A128] x", "A128");
  assert.equal(r.ok, true);
  assert.equal(r.code, "coherent");
});

test("FLAGS a mismatched batch (wrong-but-valid token)", () => {
  const r = checkBatchCoherence("[A126] stale prefix", "[A128]");
  assert.equal(r.ok, false);
  assert.equal(r.code, "batch-mismatch");
  assert.equal(r.prefix, "[A126]");
  assert.equal(r.expected, "[A128]");
  assert.match(r.reason, /\[A126\]/);
  assert.match(r.reason, /\[A128\]/);
});

test("normalizes a bare anchor into bracket form in `expected`", () => {
  const r = checkBatchCoherence("[A126] x", "A128");
  assert.equal(r.ok, false);
  assert.equal(r.expected, "[A128]");
});

test("[HOTFIX] is coherent by definition (never matched against the open batch)", () => {
  const r = checkBatchCoherence("[HOTFIX] urgent", "[A128]");
  assert.equal(r.ok, true);
  assert.equal(r.code, "hotfix");
});

test("no anchor supplied -> coherence not judged (passes)", () => {
  const r = checkBatchCoherence("[A126] x", null);
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-anchor");
  assert.equal(r.prefix, "[A126]");
});

test("an empty anchor string -> coherence not judged (passes)", () => {
  assert.equal(checkBatchCoherence("[A126] x", "   ").code, "no-anchor");
});

test("no subject -> nothing to judge (passes)", () => {
  assert.equal(checkBatchCoherence("", "[A128]").code, "no-subject");
  assert.equal(checkBatchCoherence(null, "[A128]").ok, true);
});

test("a prefix-less subject is deferred to the floor, not double-blocked", () => {
  const r = checkBatchCoherence("feat: no prefix here", "[A128]");
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-prefix");
});

test("sub-batch prefixes compare on their full token ([A20.1.0])", () => {
  assert.equal(checkBatchCoherence("[A20.1.0] harden", "[A20.1.0]").code, "coherent");
  assert.equal(checkBatchCoherence("[A20.1.0] harden", "[A20]").code, "batch-mismatch");
});
