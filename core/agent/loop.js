/**
 * illuci Agent SDK — Single-Agent Loop (the missing loop)
 *
 * Think → Act → Observe → Repeat. This is the piece illuci did not have:
 *   - dispatch.queryModelStream() streams ONE governed turn, no tool loop.
 *   - topologies/runner.js write/execute modes are single-shot manifest-parse,
 *     not iterative.
 * OTL hand-rolled this gap in conversation.ts; the SDK now owns the canonical
 * version, composing illuci's secured primitives instead of reinventing them.
 *
 * Per turn:
 *   1. Render the running transcript (+ tool instructions) and stream it through
 *      queryModelStream — emitting `thinking` (reasoning deltas) and `text`
 *      (content deltas) as tokens arrive.
 *   2. Parse the turn for tool calls (tool-protocol hybrid).
 *   3. No calls + the turn reads as a clean final answer → emit `synthesis`
 *      and stop (the model's terminal signal). No calls but the turn LOOKS
 *      like a tool attempt (or is empty) → NOT terminal: emit a non-fatal
 *      `error` and issue a bounded repair re-prompt (config.maxRepairs,
 *      default 2), so a malformed call never silently terminates as success.
 *   4. Calls → for each: emit `tool_call`, run it through executeTool (the
 *      SECURED surface: hard-invariant denial + allowlist + path containment +
 *      gating via the installed permission channel), emit `tool_result`, append
 *      the result to the transcript, and loop so the model observes it.
 *
 * Capped at config.maxSteps turns. Real deps (queryModelStream / executeTool /
 * TOOL_NAMES) are lazy-imported only when not injected, so unit tests stay
 * hermetic — no model, no bridge, no filesystem.
 *
 * @param {object} job
 * @param {import("./stream.js").EventStream} job.stream
 * @param {string} job.runId
 * @param {object} job.direction — { intent?, messages? }
 * @param {object} job.context   — { cwd, projectId, session }
 * @param {object} job.config    — the resolved composition
 * @param {object} [deps]        — { queryModelStream, executeTool, toolNames, defaultModel, mcpTools }
 * @returns {Promise<{ ok: boolean, steps: number, usage?: object, truncated?: boolean, error?: string }>}
 */
import { agentEvent } from "./events.js";
import { feedbackReservationCoordinates } from "../roles/operator-concept-steward.js";
import {
  parseToolCalls,
  buildToolInstructions,
  looksLikeToolAttempt,
  buildRepairInstruction,
} from "./tool-protocol.js";
import { buildToolDefinitions } from "./tool-defs.js";
import { connectMcpTools } from "./mcp-tools.js";
import { getContextLimit, estimateTokens, estimateMessageTokens } from "../context/tokens.js";
import { assessDesktopFocusAction } from "../governance/desktop-focus-release.js";

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_REPAIRS = 2;

export async function runSingleAgent(job, deps = {}) {
  const { stream, runId, direction, context, config, signal } = job;

  // Cancellation: run() threads its per-run AbortSignal here. Checked at every
  // boundary the loop controls — turn start, per stream event, post-stream, and
  // before each tool call — and passed down to dispatch (options.signal) and
  // executeTool (context.signal) so the layers below observe it too.
  const aborted = () => !!(signal && signal.aborted);
  const abortedOutcome = (steps) => ({ ok: false, steps, halted: true, haltReason: "aborted" });

  const queryStream =
    deps.queryModelStream || (await import("../dispatch/dispatch.js")).queryModelStream;
  const execTool =
    deps.executeTool || (await import("../bridges/tools.js")).executeTool;
  const toolNames = config.tools || deps.toolNames ||
    await (await import("../bridges/tools.js")).getToolNames();

  const agent = config.agent || deps.defaultModel || (await resolveDefaultModel());
  const seat = config.seat || null;
  const maxSteps = Number.isInteger(config.maxSteps) ? config.maxSteps : DEFAULT_MAX_STEPS;
  const maxRepairs = Number.isInteger(config.maxRepairs) ? config.maxRepairs : DEFAULT_MAX_REPAIRS;

  stream.push(agentEvent("agent_start", runId, { agent, seat, role: config.role || null }));

  // Optional external MCP tools (client-side capability expansion). Injected for
  // tests; otherwise connected from config.mcpServers. Absent → no behavior change.
  const mcpTools =
    deps.mcpTools !== undefined
      ? deps.mcpTools
      : Array.isArray(config.mcpServers) && config.mcpServers.length
        ? await connectMcpTools(config.mcpServers)
        : null;
  const ownsMcp = deps.mcpTools === undefined && !!mcpTools;
  const allToolNames = mcpTools ? [...toolNames, ...mcpTools.toolNames] : toolNames;

  const transcript = initTranscript(direction);
  const toolBlock = buildToolInstructions(allToolNames) + (mcpTools ? mcpTools.instructions : "");
  // Native tool definitions (provider function-calling), sent ALONGSIDE the
  // hybrid prose protocol: bridges that accept options.tools (ollama) let the
  // model emit structured tool calls; bridges that don't simply ignore the
  // field and the prose protocol still applies. Names without a curated
  // schema (incl. MCP-namespaced tools) stay prose-only by design.
  const toolDefs = buildToolDefinitions(allToolNames);

  let lastFinal = null;
  let repairsUsed = 0;
  let conceptCorrections = 0;
  const conceptReviews = [];

  try {
  for (let step = 0; step < maxSteps; step++) {
    if (aborted()) return abortedOutcome(step);

    const baseInput = buildDispatchInput(transcript, toolBlock, agent);
    const managedMemory = typeof deps.buildMemoryContext === "function";
    const memoryText = managedMemory
      ? await resolveTurnMemory(deps, baseInput, agent, signal)
      : "";
    if (aborted()) return abortedOutcome(step);
    // Reference context is reconstructed each turn, never retained in transcript.
    const { sessionState, message } = memoryText
      ? buildDispatchInput(transcript, toolBlock, agent, memoryText)
      : baseInput;

    let assistantText = "";
    let finalEvent = null;
    let errored = null;

    try {
      for await (const ev of queryStream(agent, message, {
        seat,
        projectId: context.projectId || null,
        topology: config.topology || null,
        cwd: context.cwd || null,
        ...(toolDefs.length ? { tools: toolDefs } : {}),
        signal,
        ...(config.dispatch || {}),
        ...(managedMemory ? {
          skipContext: true, skipIdentitySummary: true, raw: false, signal,
        } : {}),
        // Role-separated prior history (session-contract.md seam). Computed per
        // step; placed last so it always wins over any static dispatch override.
        sessionState,
      })) {
        // Abort: stop consuming. break runs the producer generator's finally
        // (dispatch releases its throttle slot) instead of leaving it running.
        if (aborted()) break;
        if (ev.type === "delta") {
          const text = ev.text || "";
          if (ev.reasoning) {
            stream.push(agentEvent("thinking", runId, { agent, text }));
          } else {
            assistantText += text;
            stream.push(agentEvent("text", runId, { agent, text }));
          }
        } else if (ev.type === "error") {
          errored = ev.error || "model stream error";
        } else if (ev.type === "final") {
          finalEvent = ev;
          if (!assistantText && ev.response) assistantText = ev.response; // non-streaming bridge
        }
      }
    } catch (err) {
      errored = err.message;
    }

    // Aborted mid-turn (including a dispatch-side "aborted" error event): halt
    // quietly — an abort is the consumer's decision, not a model failure.
    if (aborted()) return abortedOutcome(step + 1);

    if (errored) {
      stream.push(agentEvent("error", runId, { agent, error: errored, fatal: true }));
      return { ok: false, error: errored, steps: step + 1 };
    }

    // Paused model: dispatch yields a skipped final (response:null, reason:"paused").
    // Surface it honestly as a non-success halt rather than coercing the null
    // response to an empty "successful" synthesis — the audited silent-empty-
    // success failure. (A genuine empty turn from a live model still routes to
    // the bounded repair path below.)
    if (finalEvent?.skipped) {
      const reason = finalEvent.reason || "skipped";
      stream.push(agentEvent("error", runId, {
        agent, error: `model ${agent} ${reason}; no response produced`, fatal: true, skipped: true, reason,
      }));
      return { ok: false, error: `model ${reason}`, skipped: true, reason, steps: step + 1 };
    }

    lastFinal = finalEvent;
    // The bridge's final.response is authoritative (the complete turn); streamed
    // deltas are for live display and may not perfectly reconstruct it. Parse and
    // record the final response, falling back to accumulated deltas only when the
    // bridge yielded no final text.
    const finalText =
      typeof finalEvent?.response === "string" && finalEvent.response.length > 0
        ? finalEvent.response
        : assistantText;
    transcript.push({ role: "assistant", content: finalText });

    const calls = parseToolCalls(finalText, finalEvent);
    if (calls.length === 0) {
      // Zero calls is only the terminal signal when the turn reads as a clean
      // final answer. A turn that LOOKS like a tool attempt (malformed JSON,
      // unparsed fence) or an empty turn terminating as success is the audited
      // silent-success failure. Repair instead: tell the model what went wrong
      // and re-prompt, bounded by maxRepairs so a hopeless model cannot loop.
      const empty = finalText.trim().length === 0;
      const attempted = !empty && looksLikeToolAttempt(finalText);
      if ((attempted || empty) && repairsUsed < maxRepairs) {
        repairsUsed += 1;
        const reason = empty ? "empty" : "unparsed";
        stream.push(agentEvent("error", runId, {
          agent,
          error: empty
            ? "model turn was empty; issuing a bounded repair re-prompt"
            : "tool-call extraction yielded zero calls on a turn that looks like a tool attempt; issuing a bounded repair re-prompt",
          fatal: false,
          repair: { attempt: repairsUsed, max: maxRepairs, reason },
        }));
        transcript.push({
          role: "user",
          content: `[tool-protocol repair]\n${buildRepairInstruction(reason)}`,
        });
        continue; // consumes a step - still capped by maxSteps
      }
      // A bound work item carries the operator's sourced words into the actual
      // synthesis path. One drift finding can cause one chief correction turn;
      // subsequent findings remain visible without creating a completion gate.
      if (config.operatorConceptReview) {
        const binding = config.operatorConceptReview;
        let review;
        try {
          const reviewWork = deps.reviewChiefWork
            || (await import("../roles/operator-concept-steward.js")).reviewChiefWork;
          review = await reviewWork({
            ...binding,
            workItem: { ...(binding.workItem || {}), runId },
            actualOutput: finalText,
            outputRef: binding.outputRef || `agent:${runId}:step:${step + 1}`,
            model: binding.model || agent,
            priorReviews: [...(Array.isArray(binding.priorReviews) ? binding.priorReviews : []),
              ...conceptReviews],
            signal,
          }, { ...deps.operatorConceptReviewDeps,
            runtimeContext: { cwd: context.cwd, projectId: context.projectId, runId,
              agentId: config.agentId || agent, modelRef: agent, sessionId: context.session ?? null } });
        } catch (err) {
          review = { status: "unreviewed", verdict: "unverified",
            reason: `operator-concept review failed: ${err.message}`,
            ...(err.code === 'LOCAL_FEEDBACK_OBSERVATION_UNCONFIRMED' ? {
              reason: 'Local feedback observation unconfirmed; reconcile retained evidence',
              retrySafe: false, feedback: { mode: 'host-local-refinement', ids: err.feedbackIds },
            } : {}) };
        }
        if (aborted()) {
          const feedback = review?.feedback;
          const ids = feedback?.ids ?? feedback;
          return { ...abortedOutcome(step + 1),
            ...(feedback?.mode === 'host-local-refinement' && ids ? {
              feedbackReconciliation: {
                contextId: typeof ids.contextId === 'string' ? ids.contextId : null,
                decisionId: typeof ids.decisionId === 'string' ? ids.decisionId : null,
                followupIds: Array.isArray(ids.followupIds) ? ids.followupIds.filter(id => typeof id === 'string') : [],
                ...(feedbackReservationCoordinates(ids) ? { reservation: feedbackReservationCoordinates(ids) } : {}),
                retrySafe: false,
              },
            } : {}),
          };
        }
        conceptReviews.push(review);
        stream.push(agentEvent("phase", runId, {
          phase: "complete", phaseId: `operator-concept-review-${conceptReviews.length}`,
          phaseType: "operator-concept-review", review,
        }));
        if (review.status === "reviewed" && review.verdict === "drift"
          && conceptCorrections === 0 && step + 1 < maxSteps) {
          conceptCorrections += 1;
          transcript.push({ role: "user", content:
            `[operator-concept review]\nThe cited operator words show drift in your actual output. Correct the concrete findings below, then give the revised result. Preserve the user's scope and cite what changed.\n${JSON.stringify(review.findings)}` });
          continue;
        }
      }
      const latestConceptReview = conceptReviews.at(-1);
      const operatorConceptStatus = latestConceptReview
        ? latestConceptReview.status === "reviewed"
          ? latestConceptReview.verdict : latestConceptReview.status
        : null;
      stream.push(agentEvent("synthesis", runId, {
        agent,
        text: finalText,
        usage: finalEvent?.usage || null,
        ...(conceptReviews.length ? { operatorConceptReviews: conceptReviews,
          operatorConceptStatus } : {}),
        ...(attempted || empty ? { malformed: true } : {}),
      }));
      return {
        ok: true,
        steps: step + 1,
        usage: finalEvent?.usage || null,
        ...(conceptReviews.length ? { operatorConceptReviews: conceptReviews,
          operatorConceptStatus } : {}),
        ...(attempted || empty ? { malformed: true } : {}),
      };
    }

    for (const call of calls) {
      // The hard guarantee: an aborted/abandoned run starts NO further tool
      // executions — checked immediately before every call.
      if (aborted()) return abortedOutcome(step + 1);

      stream.push(agentEvent("tool_call", runId, {
        id: call.id, agent, tool: call.name, args: call.args,
      }));

      const toolCtx = {
        sessionId: runId,
        agentId: config.agentId || agent,
        agentSlug: config.agentSlug || null,
        agentName: seat || config.agentId || agent,
        topologyId: config.topology || null,
        workspaceRoot: context.cwd || undefined,
        workPermit: config.workPermit || null,
        workPermitRequired: config.workPermitRequired === true,
        // The seat's skill license (DR-112). Present only when the seat carries bound
        // skills; the chokepoint (executeTool) uses it to deny off-floor MCP the skills
        // do not grant. null → no skill layer, floor governs.
        skillGrants: config.skillGrants || null,
        // [A39]/CAP-3: the record-backed capability resolution (R4) for the tool
        // seam's affordance check. null = resolution attempted, nothing granted.
        capabilityResolution: config.capabilityResolution ?? null,
        workItemId: config.workItemId || null,
        desktopFocusState: config.desktopFocusState || null,
        desktopFocusRelease: config.desktopFocusRelease || null,
        gateLevel: call.gateLevel || undefined,
        // The stable call id, so a gated tool's approval request carries the SAME id as the
        // emitted tool_call event — an in-process consumer correlates the operator's decision
        // to the right call without racing the event stream.
        toolCallId: call.id,
        // Threaded so executeTool refuses to start (and re-checks after its
        // gate), and so tool handlers can interrupt in-flight work.
        signal,
      };
      let result;
      const focus = assessDesktopFocusAction({
        action: call.name,
        workItemId: toolCtx.workItemId,
        desktopState: toolCtx.desktopFocusState,
        release: toolCtx.desktopFocusRelease,
      });
      if (!focus.allow) {
        result = { success: false, ...focus };
      } else if (mcpTools && mcpTools.has(call.name)) {
        try {
          result = await mcpTools.execute(call.name, call.args, toolCtx);
        } catch (err) {
          result = { success: false, error: err.message };
        }
      } else if (toolNames.includes(call.name)) {
        try {
          result = await execTool(call.name, call.args, toolCtx);
        } catch (err) {
          result = { success: false, error: err.message };
        }
      } else {
        result = { success: false, error: `Tool "${call.name}" is not available to this run.` };
      }

      stream.push(agentEvent("tool_result", runId, {
        id: call.id,
        agent,
        tool: call.name,
        ok: !!result?.success,
        blocked: !!result?.blocked,
        result: result?.result ?? null,
        error: result?.error || result?.reason || null,
      }));

      transcript.push({ role: "tool", name: call.name, content: stringifyResult(result) });
    }
    // loop: the model observes the tool results on the next turn
  }

  stream.push(agentEvent("synthesis", runId, {
    agent,
    text: "[run reached max steps without a final answer]",
    truncated: true,
    usage: lastFinal?.usage || null,
  }));
  return { ok: true, steps: maxSteps, truncated: true, usage: lastFinal?.usage || null };
  } finally {
    if (ownsMcp) await mcpTools.close();
  }
}

// ─── HELPERS ───

async function resolveDefaultModel() {
  try {
    const { MODEL_DEFAULTS } = await import("../bridges/index.js");
    const first = Object.keys(MODEL_DEFAULTS || {})[0];
    if (first) return first;
  } catch { /* fall through */ }
  return "ollama";
}

/** Seed the transcript from direction.messages (preferred) or direction.intent. */
function initTranscript(direction = {}) {
  if (Array.isArray(direction.messages) && direction.messages.length > 0) {
    return direction.messages.map((m) => ({
      role: m.role || "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
  }
  if (typeof direction.intent === "string" && direction.intent.length > 0) {
    return [{ role: "user", content: direction.intent }];
  }
  return [{ role: "user", content: "" }];
}

/**
 * Split the running transcript into the bridge's documented (sessionState, message)
 * shape (session-contract.md: history is the caller's job, bridges are stateless,
 * `sessionState: Array<{role, content}>`). The role-separated PRIOR history goes to
 * sessionState — the seam every bridge consumes (array bridges build
 * [system, ...sessionState, {user}]; CLI bridges flatten it once) — and ONLY the
 * current input turn (the latest user/operator prompt, or the trailing tool results
 * the model must now observe) becomes the governed `message`.
 *
 * This replaces the old single flattened string. Prior turns are no longer
 * concatenated with unescaped `[role]` markers (the prompt-injection-by-construction
 * vector: a turn whose CONTENT contained `[user]` could forge a role boundary) and
 * are no longer re-rendered whole every step — role is now structural per message.
 */
function buildDispatchInput(transcript, toolBlock, agent, memoryText = "") {
  const n = transcript.length;
  const last = transcript[n - 1] || { role: "user", content: "" };

  let historyTurns;
  let currentText;
  let trailingIsTool = false;

  if (last.role === "user" || last.role === "operator") {
    // Latest turn is a direct prompt (initial intent, or a tool-protocol repair).
    historyTurns = transcript.slice(0, n - 1);
    currentText = last.content;
  } else {
    // Latest turns are tool results the model must observe. They become the current
    // input (combined), and the conversation continues from the assistant turn that
    // made the calls — so history ends on `assistant`, keeping user/assistant alternation.
    let i = n - 1;
    const tools = [];
    while (i >= 0 && transcript[i].role === "tool") {
      tools.unshift(transcript[i]);
      i -= 1;
    }
    historyTurns = transcript.slice(0, i + 1);
    trailingIsTool = tools.length > 0;
    currentText = tools.length
      ? tools.map((t) => `[tool:${t.name || "result"}]\n${t.content}`).join("\n\n")
      : last.content;
  }

  const cue = trailingIsTool
    ? "\n\nObserve the tool result(s) above. Continue, or give your final answer with no tool call if the task is complete."
    : "";

  const message = `${currentText}${memoryText ? `\n\n${memoryText}` : ""}${toolBlock}${cue}`;
  return {
    sessionState: budgetSessionState(toBridgeMessages(historyTurns), message, agent),
    message,
  };
}

/**
 * Map transcript turns to the bridge sessionState shape — role-separated
 * {role: "user"|"assistant", content} messages, never one flattened string. tool /
 * operator turns ride as labeled user messages (universally accepted; a bare `tool`
 * role needs a tool_call_id that the prose protocol does not carry), and consecutive
 * same-role turns coalesce so the history stays alternation-friendly for every bridge.
 */
function toBridgeMessages(turns) {
  const mapped = turns.map((t) => {
    if (t.role === "assistant") return { role: "assistant", content: t.content };
    if (t.role === "tool") return { role: "user", content: `[tool:${t.name || "result"}]\n${t.content}` };
    if (t.role === "operator") return { role: "user", content: `[operator]\n${t.content}` };
    return { role: "user", content: t.content };
  });
  return coalesceRoles(mapped);
}

/** Merge consecutive same-role messages so the history stays alternation-friendly. */
function coalesceRoles(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * Bound the per-step context so a long run cannot blow the model's window — the
 * other half of the O(steps^2) growth the flattening caused (every step re-sent the
 * whole, ever-growing transcript). When the role-separated history plus the current
 * message would exceed the model's usable window (reserving room for the reply +
 * governance overhead), keep the first turn (the task anchor) and as many of the
 * MOST RECENT turns as fit, replacing the elided middle with one honest marker.
 * Lossy by necessity, but bounded and explicit — versus silently overflowing into
 * provider-side truncation. The bound also shrinks the CLI-flattened prompt, since
 * CLI bridges flatten this same sessionState.
 */
function budgetSessionState(sessionState, message, agent, reserveFraction = 0.3) {
  if (!Array.isArray(sessionState) || sessionState.length === 0) return sessionState;
  const limit = getContextLimit(agent);
  const budget = limit - Math.ceil(limit * reserveFraction) - estimateTokens(message, agent);
  if (budget <= 0) return sessionState; // pathological window; let the bridge cope
  if (estimateMessageTokens(sessionState, agent) <= budget) return sessionState;

  const anchor = sessionState[0];
  let used = estimateTokens(anchor.content, agent) + 4;
  const recent = [];
  for (let i = sessionState.length - 1; i >= 1; i--) {
    const t = estimateTokens(sessionState[i].content, agent) + 4;
    if (used + t > budget) break;
    used += t;
    recent.unshift(sessionState[i]);
  }
  const elided = sessionState.length - 1 - recent.length;
  const out = [anchor];
  if (elided > 0) {
    out.push({ role: "user", content: `[${elided} earlier turn(s) elided to fit the context window]` });
  }
  out.push(...recent);
  return coalesceRoles(out);
}

/** Compact, model-readable rendering of a tool result for the transcript. */
function stringifyResult(result) {
  if (!result) return "[no result]";
  if (result.success === false) {
    return `ERROR: ${result.error || result.reason || "tool failed"}${result.blocked ? " (blocked)" : ""}`;
  }
  const payload = result.result ?? result;
  let str;
  try {
    str = typeof payload === "string" ? payload : JSON.stringify(payload);
  } catch {
    str = String(payload);
  }
  return str.length > 8000 ? `${str.slice(0, 8000)}\n…[truncated]` : str;
}

export { buildDispatchInput, toBridgeMessages, coalesceRoles, budgetSessionState };
export default { runSingleAgent };

/** Trusted host hook only. Optional memory cannot stall ordinary work indefinitely.
 * Admission callbacks receive no caller-asserted identity or authorization. The
 * host closes over its reader handle; signal/time limits cannot revoke prior
 * model outputs or cancel legacy work that ignores cancellation.
 */
async function resolveTurnMemory(deps, baseInput, modelId, signal) {
  if (signal?.aborted) return "";
  const limit = getContextLimit(modelId);
  const available = Math.max(0, Math.floor(limit * 0.7)
    - estimateTokens(baseInput.message, modelId)
    - estimateMessageTokens(baseInput.sessionState, modelId) - 8);
  const requested = deps.memoryContextMaxTokens ?? Math.floor(limit * 0.1);
  if (!Number.isFinite(requested) || requested < 1) return "";
  const maxTokens = Math.min(Math.floor(requested), available);
  if (maxTokens < 1) return "";
  const timeoutMs = deps.memoryContextTimeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return "";
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer;
  let stop;
  const stopped = new Promise(resolve => { stop = () => resolve(""); });
  controller.signal.addEventListener("abort", stop, { once: true });
  timer = setTimeout(onAbort, timeoutMs);
  try {
    if (signal?.aborted) onAbort();
    const pending = Promise.resolve().then(() => controller.signal.aborted ? "" :
      deps.buildMemoryContext({ modelId, maxTokens, signal: controller.signal }));
    const value = await Promise.race([pending, stopped]);
    return !controller.signal.aborted && typeof value === "string" &&
      estimateTokens(value, modelId) <= maxTokens ? value : "";
  } catch { return ""; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}
