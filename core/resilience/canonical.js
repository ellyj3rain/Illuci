/**
 * illuci — Dynamic-Resilience Layer (DRL): canonical keying
 *
 * Every DRL surface (breaker, latency store, outcome counters) keys by CANONICAL
 * model identity rather than the raw spelling a caller happened to pass. This
 * dissolves the alias snarl: "claude-local" and "claude-fable" are ONE dispatch
 * target (the registry resolves both to the same entry), so they must share ONE
 * breaker entry and ONE latency ring. Keying by raw string would split a single
 * failing backend across several phantom keys, and the breaker would never trip.
 *
 *   Invariant: toCanonicalKey('claude-local') === toCanonicalKey('claude-fable')
 *
 * Delegation, not a second source of truth: resolveModelId is THE registry's
 * canonicalizer. An unknown spelling has no canonical id, so we fall back to the
 * raw string (warn-once) — an unknown model still gets a stable, distinct key and
 * degrades exactly as the rest of the stack does for an unknown id. O(1): the
 * registry lookup is a Map hit; the warn-set membership check is O(1).
 */

import { resolveModelId } from "../bridges/model-registry.js";

const _warnedUnknown = new Set();

/**
 * The canonical key for any model spelling. Delegates to the registry's
 * resolveModelId; falls back to the raw id (warn-once) for an unknown spelling.
 * @param {string} rawId
 * @returns {string} canonical id, or the raw id when unknown
 */
export function toCanonicalKey(rawId) {
  const canonical = resolveModelId(rawId);
  if (canonical) return canonical;
  if (rawId && !_warnedUnknown.has(rawId)) {
    _warnedUnknown.add(rawId);
    console.warn(`[drl] unknown model id "${rawId}" — keying resilience state by the raw spelling`);
  }
  return rawId;
}

/** Test-only: clear the warn-once memory so a hermetic test can re-observe a warn. */
export function _resetCanonicalWarnings() {
  _warnedUnknown.clear();
}

/**
 * The per-CHANNEL resilience key (DR-134, P4). When one identity is reachable on
 * more than one transport (e.g. Opus on the Claude CLI and on agy/Antigravity),
 * a dead transport must trip ITS OWN breaker without poisoning the live one — the
 * identity-only toCanonicalKey would fuse them into one breaker entry. This appends
 * the transport to the canonical identity key so each channel keys distinctly.
 *
 * NON-PERSISTED: this keys in-memory resilience state (breaker / latency ring /
 * outcome counters) only; it is never written to a saved seat or org file (those
 * persist the canonical identity id, never a `id#transport` composite). The
 * default no-transport path keeps using toCanonicalKey unchanged, so the
 * single-channel dispatch path is byte-identical.
 *
 * STATUS (P4 — SEAM, NOT yet wired): this helper has NO callers yet. dispatch.js and
 * isAvailable still key the breaker / latency / outcome by the IDENTITY (toCanonicalKey),
 * so the per-channel isolation described above is NOT yet enforced — with ILLUCI_DRL_ENABLED
 * + ILLUCI_FLEET_CHANNELS_ENABLED both on, a dead channel still trips the identity breaker
 * (poisoning the live channel). Wiring this key into the dispatch resilience calls + the
 * isAvailable veto is tracked P4 follow-up (surfaced by the illuci dev-team audit, [A145]).
 *
 *   Invariant (the intended end-state once wired):
 *              toChannelKey('claude-opus', 'cli') === 'claude-opus#cli'
 *              toChannelKey('claude-opus', 'antigravity') === 'claude-opus#antigravity'
 *
 * @param {string} rawId — any model spelling (canonicalized via toCanonicalKey)
 * @param {string} transport — the channel transport (cli / antigravity / api / ...)
 * @returns {string} `${canonicalId}#${transport}`
 */
export function toChannelKey(rawId, transport) {
  return `${toCanonicalKey(rawId)}#${transport}`;
}

export default { toCanonicalKey, toChannelKey };
