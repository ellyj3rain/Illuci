/**
 * nvidia-nim bridge: the OpenAI-compatible HTTP transport for the NVIDIA NIM lane.
 * Hermetic — fetch + env are injected (options.fetch / options.env), no network, no
 * real credential. Load-bearing invariants under test:
 *   - a missing key throws BEFORE any fetch (the doctor reads env presence as missing-auth)
 *   - it NEVER returns an empty success (the gemini-api never-empty-success invariant)
 *   - a non-2xx throws a route failure that NEVER leaks the key
 *   - the route probe distinguishes missing-key / reachable / unreachable, key never in the result
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  query,
  probeRoute,
  resolveNvidiaApiKey,
  hasNvidiaEnvKey,
  resetRouteProbeCache,
} from "./nvidia-nim.js";

const TEST_KEY = "nvapi-TEST-secret-do-not-print";

// ── a capturing fake fetch (the gemini-api mold) ──
function fakeFetch(payload, { ok = true, status = 200, text = "" } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init?.headers, body: JSON.parse(init?.body || "{}") });
    return {
      ok, status,
      json: async () => payload,
      text: async () => text || JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}
const okPayload = (content, usage = {}) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, ...usage },
  model: "deepseek-ai/deepseek-v4-pro",
});

afterEach(() => resetRouteProbeCache());

// ── (1) missing key -> throws BEFORE any fetch ──

test("missing key: query throws before any fetch is attempted", async () => {
  const f = fakeFetch(okPayload("never"));
  await assert.rejects(() => query("hi", { env: {}, fetch: f }), /nvidia-nim: no credential/);
  assert.equal(f.calls.length, 0); // the injected fetch was NEVER called
});

// ── (2) happy path ──

test("happy path: Bearer header, /v1/chat/completions URL, body + parsed response + usage", async () => {
  const f = fakeFetch(okPayload("hello from nim"));
  const r = await query("hi there", {
    model: "deepseek-ai/deepseek-v4-pro",
    env: { NVIDIA_API_KEY: TEST_KEY },
    fetch: f,
  });

  // response + usage mapping
  assert.equal(r.response, "hello from nim"); // choices[0].message.content
  assert.equal(r.role, "agent");
  assert.equal(r.model, "deepseek-ai/deepseek-v4-pro");
  assert.deepEqual(r.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  assert.equal(typeof r.latency, "number");

  // wire details
  const c = f.calls[0];
  assert.equal(c.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(c.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.equal(c.body.model, "deepseek-ai/deepseek-v4-pro");
  assert.equal(c.body.messages.at(-1).role, "user");
  assert.equal(c.body.messages.at(-1).content, "hi there");
});

test("happy path: systemPrompt + sessionState fold into messages[], session turn appended", async () => {
  const f = fakeFetch(okPayload("answer"));
  const r = await query("now", {
    env: { NVIDIA_NIM_API_KEY: TEST_KEY }, // alias key also resolves
    fetch: f,
    systemPrompt: "be terse",
    sessionState: [{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }],
  });
  const msgs = f.calls[0].body.messages;
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "be terse");
  assert.equal(msgs[1].content, "earlier");
  assert.equal(msgs[2].role, "assistant");
  assert.equal(msgs.at(-1).content, "now");
  // returned sessionState appends the user + assistant turn
  assert.equal(r.sessionState.at(-2).content, "now");
  assert.equal(r.sessionState.at(-1).content, "answer");
});

// ── (3) non-2xx -> route failure, key never leaked ──

test("non-2xx: throws /nvidia-nim 401/ and the message does NOT contain the key", async () => {
  const f = fakeFetch({ error: "invalid api key" }, { ok: false, status: 401, text: '{"error":"invalid api key"}' });
  await assert.rejects(
    () => query("hi", { apiKey: TEST_KEY, fetch: f }),
    (err) => {
      assert.match(err.message, /nvidia-nim 401/);
      assert.ok(!err.message.includes(TEST_KEY), "thrown message must not leak the key");
      assert.ok(!err.message.includes("nvapi-"), "thrown message must not leak any nvapi- token");
      return true;
    },
  );
});

// ── (4) 2xx with empty content -> empty-success refused ──

test("2xx with empty content: throws /empty success/ (never returns an empty success)", async () => {
  const f = fakeFetch({ choices: [{ message: { role: "assistant", content: "" } }], usage: {} });
  await assert.rejects(() => query("hi", { apiKey: TEST_KEY, fetch: f }), /empty success/);
});

// ── (5) probeRoute: missing-key / reachable / unreachable, key never in JSON ──

test("probeRoute: missing-key makes NO network call and is staticAvailable:false", async () => {
  const f = fakeFetch(okPayload("x"));
  const probe = await probeRoute({ env: {}, fetch: f, noCache: true });
  assert.equal(probe.status, "missing-key");
  assert.equal(probe.staticAvailable, false);
  assert.equal(probe.probe, "nvidia-nim");
  assert.equal(f.calls.length, 0); // no network call on the missing-key path
});

test("probeRoute: a 200 from /v1/models is reachable + staticAvailable:true, key never in the result", async () => {
  const f = fakeFetch({ data: [] }, { ok: true, status: 200 });
  const probe = await probeRoute({ apiKey: TEST_KEY, fetch: f, noCache: true });
  assert.equal(probe.status, "reachable");
  assert.equal(probe.staticAvailable, true);
  assert.equal(probe.lastError, null);
  // the probe hit the sibling /v1/models, NOT chat/completions
  assert.match(f.calls[0].url, /\/v1\/models$/);
  // the key never leaks into the serialized probe
  assert.ok(!JSON.stringify(probe).includes(TEST_KEY));
  assert.ok(!JSON.stringify(probe).includes("nvapi-"));
});

test("probeRoute: a thrown fetch is unreachable + staticAvailable:false with lastError, key never in the result", async () => {
  const f = async () => { throw new Error("fetch failed"); };
  const probe = await probeRoute({ apiKey: TEST_KEY, fetch: f, noCache: true });
  assert.equal(probe.status, "unreachable");
  assert.equal(probe.staticAvailable, false);
  assert.equal(probe.lastError, "fetch failed");
  assert.ok(!JSON.stringify(probe).includes(TEST_KEY));
  assert.ok(!JSON.stringify(probe).includes("nvapi-"));
});

// ── credential resolution (env injection) ──

test("resolveNvidiaApiKey: NVIDIA_API_KEY wins over NVIDIA_NIM_API_KEY; null when neither set", () => {
  assert.equal(resolveNvidiaApiKey({ NVIDIA_API_KEY: "a", NVIDIA_NIM_API_KEY: "b" }), "a");
  assert.equal(resolveNvidiaApiKey({ NVIDIA_NIM_API_KEY: "b" }), "b");
  assert.equal(resolveNvidiaApiKey({}), null);
});

test("hasNvidiaEnvKey reflects env presence of either key", () => {
  assert.equal(hasNvidiaEnvKey({ NVIDIA_API_KEY: "a" }), true);
  assert.equal(hasNvidiaEnvKey({ NVIDIA_NIM_API_KEY: "b" }), true);
  assert.equal(hasNvidiaEnvKey({}), false);
});

// ── reasoning-budget retry (Air A26 NIM dogfood: gpt-oss-120b at max_tokens 24) ──

test("reasoning budget: empty content + finish_reason length retries once with a larger cap", async () => {
  const calls = [];
  const f = async (_url, init) => {
    calls.push(JSON.parse(init?.body || "{}"));
    if (calls.length === 1) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({
        choices: [{ message: { role: "assistant", content: "", reasoning_content: "hidden thinking" }, finish_reason: "length" }],
        usage: {},
      }) };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({
      choices: [{ message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }) };
  };
  const r = await query("solve it", {
    model: "openai/gpt-oss-120b", maxTokens: 24, env: { NVIDIA_API_KEY: TEST_KEY }, fetch: f,
  });
  assert.equal(r.response, "the answer");        // the retry's visible content, not an empty-success throw
  assert.equal(calls.length, 2);                 // retried exactly once
  assert.equal(calls[0].max_tokens, 24);         // first turn used the tiny caller cap
  assert.ok(calls[1].max_tokens >= 512);         // retried with a larger floor (>= 512)
});

test("reasoning budget: still-empty after the retry throws the empty-success refusal (no infinite loop)", async () => {
  const calls = [];
  const f = async (_url, init) => {
    calls.push(JSON.parse(init?.body || "{}"));
    return { ok: true, status: 200, text: async () => "", json: async () => ({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "still thinking" }, finish_reason: "length" }],
      usage: {},
    }) };
  };
  await assert.rejects(
    () => query("solve it", { model: "openai/gpt-oss-120b", maxTokens: 24, env: { NVIDIA_API_KEY: TEST_KEY }, fetch: f }),
    /returned no content/,
  );
  assert.equal(calls.length, 2);                 // retried once then gave up — no infinite recursion
});
