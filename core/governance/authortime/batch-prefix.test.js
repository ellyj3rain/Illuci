// node:test - the batch-prefix commit-discipline floor atom (the commit-scope half of
// batch-and-version discipline). Pure: every case is a literal subject string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBatchPrefix, BATCH_RE, HOTFIX_RE } from "./batch-prefix.js";

test("accepts a plain batch prefix [A1] and returns the matched token", () => {
  const r = checkBatchPrefix("[A1] feat: ship the thing");
  assert.equal(r.ok, true);
  assert.equal(r.code, "batch");
  assert.equal(r.batch, "[A1]");
});

test("accepts a multi-digit batch prefix [A128]", () => {
  const r = checkBatchPrefix("[A128] role-governance Phase 2");
  assert.equal(r.ok, true);
  assert.equal(r.code, "batch");
  assert.equal(r.batch, "[A128]");
});

test("accepts a B-series prefix [B1]", () => {
  const r = checkBatchPrefix("[B1] reorg: decouple the engine");
  assert.equal(r.ok, true);
  assert.equal(r.batch, "[B1]");
});

test("accepts a sub-batch prefix [B2.3]", () => {
  const r = checkBatchPrefix("[B2.3] harden: fix peer-injection");
  assert.equal(r.ok, true);
  assert.equal(r.code, "batch");
  assert.equal(r.batch, "[B2.3]");
});

test("accepts a deep harden prefix [A20.1.0]", () => {
  const r = checkBatchPrefix("[A20.1.0] sub-batch: review fixes");
  assert.equal(r.ok, true);
  assert.equal(r.batch, "[A20.1.0]");
});

test("accepts the [HOTFIX] marker", () => {
  const r = checkBatchPrefix("[HOTFIX] patch the live regression");
  assert.equal(r.ok, true);
  assert.equal(r.code, "hotfix");
  assert.equal(r.batch, undefined);
});

test("is inert when no message is supplied (null)", () => {
  const r = checkBatchPrefix(null);
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-message");
});

test("is inert on an empty / whitespace-only subject", () => {
  assert.equal(checkBatchPrefix("").code, "no-message");
  assert.equal(checkBatchPrefix("   ").code, "no-message");
  assert.equal(checkBatchPrefix("").ok, true);
});

test("trims leading whitespace before matching (caller-trim parity)", () => {
  const r = checkBatchPrefix("   [A7] feat: spacing");
  assert.equal(r.ok, true);
  assert.equal(r.batch, "[A7]");
});

test("BLOCKS an ungoverned subject with no prefix", () => {
  const r = checkBatchPrefix("feat: ship a thing without a batch");
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-batch-prefix");
  assert.match(r.reason, /batch prefix \[A#\]\/\[B#\] or \[HOTFIX\]/);
  assert.match(r.reason, /feat: ship a thing without a batch/);
});

test("BLOCKS a conventional-commit subject (no batch scope)", () => {
  const r = checkBatchPrefix("fix(illuci/matrix): availability honesty");
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-batch-prefix");
});


test("BLOCKS a GitHub default merge subject in the pure atom", () => {
  const r = checkBatchPrefix("Merge pull request #21 from example-org/mallowfluff-a4-4");
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-batch-prefix");
});
test("BLOCKS a non-batch bracket token (e.g. a wrong tier letter)", () => {
  const r = checkBatchPrefix("[C9] not a recognized series");
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-batch-prefix");
});

test("BLOCKS a malformed batch token ([A] with no number)", () => {
  const r = checkBatchPrefix("[A] missing the number");
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-batch-prefix");
});

test("truncates the offending subject to 48 chars in the reason", () => {
  const long = "this is a very long ungoverned subject line that should be truncated for the reason";
  const r = checkBatchPrefix(long);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(long.slice(0, 48).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!r.reason.includes(long.slice(48)));
});

test("the prefix grammar regexes are exported and anchored", () => {
  assert.equal(BATCH_RE.test("[A1] x"), true);
  assert.equal(BATCH_RE.test("noise [A1]"), false); // anchored at start
  assert.equal(HOTFIX_RE.test("[HOTFIX] x"), true);
  assert.equal(HOTFIX_RE.test("noise [HOTFIX]"), false);
});
