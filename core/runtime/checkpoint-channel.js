// core/runtime/checkpoint-channel.js
//
// [A43] The checkpoint-decision channel — the wire that makes
// runControl.tools.autonomy "checkpointed" reachable from a remote host surface. The engine's
// fire-control port contract (core/topologies/checkpoint.js resolveCheckpoint:
// async ({step, seats, firingMode, mandate}) => {action, intent?}) is bridged
// over the runtime transport:
//
//   request OUT — the port emits a `checkpoint-request` event through the
//                 runtime emitter, so it rides the existing GET /runtime/events
//                 SSE stream to every connected surface;
//   decision IN — the surface POSTs /runtime/checkpoint/decision
//                 { checkpointId, action, intent? }; the pending port promise
//                 resolves with it.
//
// FAIL-CLOSED (DR-127's law, transport edition): an unanswered checkpoint
// times out to { action: "abort" } — pacing without a pacer never silently
// proceeds; an abandoned paced run halts honestly. (Contrast: checkpoint.js
// treats a MISSING port as "proceed" for headless back-compat — this channel
// exists precisely so a PRESENT port never behaves like a missing one.)

import { randomUUID } from "node:crypto";

export const CHECKPOINT_ACTIONS = Object.freeze(["proceed", "redirect", "skip", "abort"]);
export const DEFAULT_CHECKPOINT_TIMEOUT_MS = 300000; // the Phase-F gate-timeout precedent: 5 min

export function createCheckpointChannel({ emit, timeoutMs = DEFAULT_CHECKPOINT_TIMEOUT_MS } = {}) {
  if (typeof emit !== "function") throw new Error("checkpoint-channel: an emit function is required (the runtime event emitter)");
  const pending = new Map(); // checkpointId -> { resolve, timer, summary }

  /** The fire-control port to hand runTopology (options.checkpoint). */
  async function port({ step, seats, firingMode, mandate } = {}) {
    const checkpointId = randomUUID();
    const summary = {
      checkpointId,
      stepId: step?.id || null,
      stepType: step?.type || null,
      seats: seats || step?.seats || (step?.seat ? [step.seat] : []),
      firingMode: firingMode || "semi",
      mandate: typeof mandate === "string" ? mandate : mandate?.intent?.raw || null,
      requestedAt: new Date().toISOString(),
      timeoutMs,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(checkpointId);
        emit({ type: "checkpoint-timeout", checkpointId, action: "abort" });
        resolve({ action: "abort", intent: `checkpoint ${checkpointId} unanswered after ${timeoutMs}ms — fail-closed abort (pacing without a pacer never proceeds)` });
      }, timeoutMs);
      // The timer stays REF'D deliberately: the caller is awaiting an operator
      // decision, and an unref'd timer lets a quiescent process exit before the
      // fail-closed abort can fire (caught by CI — the local run masked it).
      pending.set(checkpointId, { resolve, timer, summary });
      emit({ type: "checkpoint-request", ...summary });
    });
  }

  /** Deliver a decision from the surface. Coded result, never a throw. */
  function resolveDecision(checkpointId, { action, intent } = {}) {
    const entry = pending.get(checkpointId);
    if (!entry) return { ok: false, code: "unknown-checkpoint", checkpointId };
    if (!CHECKPOINT_ACTIONS.includes(action)) {
      return { ok: false, code: "invalid-action", checkpointId, allowed: [...CHECKPOINT_ACTIONS] };
    }
    clearTimeout(entry.timer);
    pending.delete(checkpointId);
    emit({ type: "checkpoint-decision", checkpointId, action, ...(intent ? { intent } : {}) });
    entry.resolve({ action, ...(intent ? { intent } : {}) });
    return { ok: true, checkpointId, action };
  }

  /** The queue a surface renders (the approvals-inbox shape). */
  function pendingRequests() {
    return [...pending.values()].map((e) => e.summary);
  }

  return { port, resolveDecision, pendingRequests };
}

export default { CHECKPOINT_ACTIONS, DEFAULT_CHECKPOINT_TIMEOUT_MS, createCheckpointChannel };
