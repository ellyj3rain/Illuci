/**
 * Phase 2 — a topology seat that runs the agent loop and can call in-context tools.
 * Hermetic: a fake queryModelStream drives the loop (turn 1 emits a query_sibling
 * tool call, turn 2 emits the final answer), and the in-context tool handler is a
 * fake. No real model, bridge, or filesystem.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeatToolBridge, runSeatLoop } from "./seat-loop.js";

test("buildSeatToolBridge exposes tools in the mcpTools shape the loop consumes", async () => {
  const bridge = buildSeatToolBridge([
    {
      name: "query_sibling",
      description: "ask a peer",
      parameters: { properties: { model: {}, prompt: {} } },
      handler: async (a) => `peer:${a.model}`,
    },
  ]);
  assert.deepEqual(bridge.toolNames, ["query_sibling"]);
  assert.ok(bridge.has("query_sibling"));
  assert.match(bridge.instructions, /query_sibling/);
  const r = await bridge.execute("query_sibling", { model: "grok-cli", prompt: "hi" });
  assert.equal(r.success, true);
  assert.equal(r.result, "peer:grok-cli");
  const unknown = await bridge.execute("nope", {});
  assert.equal(unknown.success, false);
});

test("buildSeatToolBridge surfaces a handler throw as a failed tool result, never a crash", async () => {
  const bridge = buildSeatToolBridge([
    { name: "boom", parameters: {}, handler: async () => { throw new Error("kaboom"); } },
  ]);
  const r = await bridge.execute("boom", {});
  assert.equal(r.success, false);
  assert.match(r.error, /kaboom/);
});

test("runSeatLoop: a seat completes a multi-step loop and reaches the in-context tool", async () => {
  let turn = 0;
  async function* fakeQuery(modelId) {
    turn += 1;
    if (turn === 1) {
      yield {
        type: "final",
        model: modelId,
        response: 'consulting a peer: {"tool_calls":[{"tool":"query_sibling","args":{"model":"grok-cli","prompt":"sanity check"}}]}',
        usage: { total_tokens: 6 },
      };
    } else {
      yield { type: "final", model: modelId, response: "Final answer, informed by the sibling.", usage: { total_tokens: 4 } };
    }
  }
  let sibCalled = null;
  const fakeSibling = {
    name: "query_sibling",
    description: "query a sibling model",
    parameters: { properties: { model: {}, prompt: {} } },
    handler: async (a) => { sibCalled = a; return "sibling: looks good"; },
  };

  const out = await runSeatLoop(
    { model: "fake", message: "do the thing", seat: "architect", roleHint: "architect", tools: [fakeSibling], maxSteps: 4 },
    { queryModelStream: fakeQuery, executeTool: async () => ({ success: true }), toolNames: ["file_read"] },
  );

  assert.deepEqual(sibCalled, { model: "grok-cli", prompt: "sanity check" }, "the loop reached the in-context query_sibling tool");
  assert.match(out.response, /Final answer, informed by the sibling/);
  assert.equal(out.error, null);
  assert.equal(out.seat, "architect");
  assert.equal(out.model, "fake");
  assert.ok(out.usage, "usage propagated");
  assert.ok(turn >= 2, "the seat took more than one turn (it looped)");
});

test("runSeatLoop: a single-shot seat (no tool calls) returns the model's answer", async () => {
  async function* fakeQuery(modelId) {
    yield { type: "delta", text: "thinking ", reasoning: false };
    yield { type: "final", model: modelId, response: "Direct answer, no tools.", usage: { total_tokens: 3 } };
  }
  const out = await runSeatLoop(
    { model: "fake", message: "answer", seat: "reviewer", tools: [], maxSteps: 3 },
    { queryModelStream: fakeQuery, executeTool: async () => ({ success: true }), toolNames: [] },
  );
  assert.match(out.response, /Direct answer/);
  assert.equal(out.error, null);
  assert.equal(out.seat, "reviewer");
});

test("runSeatLoop: a fatal model error surfaces as error + null response", async () => {
  async function* erroring() {
    yield { type: "error", model: "fake", error: "provider exploded" };
  }
  const out = await runSeatLoop(
    { model: "fake", message: "x", seat: "qa", tools: [] },
    { queryModelStream: erroring, executeTool: async () => ({ success: true }), toolNames: [] },
  );
  assert.match(out.error, /provider exploded/);
  assert.equal(out.response, null);
});

test("runSeatLoop: threads skillGrants into the tool-exec context (DR-112 gate is live on the loop path)", async () => {
  // Regression guard: the seat-loop is the only path where a seat actually calls tools,
  // so it is the only path where the skill-license gate can bite. If skillGrants does not
  // reach the toolCtx the chokepoint (executeTool) receives, off-floor MCP goes ungated
  // on exactly this branch. Prove the grant object arrives at executeTool unchanged.
  let turn = 0;
  async function* fakeQuery(modelId) {
    turn += 1;
    if (turn === 1) {
      yield {
        type: "final",
        model: modelId,
        response: 'reading a file: {"tool_calls":[{"tool":"file_read","args":{"path":"VERSION"}}]}',
        usage: { total_tokens: 5 },
      };
    } else {
      yield { type: "final", model: modelId, response: "done", usage: { total_tokens: 2 } };
    }
  }
  let seenCtx = null;
  const spyExec = async (_name, _args, ctx) => { seenCtx = ctx; return { success: true }; };
  // Shape matches resolveSeatGrants output: a Set of licensed bridges + skillIds.
  const grants = { toolWeights: {}, mcpBridges: new Set(["mem0"]), invariants: [], autonomy: {}, skillIds: ["deploy"] };
  const cwd = process.cwd();

  const out = await runSeatLoop(
    { model: "fake", message: "go", seat: "architect", skillGrants: grants, tools: [], maxSteps: 4, cwd },
    { queryModelStream: fakeQuery, executeTool: spyExec, toolNames: ["file_read"] },
  );

  assert.ok(seenCtx, "the loop reached executeTool");
  assert.equal(seenCtx.skillGrants, grants, "skillGrants threaded runSeatLoop -> run -> loop -> toolCtx unchanged");
  assert.equal(seenCtx.workspaceRoot, cwd, "cwd threads into built-in tool context as workspaceRoot");
  assert.equal(out.error, null);
});

test("runSeatLoop: no skillGrants → toolCtx.skillGrants is null (floor governs, seats without skills unchanged)", async () => {
  let turn = 0;
  async function* fakeQuery(modelId) {
    turn += 1;
    if (turn === 1) {
      yield { type: "final", model: modelId, response: '{"tool_calls":[{"tool":"file_read","args":{"path":"VERSION"}}]}', usage: { total_tokens: 4 } };
    } else {
      yield { type: "final", model: modelId, response: "done", usage: { total_tokens: 2 } };
    }
  }
  let seenCtx = null;
  const spyExec = async (_name, _args, ctx) => { seenCtx = ctx; return { success: true }; };
  await runSeatLoop(
    { model: "fake", message: "go", seat: "architect", tools: [], maxSteps: 4 },
    { queryModelStream: fakeQuery, executeTool: spyExec, toolNames: ["file_read"] },
  );
  assert.ok(seenCtx, "the loop reached executeTool");
  assert.equal(seenCtx.skillGrants, null, "absent grants → null, so the chokepoint no-ops (floor governs)");
});
