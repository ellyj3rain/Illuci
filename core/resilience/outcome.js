/**
 * illuci — Dynamic-Resilience Layer (DRL): outcome taxonomy
 *
 * The bridge between a dispatch RESULT (the shape queryModel / queryModelStream
 * return) and the resilience state machines. It answers one question per
 * dispatch: was this a clean success, a TERMINAL failure of the backend, or
 * something the breaker must ignore?
 *
 * Taxonomy (exactly one terminal record per dispatch — the seam calls this once):
 *
 *   success          — a real response came back. Feeds the breaker (resets /
 *                      closes) and the latency ring.
 *   terminal_failure — the backend itself failed in a way that should count
 *                      toward opening the breaker: a PERMANENT error (4xx / auth /
 *                      unknown-model), or a genuinely UNKNOWN error (no transient
 *                      marker). Feeds the breaker (accrues) and the latency ring
 *                      (a failed dispatch still consumed wall-clock).
 *   ignored          — NOT the backend's fault, or not a signal about backend
 *                      health: TRANSIENT faults (already handled by withRetry's
 *                      backoff), ABORTED (operator/budget cancel), PAUSED (operator
 *                      paused the model), BLOCKED (governance deny). These never
 *                      touch the breaker — counting them would trip a breaker on a
 *                      network blip or an operator pause, which is exactly wrong.
 *
 * REUSE, don't re-derive: error-string classification delegates to retry.js's
 * classifyError (the single source for transient/permanent/aborted/unknown). The
 * DRL only adds the result-SHAPE signals (skipped/paused, blocked, aborted) that
 * live above the error string.
 */

import { classifyError } from "../dispatch/retry.js";
import { toCanonicalKey } from "./canonical.js";
import { recordBreakerOutcome } from "./breaker.js";
import { recordLatency } from "./latency-store.js";

/** @typedef {{modelId:string,canonicalKey:string,outcome:'success'|'terminal_failure'|'ignored',latencyMs:number,timestamp:number,terminal:boolean}} OutcomeRecord */

/**
 * Classify a dispatch result into the resilience taxonomy. Pure — no side
 * effects. Returns 'success' | 'terminal_failure' | 'ignored'.
 *
 * Recognizes both the buffered shape (queryModel: { failed, blocked, skipped,
 * reason, error }) and the streaming terminal shapes (queryModelStream final:
 * { skipped, reason }; error event: { aborted, blocked, error }).
 * @param {object|null} result
 * @returns {'success'|'terminal_failure'|'ignored'}
 */
export function classifyDispatchOutcome(result) {
  if (!result || typeof result !== "object") {
    // No result object at all — treat as terminal (a dispatch that produced
    // nothing usable). The seam only calls this on a real dispatch return, so
    // this is the defensive floor, not the common path.
    return "terminal_failure";
  }

  // ── shape signals that override the error string ──
  // The breaker's own fast-fail ({failed:true, breaker:'open'/'half-open-busy'}).
  // The breaker already decided this; counting it as a fresh terminal failure
  // would double-drive the state machine. It carries no new backend-health signal
  // (no dispatch reached the backend), so it is ignored.
  if (result.breaker === "open" || result.breaker === "half-open-busy") return "ignored";
  // Operator paused the model — a deliberate, reversible state, not a failure.
  if (result.skipped === true || result.reason === "paused") return "ignored";
  // Operator/budget abort — cancellation, not a backend fault.
  if (result.aborted === true) return "ignored";
  // Governance deny — policy, not backend health.
  if (result.blocked === true) return "ignored";

  // ── failure path: classify the error string via retry.js ──
  if (result.failed === true || (result.error && result.response == null)) {
    const cls = classifyError({ message: String(result.error || "") });
    // Only PERMANENT and genuinely UNKNOWN count toward opening the breaker.
    // TRANSIENT (network/5xx/429) and ABORTED are ignored — withRetry already
    // owns transients, and an abort is a cancel.
    if (cls === "permanent" || cls === "unknown") return "terminal_failure";
    return "ignored";
  }

  // A real response (or at least no failure marker) is a success.
  return "success";
}

/**
 * Classify a dispatch result AND feed the breaker + latency store. Called once
 * per dispatch by the dispatch-path seams (exactly one terminal record per
 * dispatch). Returns the OutcomeRecord for observability/tests.
 *
 * Only 'success' and 'terminal_failure' reach the breaker; 'ignored' touches
 * nothing. Latency is recorded for success and terminal_failure (both consumed
 * wall-clock that informs the p95); an 'ignored' outcome with a latency is not
 * recorded (a paused/aborted dispatch did not exercise the backend).
 *
 * @param {string} modelId raw or canonical id
 * @param {object|null} result the dispatch result shape
 * @param {number} latencyMs observed wall-clock for this dispatch
 * @returns {OutcomeRecord}
 */
export function recordDispatchOutcome(modelId, result, latencyMs) {
  const canonicalKey = toCanonicalKey(modelId);
  const outcome = classifyDispatchOutcome(result);
  const timestamp = Date.now();
  const terminal = outcome === "terminal_failure";
  const ms = Number.isFinite(latencyMs) ? latencyMs : (Number.isFinite(result?.latency) ? result.latency : 0);

  if (outcome === "success") {
    recordBreakerOutcome(canonicalKey, false);
    recordLatency(canonicalKey, ms);
  } else if (outcome === "terminal_failure") {
    recordBreakerOutcome(canonicalKey, true);
    recordLatency(canonicalKey, ms);
  }
  // 'ignored' feeds nothing.

  return { modelId, canonicalKey, outcome, latencyMs: ms, timestamp, terminal };
}

export default { classifyDispatchOutcome, recordDispatchOutcome };
