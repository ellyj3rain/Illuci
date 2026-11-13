// Phase 7 — the MC legibility feed (optional, one-way).
//
// The wanted META-DEPENDENCY made concrete. awareness/store.js exposes
// registerFederation(cb): a seam fired with every published AwarenessEvent. This
// module is the one place that attaches to that seam to forward events OUTWARD to
// Marshmallow Commons (its Musings half), so MC can read what the fleet's
// topologies have been doing without illuci ever reading back from MC.
//
// Three governance properties this module exists to guarantee:
//
//  - OPTIONAL. Nothing here runs until attachMcFeed() is called. illuci's dispatch,
//    council, and awareness paths run byte-identically when this surface is unused;
//    they never import this file (enforced by mc-feed.guard.test.js). If MC is
//    absent, the feed is simply never attached and the store's _federation stays
//    null, exactly as before.
//
//  - ONE-WAY. The feed only PUSHES AwarenessEvents to a sink. It never pulls,
//    never blocks a dispatch on MC, never lets MC's state influence illuci. The
//    runtime path's only relationship to MC is "fire and forget".
//
//  - SWALLOW-ON-ERROR. A sink that throws, rejects, or hangs must never break the
//    awareness bus or a dispatch. store.js already isolates the federation call in
//    a try/catch; this module adds a second layer (sync throws caught here, async
//    rejections caught on the promise) so a misbehaving MC is invisible to illuci.
//
// AwarenessEvent shape forwarded verbatim:
//   { id, ts, company, topologyId, seatId, kind, summary, tags[], tokens }

import { registerFederation } from "../awareness/store.js";

// The live unregister handle from the store's registerFederation. Non-null only
// while a feed is attached; attaching is idempotent (re-attaching swaps the sink).
let _detach = null;
let _sink = null;

/**
 * Build an HTTP sink that POSTs each event as JSON to a configured endpoint.
 * Fire-and-forget: a short timeout bounds the request and any failure is swallowed
 * so the awareness bus is never blocked or broken by an unreachable MC.
 *
 * @param {object} opts
 * @param {string} opts.endpoint        — absolute URL MC exposes for ingest
 * @param {string} [opts.token]         — optional bearer token
 * @param {number} [opts.timeoutMs=2000]
 * @param {function} [opts.fetchImpl]   — injectable for tests; defaults to global fetch
 * @returns {(event:object)=>void}      — a sink fn suitable for attachMcFeed
 */
export function createHttpSink({ endpoint, token = null, timeoutMs = 2000, fetchImpl } = {}) {
  if (!endpoint || typeof endpoint !== "string") {
    throw new TypeError("createHttpSink: an endpoint URL string is required");
  }
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  return function httpSink(event) {
    if (!doFetch) return; // no fetch in this runtime — no-op, never throw
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let body;
    try {
      body = JSON.stringify(event);
    } catch {
      return; // unserializable event — drop it, never throw into the bus
    }
    // AbortSignal.timeout may be absent on very old runtimes; guard it.
    let signal;
    try {
      signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    } catch { signal = undefined; }
    try {
      const p = doFetch(endpoint, { method: "POST", headers, body, signal });
      // Swallow async rejection (network error, timeout, MC down).
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      // Swallow synchronous throw from a misbehaving fetch impl.
    }
  };
}

/**
 * Resolve a sink from env when the caller passes none. Opt-in by configuration:
 * with no ILLUCI_CFG_MC_FEED_ENDPOINT set, returns null and the feed stays detached.
 * Uses the ILLUCI_CFG_ env prefix (the scoped config prefix, per CLAUDE.md),
 * NOT a hard import of config-service, to keep this module dependency-light.
 */
export function resolveEnvSink(env = process.env) {
  const endpoint = env.ILLUCI_CFG_MC_FEED_ENDPOINT || null;
  if (!endpoint) return null;
  const token = env.ILLUCI_CFG_MC_FEED_TOKEN || null;
  const timeoutMs = Number(env.ILLUCI_CFG_MC_FEED_TIMEOUT_MS) || 2000;
  return createHttpSink({ endpoint, token, timeoutMs });
}

/**
 * Attach the MC feed: register a federation callback on the awareness store that
 * forwards every published event to `sink`. Opt-in — the caller (an MC integration
 * point, never the runtime path) decides when to call this.
 *
 *   - sink may be a callback `(event) => void` OR a config object accepted by
 *     createHttpSink ({ endpoint, token?, timeoutMs? }).
 *   - Pass nothing to use resolveEnvSink(); if no endpoint is configured, this is
 *     a no-op and returns a detach fn that does nothing (feed never attached).
 *   - Re-calling swaps the sink in place (single feed; idempotent attach).
 *
 * @param {function|object} [sink]
 * @returns {() => void} detach — removes the federation callback; safe to call twice.
 */
export function attachMcFeed(sink) {
  // Resolve the sink: explicit callback, http config object, or env-derived.
  let resolved = null;
  if (typeof sink === "function") {
    resolved = sink;
  } else if (sink && typeof sink === "object") {
    resolved = createHttpSink(sink);
  } else if (sink == null) {
    resolved = resolveEnvSink();
  }

  // No sink available (e.g. nothing configured) — stay fully detached, no-op.
  if (typeof resolved !== "function") {
    return () => {};
  }

  _sink = resolved;

  // Already attached: swap the sink, keep the single store registration.
  if (_detach) return detachMcFeed;

  // Register ONE federation callback that delegates to whatever _sink currently is.
  // The double-guard (store catches, we catch) makes an MC fault invisible to illuci.
  _detach = registerFederation((event) => {
    const s = _sink;
    if (typeof s !== "function") return;
    try {
      s(event);
    } catch {
      // MC is optional — a throwing sink must never break the awareness bus.
    }
  });

  return detachMcFeed;
}

/** Detach the MC feed and clear the sink. Safe to call when already detached. */
export function detachMcFeed() {
  if (_detach) {
    try { _detach(); } catch { /* store unregister is best-effort */ }
    _detach = null;
  }
  _sink = null;
}

/** True while a feed is attached (a federation callback is live on the store). */
export function isMcFeedAttached() {
  return _detach !== null;
}

export default { attachMcFeed, detachMcFeed, isMcFeedAttached, createHttpSink, resolveEnvSink };
