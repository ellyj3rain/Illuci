// node:test - the Standard 15 attribution atom (warn-tier).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAttribution } from "./cast-trailer.js";

test("null message -> ok (no-message)", () => {
  const r = checkAttribution(null);
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-message");
});

test("empty / whitespace message -> ok (no-message)", () => {
  assert.equal(checkAttribution("").code, "no-message");
  assert.equal(checkAttribution("   \n\t ").code, "no-message");
});

test("a commit without Cast trailer is clean Git attribution", () => {
  const r = checkAttribution("[A4.4.1] CI governance automation and merge-gate patch");
  assert.equal(r.ok, true);
  assert.equal(r.code, "operator-git-author");
});

test("Cast trailer is allowed but not required", () => {
  const msg = [
    "feat(illuci): record a governed artifact",
    "",
    "Cast: synthesizer = author; builder = mechanical",
  ].join("\n");
  const r = checkAttribution(msg);
  assert.equal(r.ok, true);
  assert.equal(r.code, "operator-git-author");
});

test("a Co-Authored-By: Claude trailer -> issue (model-coauthor-present), even with a Cast trailer", () => {
  const msg = [
    "fix: something",
    "",
    "Cast: builder = mechanical",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ].join("\n");
  const r = checkAttribution(msg);
  assert.equal(r.ok, false);
  assert.equal(r.code, "model-coauthor-present");
});

test("the model co-author signal fires across the fleet roster (GPT/Gemini/Grok/...)", () => {
  for (const model of ["GPT", "Gemini", "DeepSeek", "Kimi", "GLM", "Grok", "Minimax", "Qwen", "Llama"]) {
    const r = checkAttribution("fix\n\nCo-Authored-By: " + model + " <x@y>");
    assert.equal(r.ok, false, model + " should trip the model-coauthor signal");
    assert.equal(r.code, "model-coauthor-present");
  }
});

test("model name in prose body (not a trailer) is not a false positive", () => {
  const msg = "docs: note that Claude drafted this under operator direction";
  const r = checkAttribution(msg);
  assert.equal(r.ok, true);
  assert.equal(r.code, "operator-git-author");
});

test("deterministic: same input -> same output (clock-free)", () => {
  const msg = "feat\n\nno trailers";
  assert.deepEqual(checkAttribution(msg), checkAttribution(msg));
});
