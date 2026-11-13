import {rejectUnsupportedBoundWork} from './work-boundary.js';
/**
 * illuci Agent SDK — Public run()
 *
 * The one public entry point. A consumer describes WHAT it wants (direction),
 * WHERE it runs (context), and HOW it is coordinated (config), and gets back a
 * single AsyncIterable<AgentEvent>. Single agent and council are the same call
 * at two points on config.coordination — there is no mode flag and no
 * "preset + goal" shape.
 *
 *   run(input) -> AsyncIterable<AgentEvent>
 *
 *   input.direction : { intent?: string, messages?: {role,content}[] }
 *   input.context   : { cwd?, projectId?, session? }
 *   input.config    : Composition (coordination, agent, tools, maxSteps,
 *                     onPermission, council options, …)
 *   input.signal    : optional AbortSignal. Aborting it — or abandoning the
 *                     returned iterator (break / .return()) — stops the
 *                     producer: no further turns, no not-yet-started tool
 *                     executions. The signal is threaded loop → dispatch →
 *                     executeTool (context.signal) so each layer observes it.
 *
 * Coordination continuum (the ratified continuum, not modes):
 *   - absent or "direct"        → single-agent loop (loop.js)
 *   - "<topologyId>" or { topology, lineup } → council (council.js)
 * An under-specified arrangement resolves to "direct" via this ruleset, never a
 * forced pick.
 *
 * The second argument `deps` is an internal injection seam (queryModelStream,
 * executeTool, runTopology, onEvent, toolNames, defaultModel) used by the test
 * harness so runs are hermetic. Public consumers pass only `input`.
 */
import { EventStream } from "./stream.js";
import { agentEvent } from "./events.js";
import { withPermissionChannel } from "./permission.js";
import { runSingleAgent } from "./loop.js";
import { runCouncil } from "./council.js";

export async function* run(input = {}, deps = {}) {
  rejectUnsupportedBoundWork(input.config || {},'generic SDK tool/orchestration loop');
  rejectUnsupportedBoundWork(input.context || {},'generic SDK tool/orchestration loop');
  const direction = input.direction || {};
  const context = input.context || {};
  const config = input.config || {};

  // Cancellation: one internal controller per run. It aborts when (a) the
  // caller's input.signal fires, or (b) the consumer abandons this iterator —
  // so a dropped stream never leaves the producer looping or executing tools.
  const controller = new AbortController();
  const externalSignal = input.signal || null;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const runId =
    context.session || context.sessionId || `agent-${Date.now()}-${rand()}`;

  // In-process consumers (e.g. OTL importing run()) drive illuci's secured tool
  // surface inside the host process, where process.cwd() is the host's, not the
  // user's project. Re-root the tool surface to the run's cwd when provided.
  if (context.cwd) {
    try {
      const { setWorkspaceRoot } = await import("../bridges/tools.js");
      setWorkspaceRoot(context.cwd);
    } catch { /* tools surface absent under fake-deps tests — ignore */ }
  }

  const kind = coordinationKind(config);
  const stream = new EventStream();
  const emit = (ev) => stream.push(ev);

  emit(agentEvent("run_start", runId, {
    coordination: describeCoordination(config, kind),
    agent: config.agent || null,
    cwd: context.cwd || null,
    projectId: context.projectId || null,
  }));

  const job = { stream, runId, direction, context, config, signal: controller.signal };

  // Drive the chosen path concurrently with iteration. The permission channel
  // (caller's onPermission) is installed for the path's whole duration.
  withPermissionChannel({ runId, onPermission: config.onPermission, emit }, () =>
    {
      if (kind === "council" && typeof deps.buildMemoryContext === "function") {
        throw new Error("Host-admitted memory is currently supported only for direct SDK runs");
      }
      return kind === "council" ? runCouncil(job, deps) : runSingleAgent(job, deps);
    },
  )
    .then((outcome) => {
      emit(agentEvent("run_complete", runId, {
        ok: outcome?.ok !== false,
        kind,
        steps: outcome?.steps ?? null,
        usage: outcome?.usage ?? null,
        truncated: outcome?.truncated || false,
        halted: outcome?.halted || false,
        haltReason: outcome?.haltReason || null,
        error: outcome?.error || null,
        trace: outcome?.trace || null,
      }));
    })
    .catch((err) => {
      emit(agentEvent("error", runId, { error: err.message, fatal: true }));
      emit(agentEvent("run_complete", runId, { ok: false, kind, error: err.message }));
    })
    .finally(() => stream.close());

  try {
    for await (const ev of stream) {
      yield ev;
    }
  } finally {
    // Runs on normal completion AND when the consumer abandons the iterator
    // (break / .return() / .throw()). Aborting after a clean close is a no-op;
    // aborting after abandonment is the fix: the producer's next abort check
    // stops the loop instead of letting orphaned turns keep executing tools.
    controller.abort(new Error("run abandoned by consumer"));
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/** Resolve the coordination continuum to "direct" | "council". */
function coordinationKind(config) {
  const c = config.coordination;
  if (!c) return "direct";
  if (typeof c === "string") return c === "direct" ? "direct" : "council";
  if (typeof c === "object" && c.topology) return "council";
  return "direct";
}

/** A legible descriptor of the resolved coordination for run_start. */
function describeCoordination(config, kind) {
  if (kind === "direct") return { kind: "direct", agent: config.agent || null };
  const c = config.coordination;
  const topology = typeof c === "string" ? c : c.topology;
  const lineup = (typeof c === "object" && c.lineup) || config.lineup || {};
  return { kind: "council", topology, lineup };
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}

export default { run };
