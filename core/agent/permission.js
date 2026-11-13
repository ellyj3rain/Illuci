/**
 * illuci Agent SDK — Permission Channel
 *
 * Installs the caller's injectable onPermission as the in-process approval
 * channel for the duration of a run (the ratified §6.1 default), and emits a
 * `permission` AgentEvent for each request so the request is visible in the
 * public stream before the operator decides.
 *
 * If the caller supplies no onPermission, NOTHING is registered: the gate
 * controller routes by ILLUCI_GATE_MODE (cli / bridge / headless / ...) exactly as
 * before. That is the documented fallback — the SDK never silently changes
 * gating behavior for a consumer that did not ask for the in-process channel.
 *
 * The registration is module-global (callback-gate holds one handler), so a run
 * that installs a channel must run to completion before another installs one in
 * the same process. This matches the ratified concurrency posture: one active
 * gated run per process.
 */

import { agentEvent } from "./events.js";
import {
  registerApprovalCallback,
  clearApprovalCallback,
} from "../gates/callback-gate.js";

function summarize(params) {
  if (!params) return "";
  if (params.summary) return params.summary;
  if (params.args?.path) return `${params.tool} ${params.args.path}`;
  if (params.args?.command) return `${params.tool} ${String(params.args.command).slice(0, 80)}`;
  return params.tool || "";
}

/**
 * Run `body()` with the caller's onPermission installed as the gate channel.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {(req: object) => Promise<{approved:boolean, reason?:string, modifiedContent?:string}>} [opts.onPermission]
 * @param {(ev: object) => void} opts.emit — pushes an AgentEvent into the run stream
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 * @template T
 */
export async function withPermissionChannel({ runId, onPermission, emit }, body) {
  // No channel requested → env-routed fallback, no registration.
  if (typeof onPermission !== "function") {
    return await body();
  }

  const handler = async (params) => {
    // Surface the request in the public stream first…
    emit(agentEvent("permission", runId, {
      id: params.requestId || params.id || null,
      agent: params.source?.model || null,
      seat: params.source?.seat || null,
      tool: params.tool,
      args: params.args,
      level: params.level || null,
      source: params.source || null,
      diff: params.diff || null,
      summary: summarize(params),
      pending: true,
      // actionable:true marks this as a LIVE callback-gate request: an onPermission is awaiting
      // RIGHT NOW (below) for the operator's decision. A consumer that round-trips an actionable
      // request back to the operator (the ACP adapter) can resolve the answer here. The council
      // path's `permission` event (events.js translates permission_requested) is a post-hoc HALT
      // NOTIFICATION with no awaiting callback — it omits this marker, so a consumer must NOT
      // solicit a decision for it (the answer would be dropped, hanging the operator).
      actionable: true,
    }));
    // …then defer to the operator's decision.
    return await onPermission({ ...params, runId });
  };

  registerApprovalCallback(handler);
  try {
    return await body();
  } finally {
    clearApprovalCallback();
  }
}

export default { withPermissionChannel };
