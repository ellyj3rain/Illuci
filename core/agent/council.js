/**
 * illuci Agent SDK — Council Adapter (the council end of the continuum)
 *
 * Drives topologies/runner.js runTopology() and surfaces its progress through
 * the same AgentEvent stream as a single agent. runTopology is buffered (it
 * returns a full trace) but emits phase-level lifecycle events through the
 * events/emitter.js singleton, each tagged with sessionId. We:
 *   1. subscribe to onEvent BEFORE the run,
 *   2. filter to this run's sessionId (the emitter is process-global),
 *   3. translate each emitter event to an AgentEvent (or drop it),
 *   4. push the translated events into the run stream,
 *   5. on completion, synthesize the final answer from the trace.
 *
 * runId is passed as runTopology's parentSessionId, so every event the run
 * emits carries sessionId === runId and the filter is exact.
 *
 * @param {object} job — { stream, runId, direction, context, config }
 * @param {object} [deps] — { runTopology, onEvent }
 * @returns {Promise<{ ok: boolean, trace?: object, halted?: boolean, haltReason?: string|null, error?: string }>}
 */
import { agentEvent, translateEmitterEvent } from "./events.js";

export async function runCouncil(job, deps = {}) {
  const { stream, runId, direction, context, config, signal } = job;

  const runTopology =
    deps.runTopology || (await import("../topologies/runner.js")).runTopology;
  const onEvent =
    deps.onEvent || (await import("../events/emitter.js")).onEvent;

  const coord = normalizeCoordination(config.coordination);
  const topologyId = coord.topology;
  const lineup = coord.lineup || config.lineup || {};
  const prompt = resolvePrompt(direction);

  // Subscribe before the run; only this run's events pass the filter.
  const unsubscribe = onEvent((ev) => {
    if (ev.sessionId && ev.sessionId !== runId) return;
    const ae = translateEmitterEvent(ev, runId);
    if (ae) stream.push(ae);
  });

  try {
    const trace = await runTopology(
      topologyId,
      lineup,
      prompt,
      {
        humanStatus: config.humanStatus || "operator-initiated",
        projectId: context.projectId || null,
        tokenBudget: config.tokenBudget || null,
        minConfidence: config.minConfidence || null,
        runControl: config.runControl || null,
        seatDispositions: config.seatDispositions || null,
        reasoning: config.reasoning || null,
        // Cancellation: thread the run's abort signal into runTopology so session/cancel halts a
        // COUNCIL run, not just a single-agent one. runTopology honors options.signal — it flows to
        // dispatchOpts.signal -> company.js composeSignals -> runMember/runSeatLoop, so an abort
        // trips every seat/member. Without this, an aborted council kept running to completion.
        // config.topologyOptions spreads AFTER, so an explicit per-call signal still wins.
        signal,
        ...(config.topologyOptions || {}),
      },
      runId, // parentSessionId — makes emitted events carry sessionId === runId
    );

    const synthesis = extractSynthesis(trace);
    stream.push(agentEvent("synthesis", runId, {
      text: synthesis.text,
      usage: synthesis.usage,
      phaseId: synthesis.phaseId,
    }));

    return {
      ok: !trace.halted,
      trace,
      halted: !!trace.halted,
      haltReason: trace.haltReason || null,
    };
  } catch (err) {
    stream.push(agentEvent("error", runId, { error: err.message, fatal: true }));
    return { ok: false, error: err.message };
  } finally {
    unsubscribe();
  }
}

// ─── HELPERS ───

/** coordination may be a string topology id or { topology, lineup }. */
function normalizeCoordination(coordination) {
  if (typeof coordination === "string") return { topology: coordination };
  if (coordination && typeof coordination === "object") return coordination;
  return {};
}

/** The task prompt: explicit intent, else the last user message. */
function resolvePrompt(direction = {}) {
  if (typeof direction.intent === "string" && direction.intent.length > 0) {
    return direction.intent;
  }
  if (Array.isArray(direction.messages) && direction.messages.length > 0) {
    const lastUser = [...direction.messages].reverse().find((m) => (m.role || "user") === "user");
    const msg = lastUser || direction.messages[direction.messages.length - 1];
    return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  }
  return "";
}

/** Synthesize the final answer from the trace's last completed phase. */
function extractSynthesis(trace) {
  const phaseKeys = Object.keys(trace.phases || {});
  if (phaseKeys.length === 0) return { text: "", usage: null, phaseId: null };
  const lastKey = phaseKeys[phaseKeys.length - 1];
  const phase = trace.phases[lastKey] || {};
  const responses = phase.responses || [];
  const text = responses
    .filter((r) => r.response)
    .map((r) => r.response)
    .join("\n\n---\n\n");
  const usage = {
    total_tokens: responses.reduce((s, r) => s + (r.usage?.total_tokens || 0), 0),
  };
  return { text, usage, phaseId: lastKey };
}

export default { runCouncil };
