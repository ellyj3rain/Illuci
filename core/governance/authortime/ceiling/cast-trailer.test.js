// node:test - the Standard 15 attribution ceiling rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleAttribution } from "./cast-trailer.js";

test("a message without a model coauthor trailer -> clean", () => {
  const r = ruleAttribution("[A4.4.1] CI governance automation and merge-gate patch");
  assert.equal(r.ok, true);
  assert.equal(r.severity, "clean");
  assert.equal(r.route, null);
  assert.equal(r.code, "operator-git-author");
});

test("Cast trailer is allowed but not required", () => {
  const r = ruleAttribution("feat: x\n\nCast: synthesizer = author");
  assert.equal(r.ok, true);
  assert.equal(r.severity, "clean");
});

test("null / empty message -> clean (nothing to weigh)", () => {
  assert.equal(ruleAttribution(null).severity, "clean");
  assert.equal(ruleAttribution("").code, "no-message");
});

test("a model Co-Authored-By trailer -> advisory routed to operator", () => {
  const r = ruleAttribution("fix\n\nCo-Authored-By: Claude <x@y>");
  assert.equal(r.ok, false);
  assert.equal(r.severity, "advisory");
  assert.equal(r.route, "operator");
  assert.equal(r.code, "attribution-model-coauthor");
});

test("the rule never blocks or halts", () => {
  for (const msg of [null, "", "feat\n\nCast: x = y", "fix\n\nCo-Authored-By: GPT <x@y>", "no trailers"]) {
    const r = ruleAttribution(msg);
    assert.ok(["clean", "advisory"].includes(r.severity), "severity must be clean|advisory, got " + r.severity);
  }
});

test("deterministic: same message -> same finding (clock-free)", () => {
  const msg = "fix\n\nCo-Authored-By: Gemini <x@y>";
  assert.deepEqual(ruleAttribution(msg), ruleAttribution(msg));
});
