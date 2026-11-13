/**
 * Per-bridge reasoning consumption (champion "A-universal-dial", 2026-06-17).
 *
 * Every reasoning-capable API bridge reads the LIVE options.reasoning at body-build time,
 * translates it to its own provider knob via illuci/core/reasoning/dial.js, and OMITS the knob
 * for the "off"/unknown dial or an incapable model. These tests stub globalThis.fetch to
 * capture the wire body (grok-api, claude-api, ollama all use the global fetch).
 *
 * The deciding-axis invariant the colosseum converged on: because the bridge reads the same
 * options.reasoning the adaptive ladder steps (dispatch/adaptive-fallback.js:91), a stepped
 * tier reaches the wire per attempt. We assert that by driving each bridge at two tiers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { query as grokApiQuery } from "./grok-api.js";
import { query as claudeApiQuery } from "./claude-api.js";
import { query as ollamaQuery } from "./ollama.js";
import { buildAdaptiveExecutionPlan } from "../dispatch/adaptive-fallback.js";

/** Install a fetch stub that captures the first request body + returns a provider-shaped OK. */
function stubFetch(makeResponse) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, init, body });
    return makeResponse(url);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    body: null,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

// ── grok-api: dial -> reasoning_effort, capability-gated ──

test("grok-api: the dial maps to reasoning_effort on a reasoning-capable model; stepped tier reaches the wire", async () => {
  const prevKey = process.env.XAI_API_KEY;
  const prevModel = process.env.XAI_MODEL;
  process.env.XAI_API_KEY = "test-key";
  process.env.XAI_MODEL = "grok-4.20-0309-reasoning"; // reasoning-capable
  const grokPayload = { model: "grok-4", choices: [{ message: { content: "ok" } }], usage: {} };
  const s = stubFetch(() => jsonResponse(grokPayload));
  try {
    await grokApiQuery("hi", { reasoning: "xhigh" });
    assert.equal(s.calls[0].body.reasoning_effort, "xhigh");

    // the adaptive ladder steps options.reasoning; a downgraded tier still reaches the wire
    await grokApiQuery("hi", { reasoning: "high" });
    assert.equal(s.calls[1].body.reasoning_effort, "high");

    // the "off" dial omits the knob entirely
    await grokApiQuery("hi", { reasoning: "off" });
    assert.equal("reasoning_effort" in s.calls[2].body, false);
  } finally {
    s.restore();
    process.env.XAI_API_KEY = prevKey; if (prevKey === undefined) delete process.env.XAI_API_KEY;
    process.env.XAI_MODEL = prevModel; if (prevModel === undefined) delete process.env.XAI_MODEL;
  }
});

test("grok-api: a non-reasoning model (grok-build) OMITS reasoning_effort even with a dial set (no 400)", async () => {
  const prevKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  const grokPayload = { model: "grok-build", choices: [{ message: { content: "ok" } }], usage: {} };
  const s = stubFetch(() => jsonResponse(grokPayload));
  try {
    await grokApiQuery("hi", { reasoning: "high", model: "grok-build" });
    assert.equal("reasoning_effort" in s.calls[0].body, false);
  } finally {
    s.restore();
    process.env.XAI_API_KEY = prevKey; if (prevKey === undefined) delete process.env.XAI_API_KEY;
  }
});

// ── claude-api: dial -> output_config.effort (the modern Anthropic control) ──
// The legacy thinking:{type:"enabled",budget_tokens} shape 400s on Opus 4.7/4.8, so the
// bridge uses output_config.effort (dial 1:1 to the effort enum), + thinking:{type:"adaptive"}
// only on the adaptive-thinking models, with xhigh clamped where unsupported.

test("claude-api: the dial drives output_config.effort (dead -> live); the stepped tier steps effort", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const claudePayload = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
  const s = stubFetch(() => jsonResponse(claudePayload));
  try {
    // default model claude-fable-5: effort + xhigh capable, always-on adaptive (NO thinking block)
    await claudeApiQuery("hi", { reasoning: "xhigh" });
    assert.deepEqual(s.calls[0].body.output_config, { effort: "xhigh" });
    assert.equal("thinking" in s.calls[0].body, false);  // Fable 5 is always-on; no block
    assert.ok(!JSON.stringify(s.calls[0].body).includes("budget_tokens")); // never the legacy 400-ing shape

    // a stepped-down tier (the adaptive ladder) lowers the same effort per attempt
    await claudeApiQuery("hi", { reasoning: "medium" });
    assert.deepEqual(s.calls[1].body.output_config, { effort: "medium" });

    // "off"/legacy dial -> no effort knob (the model uses its default)
    await claudeApiQuery("hi", { reasoning: "off" });
    assert.equal("output_config" in s.calls[2].body, false);
    await claudeApiQuery("hi", { reasoning: "frontier" });
    assert.equal("output_config" in s.calls[3].body, false);
  } finally {
    s.restore();
    process.env.ANTHROPIC_API_KEY = prevKey; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  }
});

test("claude-api: adaptive models add thinking:{type:adaptive}; xhigh clamps; effort-incapable models emit nothing (no 400)", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const claudePayload = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
  const s = stubFetch(() => jsonResponse(claudePayload));
  try {
    // Opus 4.8 enables extended thinking via the adaptive block + effort
    await claudeApiQuery("hi", { reasoning: "high", model: "claude-opus-4-8" });
    assert.deepEqual(s.calls[0].body.output_config, { effort: "high" });
    assert.deepEqual(s.calls[0].body.thinking, { type: "adaptive" });

    // xhigh on a non-xhigh model (Sonnet 4.6) clamps to high — never a 400 for an unsupported level
    await claudeApiQuery("hi", { reasoning: "xhigh", model: "claude-sonnet-4-6" });
    assert.deepEqual(s.calls[1].body.output_config, { effort: "high" });

    // an effort-incapable model (Haiku 4.5) emits NO reasoning knob — safe no-op, not a guessed shape
    await claudeApiQuery("hi", { reasoning: "high", model: "claude-haiku-4-5" });
    assert.equal("output_config" in s.calls[2].body, false);
    assert.equal("thinking" in s.calls[2].body, false);
  } finally {
    s.restore();
    process.env.ANTHROPIC_API_KEY = prevKey; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  }
});

// ── ollama: dial -> native /api/chat top-level `think` (auto-selects native) ──

test("ollama: the dial sets top-level think and auto-selects the native /api/chat endpoint", async () => {
  const nativePayload = { message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1, done: true };
  const s = stubFetch(() => jsonResponse(nativePayload));
  try {
    await ollamaQuery("hi", { model: "deepseek-v4-pro:cloud", reasoning: "high" });
    assert.match(s.calls[0].url, /\/api\/chat$/);   // native endpoint (think is NATIVE_ONLY)
    assert.equal(s.calls[0].body.think, true);      // top-level think

    // the "off" dial turns think off (still native, explicit off)
    await ollamaQuery("hi", { model: "deepseek-v4-pro:cloud", reasoning: "off" });
    assert.equal(s.calls[1].body.think, false);
  } finally {
    s.restore();
  }
});

test("ollama: no dial leaves think unset (server default rules), stays on the openai-compat endpoint", async () => {
  const openaiPayload = { choices: [{ message: { content: "ok" } }], usage: {} };
  const s = stubFetch(() => jsonResponse(openaiPayload));
  try {
    await ollamaQuery("hi", { model: "qwen36-abl:fast" });
    assert.match(s.calls[0].url, /\/v1\/chat\/completions$/); // no native-only param -> openai-compat
    assert.equal("think" in s.calls[0].body, false);
  } finally {
    s.restore();
  }
});

test("ollama: an explicit params.think wins over the dial (caller's deliberate choice)", async () => {
  const nativePayload = { message: { content: "ok" }, prompt_eval_count: 1, eval_count: 1, done: true };
  const s = stubFetch(() => jsonResponse(nativePayload));
  try {
    await ollamaQuery("hi", { model: "deepseek-v4-pro:cloud", reasoning: "off", params: { think: true } });
    assert.equal(s.calls[0].body.think, true); // explicit params.think true beats the off dial
  } finally {
    s.restore();
  }
});

// ── composition with the adaptive fallback ladder (THE deciding axis) ──
// The colosseum's deciding axis: because the bridge reads the SAME options.reasoning the
// adaptive ladder steps (`{ ...merged, reasoning: tier }`), the xhigh->high->medium step-down
// toward reasoningFloor is honored by construction with zero desync and NO double-apply.
// We drive the REAL buildAdaptiveExecutionPlan, then feed each attempt's options into the real
// claude-api bridge and assert the wire thinking budget steps down per attempt.

test("the adaptive ladder's stepped options.reasoning reaches claude-api's wire body per attempt (no desync, honors floor)", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const defaults = {
    adaptive: { reasoning: { supported: true, tiers: ["xhigh", "high", "medium"] } },
  };
  // floor=medium: the plan steps xhigh -> high -> medium
  const plan = buildAdaptiveExecutionPlan(
    "claude-api",
    { reasoning: "xhigh" },
    defaults,
    { adaptiveFallback: true, reasoningFloor: "medium" },
  );
  assert.deepEqual(plan.map((a) => a.reasoningTier), ["xhigh", "high", "medium"]);

  const claudePayload = { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } };
  const s = stubFetch(() => jsonResponse(claudePayload));
  try {
    // Each attempt is what the dispatch loop hands the bridge. The effort must step DOWN,
    // proving the bridge translates the stepped dial (and never the original) per attempt.
    // Default model claude-fable-5 is xhigh-capable, so effort maps the tier 1:1.
    const expectedEfforts = ["xhigh", "high", "medium"];
    const rank = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
    for (let i = 0; i < plan.length; i++) {
      await claudeApiQuery("hi", plan[i].options);
      assert.deepEqual(
        s.calls[i].body.output_config,
        { effort: expectedEfforts[i] },
        `attempt ${i} (${plan[i].reasoningTier}) must carry the stepped effort`,
      );
    }
    // strictly descending effort posture — the floor is honored, no double-apply re-inflates it
    const sent = s.calls.map((c) => rank[c.body.output_config.effort]);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i] < sent[i - 1], "effort must step down each attempt");
  } finally {
    s.restore();
    process.env.ANTHROPIC_API_KEY = prevKey; if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  }
});
