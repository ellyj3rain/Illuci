/**
 * illuci Agent SDK — Event Surface
 *
 * The single, public streaming vocabulary for an agent run. Every consumer
 * (OTL today, the Illuci IDE later) reads exactly these eleven event types,
 * whether the run is one agent or a full council — they are the same surface
 * at two points on the coordination continuum.
 *
 * Two internal streaming models feed this surface:
 *   1. dispatch.queryModelStream() — a PULL async-generator yielding token-level
 *      { type:"delta" | "final" | "error" } (single-agent path).
 *   2. events/emitter.onEvent() — a PUSH pub/sub of phase-level lifecycle events,
 *      each tagged with sessionId (council path).
 * This module normalizes both into AgentEvent.
 *
 * The union is intentionally closed at eleven members. Visualizer-only emitter
 * events (model_detected, context_update, subagent_dispatch/return) are NOT
 * surfaced — every public event has a place and a clear reason.
 *
 * @typedef {(
 *   | "run_start" | "agent_start" | "thinking" | "text" | "tool_call"
 *   | "permission" | "tool_result" | "phase" | "synthesis"
 *   | "run_complete" | "error"
 * )} AgentEventType
 *
 * @typedef {object} AgentEvent
 * @property {AgentEventType} type
 * @property {number} ts        — Date.now() at emission
 * @property {string} runId     — the run's sessionId (correlates every event in a run)
 * @property {string} [agent]   — model id / seat label where applicable
 */

export const AGENT_EVENT_TYPES = Object.freeze([
  "run_start", "agent_start", "thinking", "text", "tool_call",
  "permission", "tool_result", "phase", "synthesis",
  "run_complete", "error",
]);

/**
 * Build a well-formed AgentEvent. Always stamps ts + runId so consumers can
 * order and correlate without bookkeeping.
 *
 * @param {AgentEventType} type
 * @param {string} runId
 * @param {object} [payload]
 * @returns {AgentEvent}
 */
export function agentEvent(type, runId, payload = {}) {
  if (!AGENT_EVENT_TYPES.includes(type)) {
    throw new Error(`[agent/events] unknown AgentEvent type: ${type}`);
  }
  return { type, ts: Date.now(), runId, ...payload };
}

// ─── COUNCIL TRANSLATION ───
// Map an emitter event (events/emitter.js) to an AgentEvent, or null to drop it
// from the public stream. The emitter is a module-level singleton; the caller
// has already filtered to this run's sessionId before calling here.

/**
 * Translate one emitter event to an AgentEvent (or null to drop).
 *
 * @param {object} ev — an emitter event { type, payload, sessionId, time }
 * @param {string} runId
 * @returns {AgentEvent | null}
 */
export function translateEmitterEvent(ev, runId) {
  const p = ev.payload || {};
  switch (ev.type) {
    // ── A seat takes a model. The orchestrator spawn (isMain) is folded into
    //    run_start, so only real seats become agent_start. ──
    case "agent_spawn":
      if (p.isMain) return null;
      return agentEvent("agent_start", runId, {
        agent: p.model || p.name,
        seat: p.task || null,
        role: p.roleHint || null,
        disposition: p.disposition || null,
      });

    // ── A model produced output in a phase (buffered, per-phase). ──
    case "message":
      return agentEvent("text", runId, {
        agent: p.agent || null,
        text: p.content || "",
        role: p.role || "assistant",
      });

    case "phase_start":
      return agentEvent("phase", runId, {
        phase: "start",
        phaseId: p.phaseId,
        phaseType: p.phaseType || null,
        seats: p.seats || [],
      });

    case "phase_complete":
      return agentEvent("phase", runId, {
        phase: "complete",
        phaseId: p.phaseId,
        latency: p.latency ?? null,
        totalTokens: p.totalTokens ?? null,
        responseCount: p.responseCount ?? null,
        calibration: p.calibration || null,
        correlation: p.correlation || null,
        gateStatus: p.gateStatus || null,
        gateReason: p.gateReason || null,
      });

    // ── Gate halt / permission request inside a council run. ──
    case "permission_requested":
      return agentEvent("permission", runId, {
        agent: p.agent || null,
        tool: p.tool || "gate",
        reason: p.reason || null,
        pending: true,
      });

    case "gate_halt":
      return agentEvent("phase", runId, {
        phase: "halt",
        phaseId: p.phaseId,
        reason: p.reason || null,
      });

    // ── Visualizer-only / cross-process layout events: dropped from the public
    //    surface. They have no place in the consumer's event vocabulary. ──
    case "topology_start":
    case "topology_complete":   // run_complete is synthesized from the trace
    case "agent_complete":
    case "agent_idle":
    case "model_detected":
    case "context_update":
    case "tool_call_start":     // these are PHASE markers in the emitter, not real tools
    case "tool_call_end":
    case "subagent_dispatch":
    case "subagent_return":
    case "budget_update":
    case "correlation_flag":
    case "seat_assigned":
    case "pipeline_start":
    case "pipeline_stage_start":
    case "pipeline_stage_complete":
    case "pipeline_complete":
      return null;

    default:
      return null;
  }
}

export default { AGENT_EVENT_TYPES, agentEvent, translateEmitterEvent };
