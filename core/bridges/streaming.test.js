/**
 * Core-loop #4 (step 5) - real HTTP streaming for grok-api + gemini-api. Asserts each
 * bridge's queryStream parses its provider's SSE shape into { type: "delta" } chunks and
 * a single terminal { type: "final" }, with reasoning separated and the no-empty-success
 * invariant preserved. fetch is mocked (the real APIs need keys + network); the SSE parse
 * is the new logic under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as grok from "./grok-api.js";
import * as gemini from "./gemini-api.js";

/** Mock streaming Response: an async-iterable body yielding the SSE lines as bytes. */
function sseResponse(lines) {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const l of lines) yield enc.encode(l);
    })(),
  };
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("grok-api queryStream: OpenAI-compat SSE -> deltas + final + usage + sessionState", async () => {
  const fetchMock = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n',
      "data: [DONE]\n",
    ]);
  const events = await collect(grok.queryStream("hi", { fetch: fetchMock, apiKey: "test", model: "grok-x" }));
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Hello");
  const final = events.find((e) => e.type === "final");
  assert.equal(final.response, "Hello");
  assert.equal(final.usage.total_tokens, 5);
  assert.equal(final.sessionState.at(-1).content, "Hello");
  assert.equal(final.sessionState.at(-2).content, "hi");
});

test("grok-api queryStream: reasoning deltas are flagged separately", async () => {
  const fetchMock = async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n',
      "data: [DONE]\n",
    ]);
  const events = await collect(grok.queryStream("q", { fetch: fetchMock, apiKey: "test" }));
  assert.equal(events.filter((e) => e.reasoning).map((e) => e.text).join(""), "thinking");
  assert.equal(events.filter((e) => e.type === "delta" && !e.reasoning).map((e) => e.text).join(""), "answer");
});

test("gemini-api queryStream: gemini SSE -> deltas + final + usage", async () => {
  const fetchMock = async () =>
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" there"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n',
    ]);
  const events = await collect(
    gemini.queryStream("hi", { fetch: fetchMock, env: { GEMINI_API_KEY: "test" }, model: "gemini-x" }),
  );
  assert.equal(events.filter((e) => e.type === "delta").map((e) => e.text).join(""), "Hi there");
  const final = events.find((e) => e.type === "final");
  assert.equal(final.response, "Hi there");
  assert.equal(final.usage.total_tokens, 4);
});

test("gemini-api queryStream: thought parts surface as reasoning deltas", async () => {
  const fetchMock = async () =>
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"musing","thought":true},{"text":"answer"}]}}]}\n',
      'data: {"candidates":[{"finishReason":"STOP"}]}\n',
    ]);
  const events = await collect(gemini.queryStream("q", { fetch: fetchMock, env: { GEMINI_API_KEY: "test" } }));
  assert.equal(events.filter((e) => e.reasoning).map((e) => e.text).join(""), "musing");
  assert.equal(events.filter((e) => e.type === "delta" && !e.reasoning).map((e) => e.text).join(""), "answer");
});

test("gemini-api queryStream: abnormal finish with no text throws (no empty success)", async () => {
  const fetchMock = async () => sseResponse(['data: {"candidates":[{"finishReason":"SAFETY"}]}\n']);
  await assert.rejects(
    collect(gemini.queryStream("q", { fetch: fetchMock, env: { GEMINI_API_KEY: "test" } })),
    /terminated abnormally/,
  );
});
