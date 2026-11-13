// illuci's ACP (Agent Client Protocol) adapter: a substrate-owned protocol skin over illuci's run loop.
// Hand-rolled per the adversarial-debate ruling — no @zed-industries/agent-client-protocol runtime
// dependency. Wire shapes grounded in the ACP SDK schema (camelCase); transport reused from
// core/protocol/stdio-jsonrpc.js; agent turn delegated to core/agent/run.js.
//
// Phase 7 completion (the worked example). Three gaps closed against the REAL agent surfaces:
//   1. permission — the stream's `permission` AgentEvent (agent/permission.js emits it with
//      { id, agent, seat, tool, args, level, source, diff, summary, pending }) is now forwarded to
//      the ACP client as a server-initiated session/request_permission; the operator's decision is
//      resolved back into the config.onPermission callback via a per-prompt rendezvous broker.
//   2. cancellation — session/cancel now aborts the active run via the AbortController threaded into
//      run({ signal }) by the prompt handler; the loop halts in-band (haltReason "aborted").
//   3. grounded field shapes — tool_call/tool_result/permission reads are grounded against
//      agent/loop.js (tool_call: { id, tool, args }; tool_result: { id, tool, ok, error }) and
//      agent/permission.js, with the defensive fallbacks kept only as a belt-and-braces second read.
//
// The runner is injected (deps.run, default = the real run) so the worked DEMO test can stream a
// runCompany(['dev-team','adversarial-debate']) through this exact handler surface. stdio-jsonrpc.js
// is untouched. Every change is additive: an unused permission/cancel surface leaves the prior
// session/new + session/prompt streaming behavior intact.
import { pathToFileURL } from "node:url";
import { serveJsonRpcStdio } from "../protocol/stdio-jsonrpc.js";
import { run as realRun } from "../agent/run.js";

const PROTOCOL_VERSION = 1;
const sessions = new Map(); // sessionId -> { cwd, abort? }

const newSessionId = () => `acp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function onInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "illuci", version: "0.1.0" },
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
    authMethods: [],
  };
}

/**
 * Per-prompt rendezvous between the in-process gate callback (config.onPermission, which runs
 * INSIDE the run producer and must return a { approved, reason } decision) and the ACP client
 * (reached only from the stream consumer, via ctx.request). agent/permission.js emits the
 * `permission` AgentEvent BEFORE it invokes onPermission, so the two halves can arrive in either
 * order. The broker pairs them FIFO — matching illuci's ratified one-active-gated-run-per-process
 * posture, where gated tool calls are requested and awaited one at a time — and is robust to order:
 *   - onPermission first  → a waiter parks until the stream case supplies the request payload.
 *   - permission event first → the request payload parks until onPermission claims it.
 * A request that is answered before onPermission ever runs (e.g. the run ends) is simply dropped.
 */
function createPermissionBroker() {
  const waiters = []; // onPermission calls awaiting a stream-driven decision
  const ready = [];   // stream cases that produced a decision before onPermission claimed it

  // Called by config.onPermission. Returns a promise for the operator's { approved, reason }.
  const awaitDecision = () =>
    new Promise((resolve) => {
      const pending = ready.shift();
      if (pending) resolve(pending);
      else waiters.push(resolve);
    });

  // Called by the stream's `permission` case once ctx.request resolves. Hands the decision to the
  // oldest waiting onPermission, or parks it for the next onPermission call.
  const supplyDecision = (decision) => {
    const waiter = waiters.shift();
    if (waiter) waiter(decision);
    else ready.push(decision);
  };

  return { awaitDecision, supplyDecision };
}

/**
 * Map a `permission` AgentEvent (agent/permission.js shape) to an ACP session/request_permission
 * payload. Grounded fields first, defensive fallbacks second.
 */
function toPermissionRequest(sessionId, ev = {}) {
  // permission.js emits `id` from params.requestId/id (null today — the gate has no requestId),
  // so fall back to the tool name + a stamp to keep toolCallId stable & non-empty for the client.
  const toolCallId = String(ev.toolCallId ?? ev.id ?? `${ev.tool ?? "tool"}-${ev.ts ?? Date.now()}`);
  const toolCall = {
    toolCallId,
    title: ev.summary || ev.tool || ev.title || "action",
    // The ACP client renders these for the operator; all are optional per the schema.
    ...(ev.tool ? { rawInput: { tool: ev.tool, args: ev.args ?? {} } } : {}),
    ...(ev.diff ? { content: [{ type: "diff", diff: ev.diff }] } : {}),
  };
  return {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Reject", kind: "reject_once" },
    ],
  };
}

/** Resolve an ACP request_permission response into a illuci gate decision { approved, reason }. */
function decisionFromOutcome(res) {
  const chosen = res?.outcome?.optionId ?? res?.optionId ?? res?.outcome?.outcome;
  const approved = chosen === "allow" || chosen === "allow_once" || chosen === "allow_always";
  return { approved, reason: approved ? "operator approved (ACP)" : "operator denied (ACP)" };
}

async function prompt(params, ctx, deps = {}) {
  const run = deps.run || realRun;
  const { sessionId, prompt: blocks = [] } = params;
  const sess = sessions.get(sessionId) || { cwd: process.cwd() };
  const text = blocks.map((b) => (b && b.type === "text" ? b.text : "")).join("");
  const update = (u) => ctx.notify("session/update", { sessionId, update: u });

  // (2) Cancellation — thread an abort signal so session/cancel can stop the active run.
  const abortController = new AbortController();
  if (sessions.has(sessionId)) sessions.get(sessionId).abort = abortController;
  else sessions.set(sessionId, { ...sess, abort: abortController });

  // (1) Permission — a rendezvous so the in-process gate callback and the ACP client meet.
  const broker = createPermissionBroker();

  let stopReason = "end_turn";
  try {
    for await (const ev of run({
      direction: { messages: [{ role: "user", content: text }] },
      context: { cwd: sess.cwd, session: sessionId },
      signal: abortController.signal,
      config: {
        // The gate callback resolves to the operator decision the stream case fetched over ACP.
        // It returns the ratified { approved, reason } decision contract (gates/callback-gate.js),
        // NOT a bare "allow"/"deny" string.
        onPermission: () => broker.awaitDecision(),
      },
    })) {
      switch (ev.type) {
        case "text":
          if (ev.text) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ev.text } });
          break;
        case "thinking":
          if (ev.text) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ev.text } });
          break;
        // tool_call (loop.js): { id, agent, tool, args }. Grounded `id`/`tool` first.
        case "tool_call":
          update({
            sessionUpdate: "tool_call",
            toolCallId: String(ev.id ?? ev.toolCallId ?? "tool"),
            title: ev.tool ?? ev.name ?? "tool",
            status: "in_progress",
            ...(ev.args ? { rawInput: ev.args } : {}),
          });
          break;
        // tool_result (loop.js): { id, agent, tool, ok, blocked, result, error }. Failure is
        // `ok === false` (the grounded field), not a truthy `error` — a blocked-but-defined result
        // still carries ok:false. Keep the old `ev.error` read as a defensive secondary signal.
        case "tool_result":
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: String(ev.id ?? ev.toolCallId ?? "tool"),
            status: ev.ok === false || ev.error ? "failed" : "completed",
          });
          break;
        // (1) permission (permission.js): forward to the ACP client and feed the decision back to
        // the parked onPermission callback. The await happens here, in the consumer, where ctx is.
        //
        // CRITICAL: only an ACTIONABLE request (the single-agent callback-gate path, where an
        // onPermission is awaiting via the broker) is round-tripped as session/request_permission.
        // The COUNCIL path emits a `permission` event too (events.js translates permission_requested
        // -> { tool, reason, pending:true } with NO `actionable` marker and NO awaiting callback),
        // but it is a post-hoc HALT NOTIFICATION. Soliciting a session/request_permission for it
        // would block on an operator answer that no one consumes (broker.supplyDecision has no
        // waiter) — the run is already halted, so the answer is dropped and the operator hangs.
        // We surface the halt as a non-actionable status update instead.
        case "permission": {
          if (ev.pending === false) break; // a resolution echo, not a fresh request
          if (ev.actionable !== true) {
            // Council halt-marker (or any non-actionable permission notification): inform, don't ask.
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: String(ev.toolCallId ?? ev.id ?? `${ev.tool ?? "gate"}-${ev.ts ?? Date.now()}`),
              status: "pending",
              ...(ev.tool ? { title: ev.tool } : {}),
            });
            break;
          }
          const reqPayload = toPermissionRequest(sessionId, ev);
          const res = await ctx.request("session/request_permission", reqPayload);
          broker.supplyDecision(decisionFromOutcome(res));
          break;
        }
        case "run_complete":
          if (ev.halted && ev.haltReason === "aborted") stopReason = "cancelled";
          else stopReason = ev.ok === false ? "refusal" : "end_turn";
          break;
      }
    }
  } finally {
    const s = sessions.get(sessionId);
    if (s && s.abort === abortController) s.abort = null;
  }
  return { stopReason };
}

const handlers = {
  "session/new": async (params = {}) => {
    const id = newSessionId();
    sessions.set(id, { cwd: params.cwd || process.cwd(), abort: null });
    return { sessionId: id };
  },
  "session/prompt": prompt,
  // (2) session/cancel is a notification — abort the session's active run if one is in flight.
  "session/cancel": async (params = {}) => {
    const sess = sessions.get(params?.sessionId);
    if (sess?.abort) sess.abort.abort(new Error("session/cancel"));
  },
};

export async function serve() {
  await serveJsonRpcStdio({ onInitialize, handlers });
}

export { onInitialize, handlers, prompt, createPermissionBroker, toPermissionRequest, decisionFromOutcome };

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  serve().catch((e) => {
    console.error("[illuci-acp] startup failed:", e?.stack || e?.message || e);
    process.exit(1);
  });
}
