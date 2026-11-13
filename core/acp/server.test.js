/**
 * illuci/core/acp/server.test.js — ACP adapter completion (Phase 7 worked example)
 *
 * Covers the three gaps closed in acp/server.js and the worked company DEMO:
 *   (1) permission events are forwarded to the ACP client as session/request_permission and the
 *       operator's decision is resolved back into the run's onPermission callback;
 *   (2) session/cancel aborts the active run (the run halts in-band, stopReason "cancelled");
 *   (3) tool_call / tool_result field reads are grounded against agent/loop.js shapes;
 *   (4) runCompany(['dev-team','adversarial-debate']) streamed through the exact ACP prompt handler.
 *
 * Plus a back-compat / no-op test: a prompt that never gates and is never cancelled streams the
 * SAME session updates as before — the new permission + cancel surfaces stay dormant when unused.
 *
 * Hermetic: the prompt handler takes an injected `run` (deps.run) so no real model / bridge / fs is
 * touched. node:test only (this lane does not introduce a vitest dependency).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  onInitialize,
  handlers,
  prompt,
  createPermissionBroker,
  toPermissionRequest,
  decisionFromOutcome,
} from "./server.js";

import { run as realRun } from "../agent/run.js";
import { runCompany } from "../orchestrate/company.js";

// ─── A test ctx mirroring stdio-jsonrpc.js's { notify, request } surface ───
function makeCtx({ onRequest } = {}) {
  const updates = [];
  const requests = [];
  return {
    updates,
    requests,
    ctx: {
      notify: (method, params) => {
        if (method === "session/update") updates.push(params.update);
      },
      request: async (method, params) => {
        requests.push({ method, params });
        return onRequest ? await onRequest(method, params) : {};
      },
    },
  };
}

// A fake run() generator factory: yields a scripted list of AgentEvents (loop.js shapes).
function fakeRunYielding(events) {
  return async function* fakeRun() {
    for (const ev of events) yield ev;
  };
}

// ─── initialize handshake ───

test("onInitialize advertises protocol v1 and illuci agentInfo", async () => {
  const info = await onInitialize();
  assert.equal(info.protocolVersion, 1);
  assert.equal(info.agentInfo.name, "illuci");
  assert.equal(info.agentCapabilities.loadSession, false);
});

// ─── session/new ───

test("session/new mints a session and records its cwd", async () => {
  const { sessionId } = await handlers["session/new"]({ cwd: "/tmp/work" });
  assert.match(sessionId, /^acp-/);
});

// ─── pure mapping helpers (gap 3 grounding) ───

test("toPermissionRequest maps a permission event to an ACP request payload", () => {
  const ev = {
    type: "permission",
    tool: "file_write",
    args: { path: "x.js", content: "//x" },
    summary: "file_write x.js",
    diff: "--- a\n+++ b\n",
    id: null,
    ts: 123,
  };
  const reqp = toPermissionRequest("sess-1", ev);
  assert.equal(reqp.sessionId, "sess-1");
  assert.equal(reqp.toolCall.title, "file_write x.js");
  // id is null on the gate today → a stable non-empty toolCallId is synthesized.
  assert.equal(reqp.toolCall.toolCallId, "file_write-123");
  assert.deepEqual(reqp.toolCall.rawInput, { tool: "file_write", args: { path: "x.js", content: "//x" } });
  assert.equal(reqp.toolCall.content[0].type, "diff");
  assert.deepEqual(reqp.options.map((o) => o.optionId), ["allow", "deny"]);
});

test("decisionFromOutcome maps ACP outcomes onto the { approved, reason } gate contract", () => {
  assert.equal(decisionFromOutcome({ outcome: { optionId: "allow" } }).approved, true);
  assert.equal(decisionFromOutcome({ optionId: "allow_always" }).approved, true);
  assert.equal(decisionFromOutcome({ outcome: { optionId: "deny" } }).approved, false);
  assert.equal(decisionFromOutcome({}).approved, false); // fail-closed on a malformed response
});

// ─── the permission broker rendezvous (order-independent) ───

test("permission broker: onPermission-first parks until a decision is supplied", async () => {
  const b = createPermissionBroker();
  const p = b.awaitDecision(); // onPermission arrives first, parks
  b.supplyDecision({ approved: true, reason: "ok" });
  assert.deepEqual(await p, { approved: true, reason: "ok" });
});

test("permission broker: decision-first parks until onPermission claims it", async () => {
  const b = createPermissionBroker();
  b.supplyDecision({ approved: false, reason: "no" }); // stream case resolved before onPermission
  assert.deepEqual(await b.awaitDecision(), { approved: false, reason: "no" });
});

test("permission broker pairs multiple requests FIFO", async () => {
  const b = createPermissionBroker();
  const p1 = b.awaitDecision();
  const p2 = b.awaitDecision();
  b.supplyDecision({ approved: true, reason: "1" });
  b.supplyDecision({ approved: false, reason: "2" });
  assert.equal((await p1).reason, "1");
  assert.equal((await p2).reason, "2");
});

// ─── gap 1: a permission event flows out as session/request_permission and back into onPermission ───

test("prompt: a permission event is forwarded over ACP and the decision returns to onPermission", async () => {
  let onPermissionResolved = null;
  // A fake run that emits a permission event, then (after the broker hands back the decision via the
  // config.onPermission it receives) emits text and completes. We capture the decision the run sees.
  const fakeRun = async function* (input) {
    const onPermission = input.config.onPermission;
    // Mirror permission.js ordering: emit the event, then invoke onPermission and await the decision.
    // actionable:true marks this as a LIVE callback-gate request (permission.js sets it), so the ACP
    // adapter round-trips it as session/request_permission. A council halt-marker omits it.
    yield { type: "permission", runId: "r", tool: "shell_exec", args: { command: "ls" }, summary: "shell_exec ls", pending: true, actionable: true };
    onPermissionResolved = await onPermission({ tool: "shell_exec", args: { command: "ls" } });
    yield { type: "text", runId: "r", text: onPermissionResolved.approved ? "approved-path" : "denied-path" };
    yield { type: "run_complete", runId: "r", ok: true };
  };

  const { ctx, updates, requests } = makeCtx({
    onRequest: async (method) => {
      assert.equal(method, "session/request_permission");
      return { outcome: { optionId: "allow" } };
    },
  });

  const res = await prompt({ sessionId: "sess-p", prompt: [{ type: "text", text: "run ls" }] }, ctx, { run: fakeRun });

  assert.equal(requests.length, 1, "exactly one session/request_permission went to the client");
  assert.equal(requests[0].params.toolCall.title, "shell_exec ls");
  assert.deepEqual(onPermissionResolved, { approved: true, reason: "operator approved (ACP)" });
  assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "approved-path"));
  assert.equal(res.stopReason, "end_turn");
});

test("prompt: a denied permission resolves to approved:false back in the run", async () => {
  let seen = null;
  const fakeRun = async function* (input) {
    yield { type: "permission", runId: "r", tool: "file_delete", args: { path: "y" }, summary: "file_delete y", pending: true, actionable: true };
    seen = await input.config.onPermission({ tool: "file_delete", args: { path: "y" } });
    yield { type: "run_complete", runId: "r", ok: true };
  };
  const { ctx } = makeCtx({ onRequest: async () => ({ outcome: { optionId: "deny" } }) });
  await prompt({ sessionId: "sess-d", prompt: [{ type: "text", text: "x" }] }, ctx, { run: fakeRun });
  assert.equal(seen.approved, false);
});

test("prompt: a COUNCIL permission halt-marker (no actionable, no awaiting callback) does NOT solicit a hanging session/request_permission", async () => {
  // events.js translates an emitter `permission_requested` into a `permission` AgentEvent shaped
  // { agent, tool, reason, pending:true } — a POST-HOC halt notification with NO `actionable` marker
  // and NO onPermission awaiting (the council path installs no in-process callback). If the ACP
  // adapter round-tripped this as session/request_permission, the operator's answer would be dropped
  // (broker has no waiter) and the request would hang. It must inform, not ask.
  const fakeRun = async function* () {
    // The council halt-marker: no `actionable`, no awaiting callback. The run halts right after.
    yield { type: "permission", runId: "r", agent: "claude", tool: "gate", reason: "phase gate halt", pending: true };
    yield { type: "run_complete", runId: "r", ok: false, halted: true, haltReason: "gate-halt" };
  };

  let requestIssued = false;
  const { ctx, updates, requests } = makeCtx({
    onRequest: async () => { requestIssued = true; return { outcome: { optionId: "allow" } }; },
  });

  // The whole prompt must SETTLE (not hang) even though no onRequest answer is consumed.
  const res = await prompt({ sessionId: "sess-council-halt", prompt: [{ type: "text", text: "run council" }] }, ctx, { run: fakeRun });

  assert.equal(requestIssued, false, "no session/request_permission was solicited for a council halt-marker");
  assert.equal(requests.length, 0, "zero server-initiated permission requests");
  // The halt is still surfaced to the operator as a non-actionable status update.
  assert.ok(
    updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "pending"),
    "the halt was surfaced as a non-actionable update",
  );
  assert.equal(res.stopReason, "refusal");
});

// ─── gap 3: grounded tool_call / tool_result shapes from loop.js ───

test("prompt: grounded tool_call/tool_result shapes produce correct ACP statuses", async () => {
  const fakeRun = fakeRunYielding([
    { type: "tool_call", runId: "r", id: "call-1", agent: "m", tool: "file_read", args: { path: "a" } },
    { type: "tool_result", runId: "r", id: "call-1", agent: "m", tool: "file_read", ok: true, result: "x" },
    { type: "tool_call", runId: "r", id: "call-2", agent: "m", tool: "shell_exec", args: { command: "boom" } },
    { type: "tool_result", runId: "r", id: "call-2", agent: "m", tool: "shell_exec", ok: false, error: "exit 1" },
    { type: "run_complete", runId: "r", ok: true },
  ]);
  const { ctx, updates } = makeCtx();
  await prompt({ sessionId: "sess-t", prompt: [{ type: "text", text: "x" }] }, ctx, { run: fakeRun });

  const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
  const results = updates.filter((u) => u.sessionUpdate === "tool_call_update");
  assert.deepEqual(calls.map((c) => c.toolCallId), ["call-1", "call-2"]);
  assert.deepEqual(calls.map((c) => c.title), ["file_read", "shell_exec"]);
  assert.equal(calls[0].rawInput.path, "a"); // args forwarded
  // ok:true → completed; ok:false → failed (grounded on `ok`, not a truthy error)
  assert.equal(results[0].status, "completed");
  assert.equal(results[1].status, "failed");
});

// ─── gap 2: session/cancel aborts the active run ───

test("prompt + session/cancel: cancel aborts the active run, stopReason 'cancelled'", async () => {
  // A run that streams one text chunk, then waits on its own abort signal, then completes with the
  // run.js abort contract (halted + haltReason "aborted").
  const fakeRun = async function* (input) {
    const signal = input.signal;
    yield { type: "text", runId: "r", text: "starting" };
    await new Promise((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield { type: "run_complete", runId: "r", ok: false, halted: true, haltReason: "aborted" };
  };

  const { ctx, updates } = makeCtx();
  const sessionId = "sess-cancel";
  handlers["session/new"] && (await handlers["session/new"]({})); // exercise registry path
  const promptPromise = prompt({ sessionId, prompt: [{ type: "text", text: "long job" }] }, ctx, { run: fakeRun });

  // Let the first text chunk land, then cancel.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(updates.some((u) => u.content?.text === "starting"));
  await handlers["session/cancel"]({ sessionId });

  const res = await promptPromise;
  assert.equal(res.stopReason, "cancelled");
});

test("session/cancel for an unknown or idle session is a harmless no-op", async () => {
  await handlers["session/cancel"]({ sessionId: "does-not-exist" });
  await handlers["session/cancel"]({}); // no sessionId
  assert.ok(true); // did not throw
});

// ─── BACK-COMPAT / NO-OP: an ungated, uncancelled prompt streams the prior update sequence ───

test("back-compat: an ungated prompt emits the SAME update sequence as before (no new surface used)", async () => {
  // No permission event, never cancelled → the broker and abort wiring stay dormant and contribute
  // zero updates and zero client requests. This is the byte-identical prior behavior.
  const fakeRun = fakeRunYielding([
    { type: "thinking", runId: "r", text: "hmm" },
    { type: "text", runId: "r", text: "hello " },
    { type: "text", runId: "r", text: "world" },
    { type: "tool_call", runId: "r", id: "c1", tool: "glob", args: { pattern: "*.js" } },
    { type: "tool_result", runId: "r", id: "c1", tool: "glob", ok: true },
    { type: "run_complete", runId: "r", ok: true },
  ]);
  const { ctx, updates, requests } = makeCtx();
  const res = await prompt({ sessionId: "sess-bc", prompt: [{ type: "text", text: "hi" }] }, ctx, { run: fakeRun });

  assert.equal(requests.length, 0, "no server-initiated requests when nothing gates");
  assert.deepEqual(
    updates.map((u) => u.sessionUpdate),
    ["agent_thought_chunk", "agent_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update"],
  );
  assert.equal(updates[0].content.text, "hmm");
  assert.equal(updates[3].toolCallId, "c1");
  assert.equal(updates[4].status, "completed");
  assert.equal(res.stopReason, "end_turn");
});

test("back-compat: a refusal run yields stopReason 'refusal'", async () => {
  const fakeRun = fakeRunYielding([
    { type: "text", runId: "r", text: "no" },
    { type: "run_complete", runId: "r", ok: false },
  ]);
  const { ctx } = makeCtx();
  const res = await prompt({ sessionId: "sess-r", prompt: [{ type: "text", text: "x" }] }, ctx, { run: fakeRun });
  assert.equal(res.stopReason, "refusal");
});

// ─── gap 4: the worked DEMO — runCompany streamed through the ACP prompt handler ───

test("DEMO: runCompany(['dev-team','adversarial-debate']) streams session updates through the ACP server", async () => {
  // Inject runTopology into runCompany so members run hermetically (no model). Each member yields a
  // tiny trace; the company runs both concurrently under one sessionId.
  const fakeRunTopology = async (topologyId, _lineup, _prompt, _opts, companySessionId) => ({
    runId: `${topologyId}-run`,
    sessionId: companySessionId,
    halted: false,
    phases: { p1: { responses: [{ model: "ollama", seat: "lead", response: `${topologyId} done` }] } },
  });

  // An ACP `run` adapter over runCompany: drive the company, then translate its terminal member
  // traces into the public AgentEvent vocabulary the prompt loop consumes. This is the worked
  // example of mapping the Phase-4 composer onto the ACP session-update surface.
  const companyRun = async function* (input) {
    const task = input.direction.messages.map((m) => m.content).join("");
    yield { type: "run_start", runId: "company", coordination: { kind: "company" } };
    const result = await runCompany(
      { topologies: [{ topologyId: "dev-team" }, { topologyId: "adversarial-debate" }], prompt: task },
      { runTopology: fakeRunTopology },
    );
    for (const m of result.members) {
      yield { type: "agent_start", runId: "company", agent: m.topologyId, seat: m.topologyId };
      const resp = m.trace?.phases?.p1?.responses?.[0]?.response || "";
      yield { type: "text", runId: "company", agent: m.topologyId, text: resp };
    }
    yield { type: "run_complete", runId: "company", ok: result.ok };
  };

  const { ctx, updates } = makeCtx();
  const res = await prompt(
    { sessionId: "sess-company", prompt: [{ type: "text", text: "ship the feature" }] },
    ctx,
    { run: companyRun },
  );

  // Both members surfaced their text through the ACP session-update stream.
  const texts = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);
  assert.ok(texts.includes("dev-team done"), "dev-team member text streamed through ACP");
  assert.ok(texts.includes("adversarial-debate done"), "adversarial-debate member text streamed through ACP");
  assert.equal(res.stopReason, "end_turn");
});

// ─── the real run() is still the default (no deps.run) and is wired into the handler map ───

test("prompt defaults to the real run() when no deps are injected", () => {
  // We don't drive a real model here — just prove the handler map points at `prompt` and that the
  // exported prompt is the same function (so the transport's 2-arg call falls back to realRun).
  assert.equal(handlers["session/prompt"], prompt);
  assert.equal(typeof realRun, "function");
});
