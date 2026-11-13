/**
 * illuci — Event Emitter
 *
 * Translates topology execution into agent-flow compatible events.
 * These events stream via SSE to the visualizer (forked agent-flow).
 *
 * Agent-flow event types we emit:
 *   agent_spawn        — a model takes a seat (node appears)
 *   agent_complete      — a model finishes its phase work (node completes)
 *   agent_idle          — a model is waiting between phases
 *   message             — a model produces output (text bubble)
 *   context_update      — token usage update
 *   tool_call_start     — phase execution begins (tool node appears)
 *   tool_call_end       — phase execution ends (tool node completes)
 *   subagent_dispatch   — one phase feeds into the next (edge + particle)
 *   subagent_return     — phase result returns to the topology (return particle)
 *   permission_requested — gate halt (pause node)
 *   model_detected      — model identification
 *
 * illuci-specific extensions (agent-flow will need to handle):
 *   topology_start      — topology execution begins
 *   topology_complete   — topology execution ends
 *   phase_start         — phase begins
 *   phase_complete      — phase ends with analysis
 *   seat_assigned       — model assigned to seat
 *   correlation_flag    — correlated error detected
 *   gate_halt           — execution halted at gate
 *   budget_update       — token budget status
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import * as telemetryStore from '../telemetry/store.js';
import { getAgentDir } from '../agents/agent-dir.js';

const listeners = new Set();

// [A116]/DR-203 — model message content retention. The persisted telemetry copy
// (context.db + events.jsonl) and the live SSE display event both carried a
// hardcoded 500-character truncation, so a multi-thousand-character arbiter
// ruling survived on disk only as a 500-char head — the deliverable was
// unrecoverable after the run (F-143). Default now keeps the FULL content;
// operators who want to bound awareness-DB growth set ILLUCI_TELEMETRY_MESSAGE_MAX
// to a positive character cap (0 / unset = unlimited). Disclosed control (DR-130).
function telemetryMessageMax() {
  const raw = process.env.ILLUCI_TELEMETRY_MESSAGE_MAX;
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function telemetryContent(text) {
  const s = String(text ?? "");
  const max = telemetryMessageMax();
  return max > 0 && s.length > max ? s.slice(0, max) : s;
}

// Test handle for the retention control (reads ILLUCI_TELEMETRY_MESSAGE_MAX live).
export const __test = { telemetryContent, telemetryMessageMax };
let remoteUrl = null;
let remoteToken = null;
let remoteChecked = false;

// ─── Per-run context isolation ───
// Each topology run carries its own { runId, sessionId, projectId, topologyName,
// startTime } in an AsyncLocalStorage scope established by the runner. Concurrent
// runs (the company) never clobber one another's run_id or elapsed clock, and one
// run completing never nulls another run's context. Children inherit the parent
// sessionId, so the scope is keyed per-run (a fresh `run()`), not per-session.
// Callers that emit outside a run scope (pipeline-level events, direct test calls)
// fall back to a null-run context rather than crashing.
const runStore = new AsyncLocalStorage();
// Sentinel (not "illuci", a real topology name) so events emitted OUTSIDE a run scope
// — pipeline-level events, direct callers — are explicitly marked rather than
// masquerading as a production "illuci" topology run. (Adversarial-debate council
// finding, 2026-06-17.) sessionId/projectId stay null because the emit functions
// take sessionId as a param; ctx() only supplies them as a last resort.
const UNSCOPED = "__unscoped__";
const FALLBACK_CTX = Object.freeze({ runId: UNSCOPED, sessionId: null, projectId: null, topologyName: UNSCOPED, startTime: 0 });
function ctx() { return runStore.getStore() || FALLBACK_CTX; }

let runSeq = 0;
/** Mint a collision-free run id — Promise.allSettled fan-out can share one Date.now() tick. */
export function nextRunId(topologyId) {
  return `${topologyId}-${Date.now()}-${(runSeq++).toString(36)}`;
}
/** Run `fn` inside a fresh per-run context scope. The runner wraps each topology run with this. */
export function runWithContext(context, fn) {
  return runStore.run({ ...FALLBACK_CTX, startTime: Date.now(), ...context }, fn);
}
export { runStore };

/**
 * Check if a flow server is running and send events to it.
 * This enables cross-process event delivery: `illuci council` in one terminal
 * streams events to `illuci flow` in another terminal.
 *
 * Reads .illuci/flow-runtime.json for URL + auth token (written by SSE server at startup).
 * Falls back to env var ILLUCI_FLOW_URL + ILLUCI_FLOW_TOKEN for manual configuration.
 */
async function checkRemoteServer() {
  if (remoteChecked) return;
  remoteChecked = true;

  let url = process.env.ILLUCI_FLOW_URL || null;
  let token = process.env.ILLUCI_FLOW_TOKEN || null;

  // Try reading the runtime file written by illuci flow
  if (!url) {
    try {
      const runtime = JSON.parse(readFileSync(join(process.cwd(), ".illuci", "flow-runtime.json"), "utf-8"));
      url = runtime.url;
      token = runtime.token;
    } catch {}
  }

  if (!url) url = "http://127.0.0.1:7470";

  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    if (resp.ok) {
      remoteUrl = `${url}/ingest`;
      remoteToken = token;
    }
  } catch {
    remoteUrl = null;
  }
}

function postToRemote(event) {
  if (!remoteUrl) return;
  const headers = { "Content-Type": "application/json" };
  if (remoteToken) {
    headers["Authorization"] = `Bearer ${remoteToken}`;
  }
  fetch(remoteUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

function elapsed() {
  const { startTime } = ctx();
  return startTime ? (Date.now() - startTime) / 1000 : 0;
}

export function emit(event) {
  // A company may run the same topology more than once concurrently. Preserve
  // its actual run identity on events emitted inside that run's matching session.
  // An unscoped or differently scoped event is never assigned an inferred run.
  const active = runStore.getStore();
  const delivered = active && typeof active.runId === "string" && active.runId !== UNSCOPED &&
    typeof active.sessionId === "string" && event?.sessionId === active.sessionId
    ? { ...event, runId: active.runId } : event;
  // Deliver to local listeners (in-process SSE server)
  for (const listener of listeners) {
    try { listener(delivered); } catch {}
  }
  // Deliver to remote flow server (cross-process)
  postToRemote(delivered);
}

/** Register a listener for all events */
export function onEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Remove all listeners */
export function clearListeners() {
  listeners.clear();
}

// ─── Topology lifecycle events ───

export async function emitTopologyStart(topologyId, topologyName, lineup, prompt, sessionId, projectId, graph = null, seatAssignments = null) {
  // run_id is established by the run scope (runWithContext); the rest come from params.
  const { runId } = ctx();
  await checkRemoteServer();

  // Record telemetry event for topology start
  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "topology_start",
    topology_id: topologyId,
    payload: { topologyName, lineup, prompt: prompt.substring(0, 200), graph },
  });

  // Resolve seat metadata from topology graph for visualizer enrichment
  const seatMeta = {};
  if (graph && graph.nodes) {
    for (const node of graph.nodes) {
      seatMeta[node.id] = {
        roleHint: node.roleHint || node.label || node.id,
        weight: node.weight || 1,
        label: node.label || node.id,
      };
    }
  }

  // Emit session-level spawn (the topology itself is the "main agent")
  emit({
    time: 0,
    type: "agent_spawn",
    payload: {
      name: topologyName,
      isMain: true,
      task: prompt.substring(0, 100),
      roleHint: "orchestrator",
      authorityWeight: 1.0,
      displayColor: "#66ccff",
    },
    sessionId,
  });

  // Emit seat assignments as subagent spawns with disposition data
  for (const [seatId, models] of Object.entries(lineup)) {
    const modelList = Array.isArray(models) ? models : [models];
    const meta = seatMeta[seatId] || {};
    for (const [index, modelId] of modelList.entries()) {
      const rawAssignment = seatAssignments?.[seatId];
      const seatAssignment = Array.isArray(rawAssignment) ? rawAssignment[index] : rawAssignment;
      const agentAssignment = seatAssignment?.agent || null;
      const spawnName = agentAssignment?.agentId ? `${seatId}:${agentAssignment.agentId}` : `${seatId}:${modelId}`;

      // Load identity.json portrait.color for this model
      let displayColor = agentAssignment?.public?.color || null;
      try {
        const identityPath = join(getAgentDir(modelId), "identity.json");
        if (existsSync(identityPath)) {
          const identity = JSON.parse(readFileSync(identityPath, "utf-8"));
          displayColor = displayColor || identity?.portrait?.color || null;
        }
      } catch { /* no identity — color will be derived client-side */ }

      emit({
        time: elapsed(),
        type: "agent_spawn",
        payload: {
          name: spawnName,
          parent: topologyName,
          task: seatId,
          model: modelId,
          agentId: agentAssignment?.agentId || null,
          agentSlug: agentAssignment?.agentSlug || null,
          displayName: agentAssignment?.public?.displayName || null,
          roleHint: meta.roleHint || seatId,
          authorityWeight: meta.weight || 0.5,
          displayColor,
          disposition: seatAssignment?.disposition || seatAssignment || null,
        },
        sessionId,
      });

      telemetryStore.recordEvent({
        run_id: runId,
        session_id: sessionId,
        project_id: projectId,
        event_type: "model_spawn",
        topology_id: topologyId,
        seat_id: seatId,
        model_id: modelId,
        payload: { name: spawnName, task: seatId, agentId: agentAssignment?.agentId || null },
      });

      emit({
        time: elapsed(),
        type: "model_detected",
        payload: { agent: spawnName, model: modelId, agentId: agentAssignment?.agentId || null },
        sessionId,
      });

      telemetryStore.recordEvent({
        run_id: runId,
        session_id: sessionId,
        project_id: projectId,
        event_type: "model_detected",
        topology_id: topologyId,
        seat_id: seatId,
        model_id: modelId,
        payload: { agent: spawnName, model: modelId, agentId: agentAssignment?.agentId || null },
      });
    }
  }

  // illuci extension — includes compiled relationship graph for visualizer layout
  emit({
    time: 0,
    type: "topology_start",
    payload: { topologyId, topologyName, lineup, prompt: prompt.substring(0, 200), graph },
    sessionId,
  });
}

export function emitTopologyComplete(topologyId, topologyName, trace, sessionId) {
  const { runId, projectId } = ctx();

  emit({
    time: elapsed(),
    type: "agent_complete",
    payload: { name: topologyName },
    sessionId,
  });

  const payload = {
    topologyId,
    topologyName,
    totalLatency: trace.totalLatency,
    budget: trace.budget,
    phaseCount: Object.keys(trace.phases).length,
    halted: trace.halted || false,
    haltReason: trace.haltReason || null,
  };

  console.log(`Telemetry: emitTopologyComplete - run_id=${runId}, payload=`, payload);

  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "topology_complete",
    topology_id: topologyId,
    payload: payload,
  });

  emit({
    time: elapsed(),
    type: "topology_complete",
    payload: payload,
    sessionId,
  });
  // Per-run context auto-disposes when the run scope (runWithContext) resolves —
  // no global to null out, so a concurrent run's context is never clobbered here.
}

// ─── Phase lifecycle events ───

export function emitPhaseStart(phaseId, phaseType, seats, sessionId) {
  const { runId, projectId, topologyName } = ctx();

  // Record telemetry event for phase start
  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "phase_start",
    topology_id: runId, // topologyId is the runId
    phase_id: phaseId,
    payload: { phaseType, seats },
  });

  emit({
    time: elapsed(),
    type: "tool_call_start",
    payload: {
      tool: `phase:${phaseId}`,
      agent: topologyName,
      args: `${phaseType}: ${seats.join(", ")}`,
    },
    sessionId,
  });

  emit({
    time: elapsed(),
    type: "phase_start",
    payload: { phaseId, phaseType, seats },
    sessionId,
  });
}

export function emitPhaseComplete(phaseId, phaseResult, sessionId) {
  const { runId, projectId, topologyName } = ctx();

  const responseCount = phaseResult.responses?.length || 0;

  emit({
    time: elapsed(),
    type: "tool_call_end",
    payload: {
      tool: `phase:${phaseId}`,
      agent: topologyName,
      result: `${responseCount} response(s), ${phaseResult.totalTokens || 0} tokens`,
      tokenCost: phaseResult.totalTokens || 0,
    },
    sessionId,
  });

  // Emit individual model messages and record telemetry
  for (const r of (phaseResult.responses || [])) {
    if (r.response) {
      emit({
        time: elapsed(),
        type: "message",
        payload: {
          agent: `${r.seat}:${r.model}`,
          role: "assistant",
          content: telemetryContent(r.response),
          tokens: r.usage?.total_tokens || 0,
        },
        sessionId,
      });

      telemetryStore.recordEvent({
        run_id: runId,
        session_id: sessionId,
        project_id: projectId,
        event_type: "model_message",
        topology_id: runId,
        phase_id: phaseId,
        seat_id: r.seat,
        model_id: r.model,
        payload: {
          role: "assistant",
          content: telemetryContent(r.response),
          tokens: r.usage?.total_tokens || 0,
        },
      });
    }

    // Record model response metrics (latency, error, tokens)
    telemetryStore.recordEvent({
      run_id: runId,
      session_id: sessionId,
      project_id: projectId,
      event_type: "model_response",
      topology_id: runId,
      phase_id: phaseId,
      seat_id: r.seat,
      model_id: r.model,
      payload: {
        latency: r.latency,
        prompt_tokens: r.usage?.prompt_tokens || 0,
        completion_tokens: r.usage?.completion_tokens || 0,
        total_tokens: r.usage?.total_tokens || 0,
        error: r.error || null,
      },
    });
  }

  // Context update with token usage and record telemetry
  for (const r of (phaseResult.responses || [])) {
    if (r.usage?.total_tokens) {
      emit({
        time: elapsed(),
        type: "context_update",
        payload: {
          agent: `${r.seat}:${r.model}`,
          tokens: r.usage.total_tokens,
          breakdown: {
            systemPrompt: 200,
            userMessages: r.usage.prompt_tokens || 0,
            toolResults: 0,
            reasoning: r.usage.completion_tokens || 0,
            subagentResults: 0,
          },
        },
        sessionId,
      });

      telemetryStore.recordEvent({
        run_id: runId,
        session_id: sessionId,
        project_id: projectId,
        event_type: "token_usage_update",
        topology_id: runId,
        phase_id: phaseId,
        seat_id: r.seat,
        model_id: r.model,
        payload: {
          tokens: r.usage.total_tokens,
          breakdown: {
            systemPrompt: 200,
            userMessages: r.usage.prompt_tokens || 0,
            toolResults: 0,
            reasoning: r.usage.completion_tokens || 0,
            subagentResults: 0,
          },
        },
      });
    }
  }

  const phaseCompletePayload = {
    phaseId,
    latency: phaseResult.latency,
    totalTokens: phaseResult.totalTokens,
    responseCount,
    calibration: phaseResult.calibration || null,
    correlation: phaseResult.correlation || null,
    marginalValue: phaseResult.marginalValue || null,
    gateStatus: phaseResult.gateStatus || null,
    gateReason: phaseResult.gateReason || null, // Add gateReason here
  };

  // illuci extension with analysis data and record telemetry
  emit({
    time: elapsed(),
    type: "phase_complete",
    payload: phaseCompletePayload,
    sessionId,
  });

  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "phase_complete",
    topology_id: runId,
    phase_id: phaseId,
    payload: phaseCompletePayload,
  });

  // Correlation flags as discoveries and record telemetry
  if (phaseResult.correlation?.flags?.length > 0) {
    for (const flag of phaseResult.correlation.flags) {
      emit({
        time: elapsed(),
        type: "correlation_flag",
        payload: { phaseId, ...flag },
        sessionId,
      });

      telemetryStore.recordEvent({
        run_id: runId,
        session_id: sessionId,
        project_id: projectId,
        event_type: "correlation_flag",
        topology_id: runId,
        phase_id: phaseId,
        payload: flag,
      });
    }
  }
}

// ─── Inter-phase flow events ───

export function emitPhaseHandoff(fromPhaseId, toPhaseId, sessionId) {
  const { topologyName } = ctx();
  // parent must be an agent in the map — use topology name
  emit({
    time: elapsed(),
    type: "subagent_dispatch",
    payload: { parent: topologyName, child: topologyName, task: `${fromPhaseId} → ${toPhaseId}` },
    sessionId,
  });
}

export function emitPhaseReturn(phaseId, parentName, sessionId) {
  // renderer expects parent + child (both must be agent names in the map)
  emit({
    time: elapsed(),
    type: "subagent_return",
    payload: { parent: parentName, child: parentName, summary: `phase:${phaseId} complete` },
    sessionId,
  });
}

// ─── Gate events ───

export function emitGateHalt(phaseId, reason, sessionId) {
  const { runId, projectId, topologyName } = ctx();

  // Record telemetry event for gate halt
  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "gate_halt",
    topology_id: runId,
    phase_id: phaseId,
    payload: { reason },
  });

  emit({
    time: elapsed(),
    type: "permission_requested",
    payload: { agent: topologyName, tool: "gate", reason },
    sessionId,
  });

  emit({
    time: elapsed(),
    type: "gate_halt",
    payload: { phaseId, reason },
    sessionId,
  });
}

// ─── Pipeline lifecycle events ───

export async function emitPipelineStart(pipelineId, stages, prompt, sessionId) {
  await checkRemoteServer();

  emit({
    time: elapsed(),
    type: "pipeline_start",
    payload: {
      pipelineId,
      stages: stages.map((s, i) => ({
        stageId: s.stageId || `stage-${i}`,
        topologyId: s.topologyId,
        label: s.label || `Stage ${i + 1}`,
        sequence: s.sequence ?? i,
        lineup: s.lineup || {},
      })),
      prompt: (prompt || "").substring(0, 200),
    },
    sessionId,
  });
}

export function emitPipelineStageStart(stageId, topologyId, label, sessionId) {
  emit({
    time: elapsed(),
    type: "pipeline_stage_start",
    payload: { stageId, topologyId, label },
    sessionId,
  });
}

export function emitPipelineStageComplete(stageId, artifacts, sessionId) {
  emit({
    time: elapsed(),
    type: "pipeline_stage_complete",
    payload: {
      stageId,
      artifactCount: artifacts?.length || 0,
      artifacts: (artifacts || []).map(a => ({
        type: a.type,
        createdBy: a.createdBy,
        size: a.content?.length || 0,
      })),
    },
    sessionId,
  });
}

export function emitPipelineComplete(pipelineId, status, sessionId) {
  emit({
    time: elapsed(),
    type: "pipeline_complete",
    payload: { pipelineId, status },
    sessionId,
  });
}

// ─── Budget events ───

export function emitBudgetUpdate(budget, sessionId) {
  const { runId, projectId } = ctx();

  // Record telemetry event for budget update
  telemetryStore.recordEvent({
    run_id: runId,
    session_id: sessionId,
    project_id: projectId,
    event_type: "budget_update",
    topology_id: runId,
    payload: budget,
  });

  emit({
    time: elapsed(),
    type: "budget_update",
    payload: budget,
    sessionId,
  });
}

export default {
  onEvent, clearListeners,
  emitTopologyStart, emitTopologyComplete,
  emitPhaseStart, emitPhaseComplete,
  emitPhaseHandoff, emitPhaseReturn,
  emitGateHalt, emitBudgetUpdate,
  emitPipelineStart, emitPipelineStageStart,
  emitPipelineStageComplete, emitPipelineComplete,
};
