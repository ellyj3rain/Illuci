// core/dispatch/empty-success.test.js
// [A17.3] Empty-success honesty: a bridge result with no content + zero COMPLETION tokens is a
// route/auth/preflight failure, not an answer. Pure classifier, unit-tested directly.

import test from "node:test";
import assert from "node:assert/strict";
import { reclassifyEmptySuccess } from "./dispatch.js";

test("empty response + zero completion tokens is reclassified as failed", () => {
  const r = reclassifyEmptySuccess({ model: "nim-x", response: "", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  assert.equal(r.failed, true);
  assert.match(r.error, /empty content with zero completion tokens/);
  assert.equal(r.response, "");
});

test("null response + zero completion is reclassified as failed", () => {
  const r = reclassifyEmptySuccess({ model: "nim-x", response: null, usage: {} });
  assert.equal(r.failed, true);
});

test("ROBUSTNESS: empty response but back-filled PROMPT tokens (total>0) still fails — completion is 0", () => {
  // applyEstimatedUsage back-fills prompt tokens for a zero-usage result, so total_tokens is
  // nonzero on a failed empty call; the guard must key on completion tokens, not total.
  const r = reclassifyEmptySuccess({ model: "nim-x", response: "", usage: { prompt_tokens: 812, completion_tokens: 0, total_tokens: 812, estimated: true } });
  assert.equal(r.failed, true);
});

test("a genuine answer (content + completion tokens) is untouched", () => {
  const ok = { model: "claude-opus", response: "here is the analysis", usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
  assert.equal(reclassifyEmptySuccess(ok), ok);
  assert.equal(reclassifyEmptySuccess(ok).failed, undefined);
});

test("an empty-but-billed answer (0 content, >0 completion) is NOT flagged — a real if-empty answer", () => {
  const r = reclassifyEmptySuccess({ model: "x", response: "", usage: { completion_tokens: 3, total_tokens: 50 } });
  assert.equal(r.failed, undefined);
});

test("skipped / blocked / already-failed results pass through untouched", () => {
  const skipped = { model: "x", response: null, skipped: true, reason: "paused", usage: {} };
  assert.equal(reclassifyEmptySuccess(skipped), skipped);
  const blocked = { model: "x", response: null, blocked: true, usage: {} };
  assert.equal(reclassifyEmptySuccess(blocked), blocked);
  const failed = { model: "x", response: null, failed: true, error: "route down", usage: {} };
  const out = reclassifyEmptySuccess(failed);
  assert.equal(out, failed);
  assert.equal(out.error, "route down"); // original error preserved, not overwritten
});

test("null/garbage input does not throw", () => {
  assert.equal(reclassifyEmptySuccess(null), null);
  assert.equal(reclassifyEmptySuccess(undefined), undefined);
});
