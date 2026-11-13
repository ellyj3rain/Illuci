/**
 * gemini-api bridge: the canonical HTTP transport for the Gemini family.
 * Hermetic — fetch is injected (options.fetch), no network, no credential.
 * The load-bearing invariant under test: it NEVER returns an empty success
 * (the agy failure mode that disqualified the CLI-as-replacement path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { query, detectAuth } from "./gemini-api.js";
import { getEntry } from "./model-registry.js";

// ── a capturing fake fetch ──
function fakeFetch(payload, { ok = true, status = 200, text = "", jsonThrows = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init?.headers, body: JSON.parse(init?.body || "{}") });
    return {
      ok, status,
      json: async () => { if (jsonThrows) throw new SyntaxError("Unexpected token '<' in JSON"); return payload; },
      text: async () => text || JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}
const okPayload = (textOut, usage = {}) => ({
  candidates: [{ content: { parts: [{ text: textOut }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8, ...usage },
  modelVersion: "gemini-3.5-flash-001",
});

// ── auth auto-detection ──

test("detectAuth: a Developer key selects the developer surface", () => {
  const a = detectAuth({ GEMINI_API_KEY: "k1" });
  assert.equal(a.mode, "developer");
  assert.equal(a.key, "k1");
  assert.equal(detectAuth({ GOOGLE_API_KEY: "k2" }).key, "k2"); // GOOGLE_API_KEY also accepted
});

test("detectAuth: explicit GOOGLE_GENAI_USE_VERTEXAI selects Vertex (even with a key present)", () => {
  const a = detectAuth({ GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "proj", GEMINI_API_KEY: "k" });
  assert.equal(a.mode, "vertex");
  assert.equal(a.project, "proj");
  assert.equal(a.location, "global"); // default location
});

test("detectAuth: a configured Vertex project with no key auto-selects Vertex", () => {
  const a = detectAuth({ GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" });
  assert.equal(a.mode, "vertex");
  assert.equal(a.location, "us-central1");
});

test("detectAuth: NO credential throws loudly (never silent)", () => {
  assert.throws(() => detectAuth({}), /no Gemini credential/);
});

test("detectAuth: Vertex requested but no project throws loudly", () => {
  assert.throws(() => detectAuth({ GOOGLE_GENAI_USE_VERTEXAI: "true" }), /GOOGLE_CLOUD_PROJECT is not set/);
});

// ── developer happy path ──

test("developer path: correct URL + x-goog-api-key header, parses candidates + usage", async () => {
  const f = fakeFetch(okPayload("hello"));
  const r = await query("hi", { model: "gemini-3.5-flash", env: { GEMINI_API_KEY: "secret" }, fetch: f });
  assert.equal(r.response, "hello");
  assert.equal(r.role, "agent");
  assert.equal(r.model, "gemini-3.5-flash");            // stable registry id, NOT the wire echo
  assert.equal(r.modelVersion, "gemini-3.5-flash-001"); // served version surfaced separately
  assert.deepEqual(r.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.equal(typeof r.latency, "number");
  // wire details
  const c = f.calls[0];
  assert.match(c.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.5-flash:generateContent/);
  assert.equal(c.headers["x-goog-api-key"], "secret");
  assert.equal(c.body.contents[0].parts[0].text, "hi");
});

test("buffered Gemini does not present a thought summary as the answer", async () => {
  const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "private reasoning summary", thought: true }, { text: "final answer" }] }, finishReason: "STOP" }] });
  const result = await query("hi", { env: { GEMINI_API_KEY: "fixture" }, fetch: f });
  assert.equal(result.response, "final answer");
  const thoughtOnly = fakeFetch({ candidates: [{ content: { parts: [{ text: "reasoning", thought: true }] }, finishReason: "STOP" }] });
  await assert.rejects(query("hi", { env: { GEMINI_API_KEY: "fixture" }, fetch: thoughtOnly }), /produced no text/);
});

test("developer path: systemPrompt + sessionState fold into the request", async () => {
  const f = fakeFetch(okPayload("ok"));
  await query("now", {
    model: "gemini-3.5-flash", env: { GEMINI_API_KEY: "k" }, fetch: f,
    systemPrompt: "be terse",
    sessionState: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
  });
  const b = f.calls[0].body;
  assert.equal(b.systemInstruction.parts[0].text, "be terse");
  assert.equal(b.contents[0].role, "user");
  assert.equal(b.contents[1].role, "model");          // assistant -> model
  assert.equal(b.contents[2].parts[0].text, "now");   // current message last
});

test("returned sessionState appends the user + assistant turn", async () => {
  const f = fakeFetch(okPayload("answer"));
  const r = await query("q", { env: { GEMINI_API_KEY: "k" }, fetch: f });
  assert.equal(r.sessionState.at(-2).content, "q");
  assert.equal(r.sessionState.at(-1).content, "answer");
});

// ── Vertex happy path ──

test("vertex path: aiplatform URL + Bearer token (token injected for the test)", async () => {
  const f = fakeFetch(okPayload("v"));
  const r = await query("hi", {
    model: "gemini-3.1-pro",
    env: { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p1", GOOGLE_CLOUD_LOCATION: "us-central1" },
    accessToken: "tok-123",
    fetch: f,
  });
  assert.equal(r.response, "v");
  const c = f.calls[0];
  assert.match(c.url, /us-central1-aiplatform\.googleapis\.com\/v1\/projects\/p1\/locations\/us-central1\/publishers\/google\/models\/gemini-3\.1-pro:generateContent/);
  assert.equal(c.headers["Authorization"], "Bearer tok-123");
  assert.equal(c.headers["x-goog-api-key"], undefined);
});

test("vertex global location uses the host without a region prefix", async () => {
  const f = fakeFetch(okPayload("g"));
  await query("hi", {
    env: { GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "p" },
    accessToken: "t", fetch: f,
  });
  assert.match(f.calls[0].url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/p\/locations\/global\//);
});

// ── never-silent guards (the whole point) ──

test("non-2xx throws with status + surface, never returns empty", async () => {
  const f = fakeFetch({ error: { message: "bad key" } }, { ok: false, status: 403, text: '{"error":{"message":"bad key"}}' });
  await assert.rejects(
    () => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }),
    /gemini-api 403 \(developer/
  );
});

test("ok but zero candidates throws (empty success refused)", async () => {
  const f = fakeFetch({ candidates: [] });
  await assert.rejects(() => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }), /no candidates/);
});

test("ok but a candidate with no text throws, surfacing finishReason", async () => {
  const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }] });
  await assert.rejects(() => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }), /no text \(finishReason=MAX_TOKENS\)/);
});

test("a blocked prompt throws with the block reason", async () => {
  const f = fakeFetch({ promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(() => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }), /prompt blocked \(SAFETY\)/);
});

test("no credential at query time throws before any fetch", async () => {
  let fetched = false;
  const f = async () => { fetched = true; return { ok: true, json: async () => okPayload("x") }; };
  await assert.rejects(() => query("hi", { env: {}, fetch: f }), /no Gemini credential/);
  assert.equal(fetched, false);
});

// ── hardened guards (adversarial round 2) ──

test("partial text with an abnormal finishReason (SAFETY) is refused, not returned", async () => {
  const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "Here is how to" }] }, finishReason: "SAFETY" }] });
  await assert.rejects(() => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }), /terminated abnormally \(finishReason=SAFETY\)/);
});

test("text with finishReason MAX_TOKENS is a real (truncated) answer and is kept", async () => {
  const f = fakeFetch({ candidates: [{ content: { parts: [{ text: "a truncated reply" }] }, finishReason: "MAX_TOKENS" }] });
  const r = await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f });
  assert.equal(r.response, "a truncated reply");
});

test("a 200 with a null body throws the bridge's loud empty-success refusal (not a raw TypeError)", async () => {
  const f = fakeFetch(null);
  await assert.rejects(() => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }), /non-object body \(empty success\)/);
});

test("a 200 with an unparseable body throws a contextualized gemini-api error", async () => {
  const f = fakeFetch({}, { jsonThrows: true });
  await assert.rejects(
    () => query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f }),
    /gemini-api: .* \(developer\) returned a 200 with an unparseable body/
  );
});

test("detectAuth: explicit GOOGLE_GENAI_USE_VERTEXAI=false honors the negative (no silent Vertex)", () => {
  // a stray project must NOT override the explicit Developer choice; with no key it throws loudly
  assert.throws(() => detectAuth({ GOOGLE_GENAI_USE_VERTEXAI: "false", GOOGLE_CLOUD_PROJECT: "p" }), /no Gemini credential/);
  // with a key, false -> developer
  assert.equal(detectAuth({ GOOGLE_GENAI_USE_VERTEXAI: "false", GOOGLE_CLOUD_PROJECT: "p", GEMINI_API_KEY: "k" }).mode, "developer");
});

test("detectAuth: the vertex flag is normalized for case + whitespace", () => {
  assert.equal(detectAuth({ GOOGLE_GENAI_USE_VERTEXAI: " TRUE ", GOOGLE_CLOUD_PROJECT: "p" }).mode, "vertex");
});

test("explicit options.thinking maps to thinkingConfig: off -> budget 0, on -> dynamic -1 (back-compat)", async () => {
  const off = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: off, thinking: false });
  assert.deepEqual(off.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });

  const on = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: on, thinking: true });
  assert.deepEqual(on.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: -1 });

  const none = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: none });
  assert.equal(none.calls[0].body.generationConfig, undefined); // no dial, no explicit thinking -> no generationConfig at all
});

test("the universal reasoning dial drives thinking on/off: a tier -> dynamic -1, off -> 0, unset -> none", async () => {
  // an active dial tier turns thinking on (the model sizes its own budget)
  const high = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: high, reasoning: "high" });
  assert.deepEqual(high.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: -1 });

  // the adaptive ladder steps the SAME field — a stepped-down tier still reads as "on"
  const medium = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: medium, reasoning: "medium" });
  assert.deepEqual(medium.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: -1 });

  // the "off" dial position turns thinking off
  const off = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: off, reasoning: "off" });
  assert.deepEqual(off.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });

  // a legacy non-dial tier word (frontier) is unknown -> OMITS the knob (degrades to no-op)
  const legacy = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: legacy, reasoning: "frontier" });
  assert.equal(legacy.calls[0].body.generationConfig, undefined);
});

test("explicit options.thinking wins over the dial (a deliberate caller override)", async () => {
  const f = fakeFetch(okPayload("x"));
  await query("hi", { env: { GEMINI_API_KEY: "k" }, fetch: f, reasoning: "high", thinking: false });
  assert.deepEqual(f.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test("documented modern Gemini models send supported thinking levels and refuse unsupported off", async () => {
  for (const [model, requested, expected] of [
    ["gemini-3.8-flash", "minimal", "low"],
    ["gemini-3.8-flash", "medium", "medium"],
    ["gemini-3.6-flash", "minimal", "minimal"],
    ["gemini-3.1-flash-lite", "high", "high"],
    ["gemini-4-argon", "xhigh", "high"],
  ]) {
    const f = fakeFetch(okPayload("ok"));
    await query("hi", { model, reasoning: requested, env: { GEMINI_API_KEY: "fixture" }, fetch: f });
    assert.deepEqual(f.calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: expected });
  }
  const f = fakeFetch(okPayload("ok"));
  await assert.rejects(query("hi", { model: "gemini-3.8-flash", thinking: false, env: { GEMINI_API_KEY: "fixture" }, fetch: f }), /does not support disabling thinking/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(query("hi", { model: "gemini-3.8-flash", reasoning: "off", env: { GEMINI_API_KEY: "fixture" }, fetch: f }), /does not support disabling thinking/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(query("hi", { model: "gemini-2.5-pro", reasoning: "off", env: { GEMINI_API_KEY: "fixture" }, fetch: f }), /does not support disabling thinking/);
  assert.equal(f.calls.length, 0);
  const older = fakeFetch(okPayload("ok"));
  await query("hi", { model: "gemini-2.5-flash", reasoning: "off", env: { GEMINI_API_KEY: "fixture" }, fetch: older });
  assert.deepEqual(older.calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

// ── routing: the registry inconsistency is resolved ──

test("registry reroute: api variants -> gemini-api.js, the CLI variant stays gemini.js", () => {
  assert.equal(getEntry("gemini-3.5-flash").bridge, "gemini-api.js");
  assert.equal(getEntry("gemini-3.1-pro").bridge, "gemini-api.js");
  assert.equal(getEntry("gemini-3.1-flash-lite").bridge, "gemini-api.js");
  assert.equal(getEntry("gemini-local").bridge, "gemini.js"); // CLI variant unchanged
});
