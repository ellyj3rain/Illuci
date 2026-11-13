/**
 * illuci Agent SDK — native tool-calling path (loop → dispatch → ollama)
 *
 * Proves the three-break fix from the 2026-06 core-loop audit finding
 * "Native tool-calling is dead end-to-end":
 *   1. loop.js sends native tool DEFINITIONS (JSON schemas) with every dispatch
 *   2. dispatch.queryModelStream PRESERVES the bridge's toolCalls on the
 *      terminal final event (the explicit field list used to drop them)
 *   3. ollama.js ACCUMULATES streamed tool-call fragments (no per-chunk
 *      clobber) and maps function.arguments — object or JSON string — into
 *      illuci's { id, name, args } shape
 *
 * Hermetic (node --test): the loop test injects a fake queryModelStream; the
 * dispatch→ollama tests mock global fetch (no Ollama server, no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { run } from "./run.js";
import { parseToolCalls } from "./tool-protocol.js";
import { buildToolDefinitions, TOOL_SCHEMAS } from "./tool-defs.js";

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Fake fetch body: each line arrives as its own chunk (worst-case framing). */
function streamBody(lines) {
  return Readable.from(lines.map((l) => Buffer.from(l + "\n")));
}

// ─── Schema registry ───

test("buildToolDefinitions renders curated schemas in provider-native shape and omits unknown names", () => {
  const defs = buildToolDefinitions(["file_read", "shell_exec", "mcp__weather__forecast", "not_a_tool"]);
  assert.equal(defs.length, 2, "uncurated names are omitted, not auto-generated");
  const fr = defs.find((d) => d.function.name === "file_read");
  assert.equal(fr.type, "function");
  assert.equal(fr.function.parameters.type, "object");
  assert.ok(fr.function.parameters.properties.path, "file_read schema declares path");
  assert.deepEqual(fr.function.parameters.required, ["path"]);
  assert.ok(TOOL_SCHEMAS.shell_exec.parameters.required.includes("command"));
});

// ─── Break 1 + native honor: the loop ───

test("loop: every dispatch carries native tool definitions, and a structured tool_use on the final event is executed (no JSON-in-prose needed)", async () => {
  let turn = 0;
  const seenOptions = [];
  async function* fakeQueryModelStream(modelId, message, options) {
    seenOptions.push(options);
    turn += 1;
    if (turn === 1) {
      // A tool-call-capable model answers with NO prose JSON at all — the
      // call arrives structured on the final event, exactly as the fixed
      // dispatch now forwards it from the ollama bridge.
      yield { type: "delta", text: "", reasoning: false };
      yield {
        type: "final",
        model: modelId,
        response: "",
        toolCalls: [{ id: "call_native_1", name: "file_read", args: { path: "README.md" } }],
        usage: { total_tokens: 5 },
      };
    } else {
      yield { type: "final", model: modelId, response: "The README says hi.", usage: { total_tokens: 3 } };
    }
  }

  let executed = null;
  const events = await collect(run(
    { direction: { intent: "read the readme" }, context: {}, config: { agent: "fake", maxSteps: 4 } },
    {
      queryModelStream: fakeQueryModelStream,
      executeTool: async (name, args) => { executed = { name, args }; return { success: true, result: "hi" }; },
      toolNames: ["file_read"],
    },
  ));

  // 1. The model RECEIVED the schemas on every turn.
  assert.equal(seenOptions.length, 2);
  for (const opts of seenOptions) {
    assert.ok(Array.isArray(opts.tools), "dispatch options carry native tool definitions");
    const def = opts.tools.find((d) => d.function?.name === "file_read");
    assert.ok(def, "file_read definition was sent");
    assert.equal(def.type, "function");
    assert.ok(def.function.parameters.properties.path, "definition carries the JSON schema");
  }

  // 2. The native tool_use was HONORED: executed with the structured args,
  //    provider-issued call id preserved end-to-end on the event stream.
  assert.deepEqual(executed, { name: "file_read", args: { path: "README.md" } });
  const tc = events.find((e) => e.type === "tool_call");
  assert.equal(tc.id, "call_native_1");
  assert.equal(events.find((e) => e.type === "tool_result").ok, true);
  assert.equal(events.at(-1).type, "run_complete");
  assert.equal(events.at(-1).ok, true);
});

// ─── Breaks 2 + 3: the REAL dispatch → ollama path ───

test("dispatch→ollama (openai-compat): schemas reach the wire; fragmented streamed tool_calls are accumulated, arguments JSON-parsed, and toolCalls survive dispatch's final event", async () => {
  const { queryModelStream } = await import("../dispatch/dispatch.js");
  const tools = buildToolDefinitions(["file_read"]);

  const realFetch = globalThis.fetch;
  let wireBody = null;
  globalThis.fetch = async (url, init) => {
    wireBody = JSON.parse(init.body);
    // Spec-compliant OpenAI-compat SSE: ONE tool call arrives FRAGMENTED —
    // id+name first, then function.arguments split mid-JSON across deltas.
    return {
      ok: true,
      body: streamBody([
        'data: {"choices":[{"delta":{"content":"checking"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"file_read","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"README.md\\"}"}}]}}]}',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        "data: [DONE]",
      ]),
    };
  };

  try {
    const events = [];
    for await (const ev of queryModelStream("ollama", "read the readme", {
      raw: true,
      api: "openai",
      tools,
      _probeOllamaRoute: async () => ({ status: "reachable", staticAvailable: true, probe: "test" }),
    })) {
      events.push(ev);
    }

    // Schemas reached the provider wire format (break 1's outbound half).
    assert.ok(Array.isArray(wireBody.tools), "request body carries tools");
    assert.equal(wireBody.tools[0].function.name, "file_read");
    assert.ok(wireBody.tools[0].function.parameters.properties.path);

    // dispatch's final event preserves the bridge's toolCalls (break 2) with
    // fragments accumulated and arguments parsed (break 3).
    const final = events.find((e) => e.type === "final");
    assert.ok(final, "a final event was yielded");
    assert.deepEqual(final.toolCalls, [{ id: "call_9", name: "file_read", args: { path: "README.md" } }]);

    // And tool-protocol's priority-1 NATIVE path fires on the real shape.
    const calls = parseToolCalls(final.response || "", final);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "call_9");
    assert.equal(calls[0].name, "file_read");
    assert.deepEqual(calls[0].args, { path: "README.md" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ollama (native mode): tool calls on separate stream lines APPEND instead of clobbering, args read from function.arguments objects", async () => {
  const ollama = await import("../bridges/ollama.js");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    body: streamBody([
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"file_read","arguments":{"path":"a.md"}}}]},"done":false}',
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"glob","arguments":{"pattern":"*.js"}}}]},"done":false}',
      '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":7,"eval_count":3}',
    ]),
  });

  try {
    const events = [];
    for await (const ev of ollama.queryStream("go", { api: "native" })) events.push(ev);
    const final = events.find((e) => e.type === "final");
    assert.equal(final.toolCalls.length, 2, "the second streamed call no longer clobbers the first");
    assert.equal(final.toolCalls[0].name, "file_read");
    assert.deepEqual(final.toolCalls[0].args, { path: "a.md" });
    assert.equal(final.toolCalls[1].name, "glob");
    assert.deepEqual(final.toolCalls[1].args, { pattern: "*.js" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("ollama query() (buffered, openai-compat): stringified function.arguments are parsed into args", async () => {
  const ollama = await import("../bridges/ollama.js");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "git_commit", arguments: "{\"message\":\"x\"}" } }],
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });

  try {
    const r = await ollama.query("go", { api: "openai" });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].id, "c1");
    assert.equal(r.toolCalls[0].name, "git_commit");
    assert.deepEqual(r.toolCalls[0].args, { message: "x" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
