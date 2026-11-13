// core/bridges/reasoning-split.test.js — [A47]/F-089
//
// The answer is the CONTENT; reasoning is separate and never substituted for an
// empty answer. Budget-starved (empty content + real reasoning + no tool calls)
// is an honest failure, not a leaked scratchpad.

import test from "node:test";
import assert from "node:assert/strict";
import { splitReasoning, stripInlineReasoning, REASONING_STARVED_ERROR } from "./reasoning-split.js";

test("a clean answer with separate reasoning returns the answer only", () => {
  const s = splitReasoning({ content: "A topology is a structured seat graph.", reasoning: "We need one sentence..." });
  assert.equal(s.answer, "A topology is a structured seat graph.");
  assert.equal(s.reasoning, "We need one sentence...");
  assert.equal(s.starved, false);
});

test("THE LEAK: empty content + nonempty reasoning is STARVED, never returns the reasoning as the answer", () => {
  const s = splitReasoning({ content: "", reasoning: "We need to produce a design... (1539 chars of scratchpad)" });
  assert.equal(s.answer, "", "the scratchpad is NOT promoted to the answer");
  assert.equal(s.starved, true);
  assert.match(REASONING_STARVED_ERROR, /reasoning-starved/);
});

test("empty content + reasoning + TOOL CALLS is not starved (a tool-only turn is legitimate)", () => {
  const s = splitReasoning({ content: "", reasoning: "thinking about which tool", hasToolCalls: true });
  assert.equal(s.starved, false);
});

test("inline <think> blocks are stripped from content defensively", () => {
  assert.equal(stripInlineReasoning("<think>plan the answer</think>The answer is 42."), "The answer is 42.");
  assert.equal(stripInlineReasoning("<reasoning>x</reasoning>  Clean."), "Clean.");
  const s = splitReasoning({ content: "<think>only reasoning, no answer</think>", reasoning: "" });
  assert.equal(s.answer, "", "content that is ONLY an inline think-block strips to empty");
  assert.equal(s.starved, false, "no separate reasoning field => not classified starved (inline case has no answer but also no carried reasoning)");
});

test("degenerate inputs never throw or misclassify", () => {
  assert.deepEqual(splitReasoning({}), { answer: "", reasoning: "", starved: false });
  assert.deepEqual(splitReasoning(), { answer: "", reasoning: "", starved: false });
  assert.equal(splitReasoning({ content: "hi", reasoning: null }).starved, false);
  assert.equal(splitReasoning({ content: "", reasoning: "   " }).starved, false, "whitespace-only reasoning is not a real trace");
});
