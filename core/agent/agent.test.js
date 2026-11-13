/**
 * illuci Agent SDK — tests (node --test)
 *
 * Hermetic: no real model, bridge, or filesystem. run() takes an internal deps
 * seam so the loop and council are driven by fakes. The gate-controller routing
 * test exercises the real callback-gate branch against a fresh (no-context)
 * approval context, where evaluate() deterministically returns "gate".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EventStream } from "./stream.js";
import { agentEvent, translateEmitterEvent } from "./events.js";
import { parseToolCalls, buildToolInstructions, looksLikeToolAttempt } from "./tool-protocol.js";
import { withPermissionChannel } from "./permission.js";
import { run } from "./run.js";
import {
  registerApprovalCallback,
  clearApprovalCallback,
  hasApprovalCallback,
  requestCallbackApproval,
} from "../gates/callback-gate.js";
import { connectMcpTools } from "./mcp-tools.js";
import { connectMcpServer } from "../tools/mcp-client.js";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";

async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// ─── EventStream ───

test("EventStream delivers buffered events in order, then closes", async () => {
  const s = new EventStream();
  s.push({ n: 1 });
  s.push({ n: 2 });
  s.close();
  const got = [];
  for await (const e of s) got.push(e.n);
  assert.deepEqual(got, [1, 2]);
});

test("EventStream resolves a pending waiter on a later push", async () => {
  const s = new EventStream();
  const it = s[Symbol.asyncIterator]();
  const pending = it.next(); // no events yet → waiter parked
  s.push({ n: 7 });
  const r = await pending;
  assert.equal(r.done, false);
  assert.equal(r.value.n, 7);
  s.close();
});

// ─── Tool protocol (hybrid) ───

test("parseToolCalls: native tool_calls from the final event", () => {
  const calls = parseToolCalls("", { tool_calls: [{ tool: "file_read", args: { path: "a" } }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "file_read");
  assert.equal(calls[0].args.path, "a");
});

test("parseToolCalls: JSON tool_calls embedded in prose", () => {
  const calls = parseToolCalls('sure thing: {"tool_calls":[{"tool":"glob","args":{"pattern":"*.js"}}]} ok');
  assert.equal(calls[0].name, "glob");
  assert.equal(calls[0].args.pattern, "*.js");
});

test("parseToolCalls: write-mode operations map onto file_* calls", () => {
  const calls = parseToolCalls('```json\n{"operations":[{"type":"create","path":"x.js","content":"//x"},{"type":"delete","path":"y.js"}]}\n```');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "file_write");
  assert.equal(calls[0].args.path, "x.js");
  assert.equal(calls[1].name, "file_delete");
});

test("parseToolCalls: a plain final answer yields no calls", () => {
  assert.deepEqual(parseToolCalls("Here is the final answer, no tools needed."), []);
});

test("buildToolInstructions is empty without tools, lists them otherwise", () => {
  assert.equal(buildToolInstructions([]), "");
  assert.match(buildToolInstructions(["file_read", "glob"]), /file_read, glob/);
});

// ─── Event vocabulary ───

test("agentEvent stamps type/ts/runId and rejects unknown types", () => {
  const e = agentEvent("text", "r1", { text: "hi" });
  assert.equal(e.type, "text");
  assert.equal(e.runId, "r1");
  assert.equal(typeof e.ts, "number");
  assert.throws(() => agentEvent("bogus", "r1"));
});

test("translateEmitterEvent maps phase/message, drops visualizer-only events", () => {
  assert.equal(translateEmitterEvent({ type: "message", sessionId: "r", payload: { agent: "a", content: "x" } }, "r").type, "text");
  assert.equal(translateEmitterEvent({ type: "phase_start", payload: { phaseId: "p" } }, "r").type, "phase");
  assert.equal(translateEmitterEvent({ type: "phase_complete", payload: { phaseId: "p" } }, "r").type, "phase");
  assert.equal(translateEmitterEvent({ type: "context_update", payload: {} }, "r"), null);
  assert.equal(translateEmitterEvent({ type: "tool_call_start", payload: {} }, "r"), null); // phase marker, not a real tool
  assert.equal(translateEmitterEvent({ type: "agent_spawn", payload: { isMain: true } }, "r"), null);
  assert.equal(translateEmitterEvent({ type: "agent_spawn", payload: { model: "ollama", task: "seat-a" } }, "r").type, "agent_start");
});

// ─── Callback gate + gate-controller routing ───

test("callback-gate: register/has/clear and fail-closed when none", async () => {
  assert.equal(hasApprovalCallback(), false);
  registerApprovalCallback(async () => ({ approved: true, reason: "ok" }));
  assert.equal(hasApprovalCallback(), true);
  assert.equal((await requestCallbackApproval({ tool: "file_write", args: {} })).approved, true);
  clearApprovalCallback();
  assert.equal(hasApprovalCallback(), false);
  assert.equal((await requestCallbackApproval({ tool: "file_write", args: {} })).approved, false);
});

test("gate-controller routes a gated, out-of-scope action to the registered callback", async () => {
  const { requestApproval } = await import("../gates/gate-controller.js");
  const { clearApprovalContext } = await import("../gates/approval-context.js");
  clearApprovalContext(); // fresh → evaluate() returns "gate" for a write
  let seenTool = null;
  registerApprovalCallback(async (p) => { seenTool = p.tool; return { approved: true, reason: "test-approved" }; });
  try {
    const d = await requestApproval({ tool: "file_write", args: { path: "/tmp/illuci-agent-test.txt" } });
    assert.equal(seenTool, "file_write");
    assert.equal(d.approved, true);
    assert.equal(d.reason, "test-approved");
  } finally {
    clearApprovalCallback();
  }
});

// ─── Permission channel ───

test("withPermissionChannel emits a permission event and defers to onPermission", async () => {
  const events = [];
  const onPermission = async () => ({ approved: true, reason: "yes" });
  const result = await withPermissionChannel(
    { runId: "r", onPermission, emit: (ev) => events.push(ev) },
    async () => requestCallbackApproval({ tool: "file_write", args: { path: "z" }, source: { model: "m", seat: "s" } }),
  );
  assert.equal(result.approved, true);
  const perm = events.find((e) => e.type === "permission");
  assert.ok(perm, "a permission event was emitted");
  assert.equal(perm.tool, "file_write");
  assert.equal(hasApprovalCallback(), false); // cleared on exit
});

test("withPermissionChannel without onPermission registers nothing (env-routed fallback)", async () => {
  const registeredInside = await withPermissionChannel(
    { runId: "r", emit: () => {} },
    async () => hasApprovalCallback(),
  );
  assert.equal(registeredInside, false);
});

// ─── Full run(): single-agent loop ───

test("run(): single agent streams text → tool_call → tool_result → synthesis → run_complete", async () => {
  let turn = 0;
  async function* fakeQueryModelStream(modelId) {
    turn += 1;
    if (turn === 1) {
      yield { type: "delta", text: "let me check", reasoning: false };
      yield { type: "final", model: modelId, response: 'plan: {"tool_calls":[{"tool":"file_read","args":{"path":"README.md"}}]}', usage: { total_tokens: 5 } };
    } else {
      yield { type: "delta", text: "done", reasoning: false };
      yield { type: "final", model: modelId, response: "All set. The file says hi.", usage: { total_tokens: 4 } };
    }
  }
  let executed = null;
  async function fakeExecuteTool(name, args) {
    executed = { name, args };
    return { success: true, result: { content: "hi" } };
  }

  const events = await collect(run(
    { direction: { intent: "read the readme" }, context: {}, config: { agent: "fake", maxSteps: 5 } },
    { queryModelStream: fakeQueryModelStream, executeTool: fakeExecuteTool, toolNames: ["file_read"] },
  ));

  const types = events.map((e) => e.type);
  assert.equal(types[0], "run_start");
  assert.ok(types.includes("agent_start"));
  assert.ok(types.includes("text"));
  assert.ok(types.includes("tool_call"));
  assert.ok(types.includes("tool_result"));
  assert.ok(types.includes("synthesis"));
  assert.equal(types[types.length - 1], "run_complete");

  assert.deepEqual(executed, { name: "file_read", args: { path: "README.md" } });
  assert.equal(events.find((e) => e.type === "tool_result").ok, true);
  const synth = events.find((e) => e.type === "synthesis");
  assert.match(synth.text, /All set/);
  assert.equal(events.at(-1).ok, true);
});

test("run(): single agent surfaces a model stream error in-band", async () => {
  async function* erroringStream() {
    yield { type: "error", model: "fake", error: "provider exploded" };
  }
  const events = await collect(run(
    { direction: { intent: "x" }, context: {}, config: { agent: "fake" } },
    { queryModelStream: erroringStream, executeTool: async () => ({ success: true }), toolNames: [] },
  ));
  const err = events.find((e) => e.type === "error");
  assert.ok(err);
  assert.match(err.error, /provider exploded/);
  assert.equal(events.at(-1).type, "run_complete");
  assert.equal(events.at(-1).ok, false);
});

test("run(): a paused model halts as non-success, never a silent empty success", async () => {
  // dispatch yields a skipped final (response:null, reason:"paused") for a paused
  // model. The loop must surface that honestly, NOT coerce null to "" and report ok:true.
  async function* pausedStream() {
    yield { type: "final", model: "fake", response: null, skipped: true, reason: "paused", usage: {} };
  }
  const events = await collect(run(
    { direction: { intent: "x" }, context: {}, config: { agent: "fake" } },
    { queryModelStream: pausedStream, executeTool: async () => ({ success: true }), toolNames: [] },
  ));
  const err = events.find((e) => e.type === "error" && e.skipped);
  assert.ok(err, "a skipped/paused error event is emitted");
  assert.equal(err.reason, "paused");
  // no synthesis was emitted (the silent-success path is not taken)
  assert.equal(events.some((e) => e.type === "synthesis"), false);
  assert.equal(events.at(-1).type, "run_complete");
  assert.equal(events.at(-1).ok, false);
});

// ─── Full run(): council ───

test("run(): council streams phase + filtered text + synthesis from the trace", async () => {
  let captured = null;
  const fakeOnEvent = (listener) => { captured = listener; return () => { captured = null; }; };
  async function fakeRunTopology(topologyId, lineup, prompt, opts, sid) {
    assert.equal(topologyId, "co-operative");
    assert.equal(lineup.a, "ollama");
    captured({ type: "phase_start", sessionId: sid, payload: { phaseId: "p1", phaseType: "parallel", seats: ["a"] } });
    captured({ type: "message", sessionId: sid, payload: { agent: "a:ollama", content: "thinking out loud", role: "assistant" } });
    captured({ type: "message", sessionId: "other-run", payload: { agent: "x", content: "noise from another run" } });
    captured({ type: "phase_complete", sessionId: sid, payload: { phaseId: "p1", latency: 3, totalTokens: 9, responseCount: 1 } });
    return { phases: { p1: { responses: [{ model: "ollama", seat: "a", response: "council answer", usage: { total_tokens: 9 } }] } }, halted: false };
  }

  const events = await collect(run(
    { direction: { intent: "design X" }, context: { session: "run-council-1" }, config: { coordination: { topology: "co-operative", lineup: { a: "ollama" } } } },
    { runTopology: fakeRunTopology, onEvent: fakeOnEvent },
  ));

  const types = events.map((e) => e.type);
  assert.equal(types[0], "run_start");
  const phases = events.filter((e) => e.type === "phase");
  assert.ok(phases.some((p) => p.phase === "start"));
  assert.ok(phases.some((p) => p.phase === "complete"));

  const texts = events.filter((e) => e.type === "text");
  assert.equal(texts.length, 1, "the other run's event was filtered by sessionId");
  assert.equal(texts[0].text, "thinking out loud");

  const synth = events.find((e) => e.type === "synthesis");
  assert.equal(synth.text, "council answer");
  assert.equal(events.at(-1).type, "run_complete");
  assert.equal(events.at(-1).ok, true);
});

// ─── MCP capability expansion (client side) ───

test("connectMcpTools namespaces tools, builds instructions, and gates calls", async () => {
  const fakeClient = {
    name: "weather",
    listTools: async () => [
      { name: "forecast", description: "get a forecast", inputSchema: { type: "object", properties: { city: {} } } },
    ],
    callTool: async (tool, args) => ({ ok: true, content: [{ type: "text", text: `forecast for ${args.city}` }] }),
    close: async () => {},
  };

  // Approve path
  const bridge = await connectMcpTools(
    [{ name: "weather", command: "x" }],
    { connectMcpServer: async () => fakeClient, requestApproval: async () => ({ approved: true }) },
  );
  assert.deepEqual(bridge.toolNames, ["mcp__weather__forecast"]);
  assert.ok(bridge.has("mcp__weather__forecast"));
  assert.match(bridge.instructions, /mcp__weather__forecast/);
  const ok = await bridge.execute("mcp__weather__forecast", { city: "NYC" });
  assert.equal(ok.success, true);
  assert.match(ok.result, /forecast for NYC/);

  // Deny path — the gate refuses, the call never reaches the server
  const denied = await connectMcpTools(
    [{ name: "weather", command: "x" }],
    { connectMcpServer: async () => fakeClient, requestApproval: async () => ({ approved: false, reason: "no" }) },
  );
  const d = await denied.execute("mcp__weather__forecast", { city: "NYC" });
  assert.equal(d.success, false);
  assert.equal(d.blocked, true);
});

test("run(): single agent routes an MCP tool call to the bridge", async () => {
  let turn = 0;
  async function* fakeQuery(modelId) {
    turn += 1;
    if (turn === 1) {
      yield { type: "final", model: modelId, response: 'checking: {"tool_calls":[{"tool":"mcp__weather__forecast","args":{"city":"NYC"}}]}', usage: { total_tokens: 5 } };
    } else {
      yield { type: "final", model: modelId, response: "It will be sunny in NYC.", usage: { total_tokens: 3 } };
    }
  }
  let mcpCalled = null;
  const fakeMcp = {
    toolNames: ["mcp__weather__forecast"],
    instructions: "\n## External tools (MCP)\n- mcp__weather__forecast: forecast\n",
    has: (n) => n === "mcp__weather__forecast",
    execute: async (n, a) => { mcpCalled = { n, a }; return { success: true, result: "sunny, 72F" }; },
    close: async () => {},
  };

  const events = await collect(run(
    { direction: { intent: "weather in NYC?" }, context: {}, config: { agent: "fake", maxSteps: 4 } },
    { queryModelStream: fakeQuery, executeTool: async () => ({ success: true }), toolNames: ["file_read"], mcpTools: fakeMcp },
  ));

  assert.deepEqual(mcpCalled, { n: "mcp__weather__forecast", a: { city: "NYC" } });
  const tr = events.find((e) => e.type === "tool_result");
  assert.equal(tr.tool, "mcp__weather__forecast");
  assert.equal(tr.ok, true);
  const synth = events.find((e) => e.type === "synthesis");
  assert.match(synth.text, /sunny in NYC/);
  assert.equal(events.at(-1).type, "run_complete");
});

test("mcp-client: connect, list, and call against a real stdio MCP server", async () => {
  const fixture = fileURLToPath(new URL("./mcp-fake-server.fixture.mjs", import.meta.url));
  const client = await connectMcpServer({ name: "fake", command: process.execPath, args: [fixture] });
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    const r = await client.callTool("echo", { msg: "hi" });
    assert.equal(r.ok, true);
    assert.match(JSON.stringify(r.content), /echo:/);
  } finally {
    await client.close();
  }
});

test("mcp-client: failed stdio startup reports the useful stderr line", async () => {
  const fixture = join(tmpdir(), `illuci-mcp-failing-server-${process.pid}.mjs`);
  writeFileSync(
    fixture,
    "console.error('Startup failed: GroundingError: ILLUCI_GROUNDING_EPHEMERAL: refused');\nconsole.error('}');\nprocess.exit(1);\n",
    "utf8",
  );
  try {
    await assert.rejects(
      () => connectMcpServer({ name: "failing", command: process.execPath, args: [fixture], timeoutMs: 1000 }),
      /ILLUCI_GROUNDING_EPHEMERAL/,
    );
  } finally {
    if (existsSync(fixture)) unlinkSync(fixture);
  }
});

// ─── Tool-protocol repair: zero parsed calls must not silently terminate as success ───

test("looksLikeToolAttempt: flags malformed tool syntax, never plain prose", () => {
  assert.equal(looksLikeToolAttempt('{"tool_calls":[{"tool":"file_read","args":{"path":'), true); // truncated JSON
  assert.equal(looksLikeToolAttempt("```tool\n{ not json }\n```"), true);
  assert.equal(looksLikeToolAttempt('{"operations": [oops'), true);
  assert.equal(looksLikeToolAttempt("Here is the final answer, no tools needed."), false);
  assert.equal(looksLikeToolAttempt(""), false);
  assert.equal(looksLikeToolAttempt("I considered tool_calls but the task is done."), false); // mention, not attempt
});

test("run(): a malformed tool attempt gets a bounded repair re-prompt, then succeeds", async () => {
  let turn = 0;
  const prompts = [];
  async function* fakeQuery(modelId, message) {
    prompts.push(message);
    turn += 1;
    if (turn === 1) {
      // Looks like a tool call but the JSON is truncated → parseToolCalls() yields zero calls.
      yield { type: "final", model: modelId, response: '{"tool_calls":[{"tool":"file_read","args":{"path":', usage: { total_tokens: 2 } };
    } else if (turn === 2) {
      yield { type: "final", model: modelId, response: '{"tool_calls":[{"tool":"file_read","args":{"path":"README.md"}}]}', usage: { total_tokens: 3 } };
    } else {
      yield { type: "final", model: modelId, response: "The file says hi.", usage: { total_tokens: 2 } };
    }
  }
  let executed = null;
  const events = await collect(run(
    { direction: { intent: "read the readme" }, context: {}, config: { agent: "fake", maxSteps: 6 } },
    {
      queryModelStream: fakeQuery,
      executeTool: async (name, args) => { executed = { name, args }; return { success: true, result: "hi" }; },
      toolNames: ["file_read"],
    },
  ));

  const repair = events.find((e) => e.type === "error" && e.fatal === false);
  assert.ok(repair, "a non-fatal repair event was emitted");
  assert.equal(repair.repair.attempt, 1);
  assert.equal(repair.repair.reason, "unparsed");
  assert.match(prompts[1], /no tool call could be parsed/); // the corrective instruction reached the model
  assert.deepEqual(executed, { name: "file_read", args: { path: "README.md" } }); // the repaired call executed
  const synth = events.find((e) => e.type === "synthesis");
  assert.match(synth.text, /file says hi/i);
  assert.equal(synth.malformed, undefined); // a clean ending stays unmarked
  assert.equal(events.at(-1).ok, true);
});

test("run(): the repair budget is bounded and exhaustion is marked malformed, not silent", async () => {
  let turns = 0;
  async function* alwaysMalformed(modelId) {
    turns += 1;
    yield { type: "final", model: modelId, response: '{"tool_calls":[{"tool":"file_read"', usage: { total_tokens: 1 } };
  }
  const events = await collect(run(
    { direction: { intent: "x" }, context: {}, config: { agent: "fake", maxSteps: 10, maxRepairs: 2 } },
    { queryModelStream: alwaysMalformed, executeTool: async () => ({ success: true }), toolNames: ["file_read"] },
  ));
  assert.equal(turns, 3); // the initial turn + 2 repairs: bounded, NOT maxSteps
  assert.equal(events.filter((e) => e.type === "error" && e.fatal === false).length, 2);
  const synth = events.find((e) => e.type === "synthesis");
  assert.equal(synth.malformed, true); // the silent-success path is closed
  assert.equal(events.at(-1).type, "run_complete");
});

test("run(): an empty model turn triggers a repair, not an empty 'success'", async () => {
  let turn = 0;
  async function* emptyThenAnswer(modelId) {
    turn += 1;
    if (turn === 1) {
      yield { type: "final", model: modelId, response: "", usage: { total_tokens: 0 } };
    } else {
      yield { type: "final", model: modelId, response: "Recovered final answer.", usage: { total_tokens: 2 } };
    }
  }
  const events = await collect(run(
    { direction: { intent: "x" }, context: {}, config: { agent: "fake", maxSteps: 4 } },
    { queryModelStream: emptyThenAnswer, executeTool: async () => ({ success: true }), toolNames: [] },
  ));
  const repair = events.find((e) => e.type === "error" && e.fatal === false);
  assert.ok(repair, "the empty turn produced a repair event");
  assert.equal(repair.repair.reason, "empty");
  assert.match(events.find((e) => e.type === "synthesis").text, /Recovered final answer/);
  assert.equal(events.at(-1).ok, true);
});

// ─── Cancellation: abandoning or aborting a run stops the producer ───
// Regression for core-loop audit structural cause #3 ("Nothing can be
// cancelled"): breaking out of run()'s iterator used to leave the producer
// looping — the next model turn's tool calls still executed, writing files
// after the consumer was gone.

test("run(): abandoning the stream aborts the producer — no sentinel file after abandon", async () => {
  const sentinel = join(tmpdir(), `illuci-abandon-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  let consumerGone;
  const abandoned = new Promise((resolve) => { consumerGone = resolve; });
  let turns = 0;

  async function* fakeQueryModelStream(modelId) {
    turns += 1;
    yield { type: "delta", text: "working", reasoning: false };
    // Stall the turn until the consumer has walked away, THEN hand back a
    // file_write tool call — the pre-fix producer executed it regardless.
    await abandoned;
    yield {
      type: "final",
      model: modelId,
      response: `{"tool_calls":[{"tool":"file_write","args":{"path":${JSON.stringify(sentinel)},"content":"leaked"}}]}`,
      usage: { total_tokens: 1 },
    };
  }
  async function fakeExecuteTool(name, args) {
    writeFileSync(args.path, args.content ?? "leaked");
    return { success: true, result: "written" };
  }

  try {
    const it = run(
      { direction: { intent: "x" }, context: {}, config: { agent: "fake", maxSteps: 5 } },
      { queryModelStream: fakeQueryModelStream, executeTool: fakeExecuteTool, toolNames: ["file_write"] },
    );
    for await (const ev of it) {
      if (ev.type === "text") break; // the consumer abandons mid-run
    }
    consumerGone(); // the producer's stalled turn now completes with the tool call
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the orphaned producer settle

    assert.equal(existsSync(sentinel), false, "abandoned run executed a tool: sentinel file leaked");
    assert.equal(turns, 1, "the producer started another turn after abandonment");
  } finally {
    if (existsSync(sentinel)) unlinkSync(sentinel);
  }
});

test("run(): aborting input.signal halts the run in-band with haltReason 'aborted'", async () => {
  const ac = new AbortController();
  let releaseFinal;
  const finalGate = new Promise((resolve) => { releaseFinal = resolve; });
  let toolExecuted = false;
  let turns = 0;

  async function* fakeQueryModelStream(modelId) {
    turns += 1;
    yield { type: "delta", text: "thinking", reasoning: false };
    await finalGate; // the abort lands while this turn is in flight
    yield {
      type: "final",
      model: modelId,
      response: '{"tool_calls":[{"tool":"file_write","args":{"path":"x.txt","content":"y"}}]}',
      usage: { total_tokens: 1 },
    };
  }

  const events = [];
  const it = run(
    { direction: { intent: "x" }, signal: ac.signal, context: {}, config: { agent: "fake", maxSteps: 5 } },
    {
      queryModelStream: fakeQueryModelStream,
      executeTool: async () => { toolExecuted = true; return { success: true }; },
      toolNames: ["file_write"],
    },
  );
  for await (const ev of it) {
    events.push(ev);
    if (ev.type === "text") {
      ac.abort(); // abort first…
      releaseFinal(); // …then let the in-flight turn produce its tool call
    }
  }

  const done = events.at(-1);
  assert.equal(done.type, "run_complete");
  assert.equal(done.halted, true);
  assert.equal(done.haltReason, "aborted");
  assert.equal(done.ok, false);
  assert.equal(toolExecuted, false, "a tool executed after the abort");
  assert.equal(turns, 1);
});
