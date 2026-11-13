/**
 * illuci datastore — run writer. Persists one runTopology `trace` as durable trunk
 * records: run.started, phase.completed (per phase), seat.output (per response),
 * run.completed. Deterministic record ids → idempotent (re-persisting the same
 * trace is a no-op). Fires at the runTopology seam, so it captures BOTH direct
 * `illuci run` / `illuci council` AND every company member (each runs through
 * runTopology). Never throws into the run — the caller wraps in try/catch.
 *
 * Company linkage is via the shared sessionId: a member's trace.sessionId IS the
 * company sessionId (runner.js L227: `sessionId = parentSessionId || ...`), so the
 * company-writer adds only the company-level manifest and never re-emits these.
 */
import { writeRecords } from "./record-writer.js";

// illuci response.usage → OTel GenAI token columns.
function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
  };
}

export function persistRun(trace, opts = {}) {
  if (!trace || typeof trace !== "object") return [];
  const runId = trace.runId || opts.runId || null;
  if (!runId) return [];
  const base = { runId, sessionId: trace.sessionId || null, topologyId: trace.topologyId || null, kind: "run" };
  const recs = [];

  recs.push({
    ...base,
    id: `rec-${runId}-run-started`,
    type: "run.started",
    spanKind: "CHAIN",
    genAiOperation: "run",
    payload: {
      topologyId: trace.topologyId || null,
      topologyName: trace.topologyName || null,
      lineup: trace.lineup || null,
      prompt: trace.prompt ?? null,
    },
  });

  const phases = trace.phases && typeof trace.phases === "object" ? trace.phases : {};
  for (const [phaseId, pr] of Object.entries(phases)) {
    if (!pr || typeof pr !== "object") continue;
    const responses = Array.isArray(pr.responses) ? pr.responses : [];
    recs.push({
      ...base,
      id: `rec-${runId}-phase-${phaseId}`,
      phaseId,
      type: "phase.completed",
      spanKind: "CHAIN",
      payload: {
        latency: pr.latency ?? null,
        gateStatus: pr.gateStatus ?? null,
        totalTokens: pr.totalTokens ?? null,
        responseCount: responses.length,
        calibration: pr.calibration ?? null,
      },
    });
    responses.forEach((r, i) => {
      const { inputTokens, outputTokens } = tokensOf(r.usage);
      recs.push({
        ...base,
        id: `rec-${runId}-${phaseId}-seat-${i}`,
        phaseId,
        seatId: r.seat ?? null,
        modelId: r.model ?? null,
        type: "seat.output",
        spanKind: "LLM",
        genAiOperation: "chat",
        inputTokens,
        outputTokens,
        payload: {
          response: r.response ?? null,
          reasoning: r.reasoning ?? null,
          error: r.error ?? null,
          agentSlug: r.agentSlug ?? null,
        },
      });
    });
  }

  recs.push({
    ...base,
    id: `rec-${runId}-run-completed`,
    type: "run.completed",
    spanKind: "CHAIN",
    payload: {
      halted: !!trace.halted,
      haltReason: trace.haltReason || null,
      haltedAt: trace.haltedAt || null,
      totalLatency: trace.totalLatency ?? null,
      budget: trace.budget ?? null,
      completedAt: trace.completedAt || null,
    },
  });

  return writeRecords(recs);
}

export default { persistRun };
