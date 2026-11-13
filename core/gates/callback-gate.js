/**
 * illuci — Callback Gate (in-process approval transport)
 *
 * The in-process sibling of bridge-gate.js. Where bridge-gate ([A73]) carries
 * an approval request over an NDJSON stdout/stdin pipe for an out-of-process
 * driver, this carries it over a registered async function for an IN-PROCESS
 * consumer — the Agent SDK's injectable onPermission (the ratified §6.1
 * default). A run registers a callback for its duration and clears it when the
 * run completes.
 *
 * Purely additive: absent a registered callback, hasApprovalCallback() is false
 * and the gate controller falls through to its env-routed transports
 * (cli / tui / bridge / ide / headless) exactly as before. Registration takes
 * priority over ILLUCI_GATE_MODE because an in-process consumer that wired a
 * channel is the most specific intent available.
 *
 * Decision contract (mirrors cli/tui/bridge): { approved, reason?, modifiedContent? }
 */

let _callback = null;

/** Register the in-process approval handler. Throws on a non-function. */
export function registerApprovalCallback(fn) {
  if (typeof fn !== "function") {
    throw new Error("[callback-gate] approval callback must be a function");
  }
  _callback = fn;
}

/** Clear the handler so the controller reverts to env-routed transports. */
export function clearApprovalCallback() {
  _callback = null;
}

/** True when an in-process handler is registered. */
export function hasApprovalCallback() {
  return typeof _callback === "function";
}

/**
 * Route an approval request to the registered handler. Fail-closed on every
 * abnormal path (no handler, malformed decision, thrown handler) — a gate that
 * cannot get a clean approval denies.
 *
 * @param {object} params — { tool, args, level, source, diff, context, ... }
 * @returns {Promise<{ approved: boolean, reason?: string, modifiedContent?: string }>}
 */
export async function requestCallbackApproval(params) {
  if (!_callback) {
    return { approved: false, reason: "No in-process approval callback registered.", code: "approval-not-provided" };
  }
  try {
    const decision = await _callback(params);
    if (!decision || typeof decision !== "object" || typeof decision.approved !== "boolean") {
      return { approved: false, reason: "Approval callback returned a malformed decision.", code: "approval-not-provided" };
    }
    if (decision.approved && decision.code === "approval-not-provided") {
      return { approved: false, reason: "Approval callback returned a contradictory decision.", code: "approval-not-provided" };
    }
    return {
      approved: decision.approved,
      reason: decision.reason,
      modifiedContent: decision.modifiedContent,
      ...(decision.code === "approval-not-provided" ? { code: decision.code } : {}),
    };
  } catch (err) {
    return { approved: false, reason: `Approval callback threw: ${err.message}`, code: "approval-not-provided" };
  }
}

export default {
  registerApprovalCallback,
  clearApprovalCallback,
  hasApprovalCallback,
  requestCallbackApproval,
};
