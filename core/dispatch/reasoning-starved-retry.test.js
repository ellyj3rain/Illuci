import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReasoningStarvedRetryOptions,
  isReasoningStarvedResult,
  shouldRetryReasoningStarved,
} from "./dispatch.js";
import { REASONING_STARVED_ERROR } from "../bridges/reasoning-split.js";

test("reasoning-starved bridge failures are classified for a no-think retry", () => {
  const result = {
    failed: true,
    error: REASONING_STARVED_ERROR,
    response: null,
  };

  assert.equal(isReasoningStarvedResult(result), true);
  assert.equal(shouldRetryReasoningStarved(result, { reasoning: "high" }), true);
});

test("reasoning-starved retry does not loop or override explicit no-think requests", () => {
  const result = { failed: true, error: "reasoning-starved: empty final answer" };

  assert.equal(shouldRetryReasoningStarved(result, { _reasoningStarvedRetry: true }), false);
  assert.equal(shouldRetryReasoningStarved(result, { thinking: false }), false);
  assert.equal(shouldRetryReasoningStarved(result, { params: { think: false } }), false);
});

test("reasoning-starved retry options preserve caller controls and disable thinking", () => {
  const options = {
    timeoutMs: 120000,
    reasoning: "xhigh",
    params: { num_predict: 4096, temperature: 0.2 },
  };
  const retry = buildReasoningStarvedRetryOptions(options);

  assert.equal(retry._reasoningStarvedRetry, true);
  assert.equal(retry.thinking, false);
  assert.deepEqual(retry.params, {
    num_predict: 4096,
    temperature: 0.2,
    think: false,
  });
  assert.equal(retry.timeoutMs, 120000);
  assert.equal(retry.reasoning, "xhigh");
});
