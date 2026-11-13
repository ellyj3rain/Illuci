/**
 * illuci — Dynamic-Resilience Layer (DRL): barrel + wiring
 *
 * The legislature-ratified DRL gives dispatch an observed-health spine: a
 * per-canonical circuit breaker that fast-fails a dead backend, an observed-p95
 * timeout extension so a genuinely-slow model is not guillotined, an EWMA
 * stall-watcher for stuck streams, and a self-heal seam that re-probes a model
 * the moment its breaker opens. The whole layer is dark behind ILLUCI_DRL_ENABLED
 * (default OFF): with the flag off every seam is inert and dispatch is
 * byte-identical to today's behavior.
 *
 * This barrel re-exports the public surface and owns initResilience(), which
 * wires the breaker's onBreakerOpen hook to model-discovery's self-heal:
 *
 *   breaker opens for <canonicalKey>
 *     -> invalidate(<canonicalKey>)             (drop the cached availability)
 *     -> async re-probe (probeModel / discoverOllama, fire-and-forget)
 *
 * The probe is OBSERVATIONAL and decoupled: it refreshes the discovery cache, it
 * NEVER writes the breaker (only recordDispatchOutcome, driven by a real
 * dispatch, moves the state machine). A probe success therefore does not close
 * the breaker — the breaker closes only when real half-open dispatches succeed.
 * This keeps the read/write separation intact and prevents a probe from masking a
 * still-broken backend. The discovery import is LAZY (inside the listener) so the
 * resilience module has no static dependency on the bridge graph.
 */

import { isDrlEnabled, breakerConfig, latencyRingSize, stallConfig } from "./config.js";
import { toCanonicalKey, _resetCanonicalWarnings } from "./canonical.js";
import {
  isBreakerOpen,
  assertBreakerAllowsDispatch,
  recordBreakerOutcome,
  setOnBreakerOpen,
  getBreakerEntry,
  _resetBreakers,
} from "./breaker.js";
import { recordLatency, getP95, makeStallWatcher, _resetLatency } from "./latency-store.js";
import { classifyDispatchOutcome, recordDispatchOutcome } from "./outcome.js";

let _initialized = false;

/**
 * Wire the DRL self-heal once. Idempotent. Registers the breaker-open listener
 * that invalidates the discovery cache for the failing canonical model and kicks
 * an async re-probe. The probe never writes the breaker (see file header).
 *
 * Safe to call unconditionally at startup: with ILLUCI_DRL_ENABLED off the listener
 * is wired but can never fire, because no seam records breaker outcomes when the
 * flag is off — so it stays inert.
 */
export function initResilience() {
  if (_initialized) return;
  _initialized = true;

  setOnBreakerOpen((canonicalKey) => {
    // Fire-and-forget; a self-heal failure must never bubble into a dispatch.
    (async () => {
      try {
        const discovery = await import("../bridges/model-discovery.js");
        // Drop the cached availability so the next discovery read re-probes.
        discovery.invalidate(canonicalKey);
        // Kick a live re-probe to refresh the world. ollama-served models use
        // the tags endpoint; vendor-CLI models probe through their bridge. We do
        // NOT branch on family here beyond a best-effort attempt — discovery owns
        // the source-of-truth logic; this only nudges it to refresh. The probe
        // result updates the discovery cache, NOT the breaker.
        const entry = (await import("../bridges/model-registry.js")).getEntry(canonicalKey);
        if (entry && entry.bridge === "ollama.js") {
          await discovery.discoverOllama();
        } else if (entry) {
          await discovery.probeModel({
            id: entry.id,
            bridge: entry.bridge,
            model: entry.model || entry.id,
          });
        }
      } catch (err) {
        console.warn(`[drl] self-heal re-probe failed for "${canonicalKey}": ${err?.message || err}`);
      }
    })();
  });
}

/** Test-only: reset all DRL state (breakers, latency rings, warn-once, init). */
export function _resetResilience() {
  _resetBreakers();
  _resetLatency();
  _resetCanonicalWarnings();
  setOnBreakerOpen(null);
  _initialized = false;
}

export {
  // config
  isDrlEnabled,
  breakerConfig,
  latencyRingSize,
  stallConfig,
  // canonical
  toCanonicalKey,
  // breaker
  isBreakerOpen,
  assertBreakerAllowsDispatch,
  recordBreakerOutcome,
  setOnBreakerOpen,
  getBreakerEntry,
  // latency
  recordLatency,
  getP95,
  makeStallWatcher,
  // outcome
  classifyDispatchOutcome,
  recordDispatchOutcome,
};

export default {
  initResilience,
  isDrlEnabled,
  toCanonicalKey,
  isBreakerOpen,
  assertBreakerAllowsDispatch,
  recordBreakerOutcome,
  getBreakerEntry,
  recordLatency,
  getP95,
  makeStallWatcher,
  classifyDispatchOutcome,
  recordDispatchOutcome,
};
