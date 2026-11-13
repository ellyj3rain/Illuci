/**
 * illuci — Dynamic-Resilience Layer (DRL): circuit breaker
 *
 * A per-canonical circuit breaker so a backend that is failing hard stops
 * receiving dispatches until it has had time to recover, instead of every run
 * burning its full timeout window against a dead model. Three states:
 *
 *   closed    — normal. Terminal failures accrue; after FAILURE_THRESHOLD
 *               consecutive terminal failures the breaker OPENS. Any success
 *               resets the failure count (the failures must be CONSECUTIVE).
 *   open      — dispatch is vetoed (fast-fail). After COOLDOWN_MS the breaker
 *               transitions to half-open on the next read.
 *   half-open — a single probe is allowed through (halfOpenMax = 1). A success
 *               accrues toward SUCCESS_THRESHOLD (which closes the breaker); a
 *               failure re-opens immediately and restarts the cooldown.
 *
 * Keyed by canonical id (canonical.js) so the alias snarl is dissolved: one
 * failing backend is one entry, not several phantom ones.
 *
 * READ/WRITE SEPARATION (load-bearing for the flag-off byte-identical guarantee
 * and for the self-heal probe contract):
 *   - isBreakerOpen / assertBreakerAllowsDispatch are READS. They never
 *     materialize a Map entry and never mutate state. A model with no recorded
 *     outcome has no entry and reads CLOSED (allowed) — exactly today's behavior.
 *     The open->half-open cooldown transition is observed lazily on read but only
 *     mutates an entry that ALREADY EXISTS (an open breaker, which only a failure
 *     could have created).
 *   - recordBreakerOutcome is the ONLY writer that materializes entries and
 *     drives the state machine. The discovery self-heal probe (index.js) calls
 *     reads only — it NEVER writes the breaker, so a probe can neither open nor
 *     close it.
 *
 * onBreakerOpen hook: a closed/half-open -> open transition fires the registered
 * listener (canonical key) so the self-heal layer can invalidate + re-probe the
 * model. The hook is best-effort and fully decoupled from the state machine.
 */

import { breakerConfig } from "./config.js";
import { toCanonicalKey } from "./canonical.js";

/** @typedef {{canonicalKey:string,state:'closed'|'open'|'half-open',failureCount:number,successCount:number,lastFailureTime:number,cooldownUntil:number,halfOpenInFlight:number}} BreakerEntry */

/** @type {Map<string, BreakerEntry>} */
const _breakers = new Map();

let _onBreakerOpen = null;

/** Register the (single) breaker-open listener. Called by initResilience to wire
 *  the discovery self-heal. Passing null clears it. */
export function setOnBreakerOpen(fn) {
  _onBreakerOpen = typeof fn === "function" ? fn : null;
}

function fireOpenHook(canonicalKey) {
  if (!_onBreakerOpen) return;
  try {
    _onBreakerOpen(canonicalKey);
  } catch (err) {
    // The self-heal hook is best-effort; a throw there must never corrupt the
    // breaker state machine or bubble into a dispatch.
    console.warn(`[drl] onBreakerOpen hook threw for "${canonicalKey}": ${err?.message || err}`);
  }
}

function freshEntry(canonicalKey) {
  return {
    canonicalKey,
    state: "closed",
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
    cooldownUntil: 0,
    halfOpenInFlight: 0,
  };
}

/**
 * Resolve the EFFECTIVE state of an existing entry at read time, applying the
 * open->half-open cooldown transition lazily. Mutates only an entry that already
 * exists; never materializes one. Returns the (possibly transitioned) entry, or
 * null when no entry exists (a never-seen model is implicitly closed).
 */
function effectiveEntry(canonicalKey, now = Date.now()) {
  const entry = _breakers.get(canonicalKey);
  if (!entry) return null;
  if (entry.state === "open" && now >= entry.cooldownUntil) {
    entry.state = "half-open";
    entry.successCount = 0;
    entry.halfOpenInFlight = 0;
  }
  return entry;
}

/**
 * READ: is the breaker open for this canonical key right now? Open means a
 * dispatch should be vetoed. half-open and closed both read false (a probe is
 * allowed through in half-open; the half-open in-flight budget is enforced by
 * assertBreakerAllowsDispatch, not here). Never materializes an entry.
 * @param {string} canonicalKey
 * @returns {boolean}
 */
export function isBreakerOpen(key, now = Date.now()) {
  // Canonicalize the argument so an alias and its canonical id read the SAME
  // entry (idempotent on an already-canonical key; O(1)). This is what dissolves
  // the alias snarl on the read side regardless of which spelling the caller used.
  const entry = effectiveEntry(toCanonicalKey(key), now);
  if (!entry) return false;
  return entry.state === "open";
}

/**
 * READ (with half-open in-flight bookkeeping): may a dispatch proceed for this
 * canonical key? Returns a verdict object; never throws.
 *
 *   { allowed: true }                         — closed, or half-open with a free probe slot
 *   { allowed: false, reason: 'open' }        — breaker open (fast-fail)
 *   { allowed: false, reason: 'half-open-busy'} — half-open, probe already in flight
 *
 * When it allows a half-open probe it increments halfOpenInFlight (reserving the
 * single probe slot). recordBreakerOutcome decrements it on the matching outcome.
 * This is the ONE read that touches halfOpenInFlight — it does so only on an entry
 * that already exists (open/half-open), so a never-seen model is still inert.
 * @param {string} canonicalKey
 * @returns {{allowed:boolean, reason?:string}}
 */
export function assertBreakerAllowsDispatch(key, now = Date.now()) {
  // Canonicalize (idempotent on a canonical key) — same alias-snarl dissolution
  // as isBreakerOpen, so a dispatch fast-fail keys the same entry recordOutcome did.
  const entry = effectiveEntry(toCanonicalKey(key), now);
  if (!entry) return { allowed: true };
  if (entry.state === "open") return { allowed: false, reason: "open" };
  if (entry.state === "half-open") {
    if (entry.halfOpenInFlight >= breakerConfig().halfOpenMax) {
      return { allowed: false, reason: "half-open-busy" };
    }
    entry.halfOpenInFlight += 1;
    return { allowed: true };
  }
  return { allowed: true };
}

/**
 * WRITE: feed a terminal dispatch outcome into the breaker state machine. This is
 * the only entry-materializing path. `terminal` true means a terminal failure
 * (counts toward opening); false means a success (resets/closes). Outcomes that
 * are neither (ignored: transient, aborted, paused, blocked) must NOT reach here
 * — outcome.js filters them out.
 *
 * @param {string} modelId  raw or canonical id (canonicalized internally)
 * @param {boolean} terminal true = terminal failure, false = success
 */
export function recordBreakerOutcome(modelId, terminal, now = Date.now()) {
  const canonicalKey = toCanonicalKey(modelId);
  const cfg = breakerConfig();
  let entry = _breakers.get(canonicalKey);
  if (!entry) {
    entry = freshEntry(canonicalKey);
    _breakers.set(canonicalKey, entry);
  }
  // Apply any pending cooldown transition before acting on the outcome.
  effectiveEntry(canonicalKey, now);

  if (terminal) {
    entry.lastFailureTime = now;
    if (entry.state === "half-open") {
      // A probe failed — re-open immediately and restart the cooldown.
      entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
      open(entry, cfg, now);
      return;
    }
    // closed (or a stray open, defensive): accrue consecutive failures.
    entry.failureCount += 1;
    entry.successCount = 0;
    if (entry.state === "closed" && entry.failureCount >= cfg.failureThreshold) {
      open(entry, cfg, now);
    }
    return;
  }

  // success
  if (entry.state === "half-open") {
    entry.halfOpenInFlight = Math.max(0, entry.halfOpenInFlight - 1);
    entry.successCount += 1;
    entry.failureCount = 0;
    if (entry.successCount >= cfg.successThreshold) {
      // Recovered — close.
      entry.state = "closed";
      entry.failureCount = 0;
      entry.successCount = 0;
      entry.cooldownUntil = 0;
      entry.halfOpenInFlight = 0;
    }
    return;
  }
  // closed (or stray open): a success clears the consecutive-failure streak.
  entry.failureCount = 0;
  entry.successCount = 0;
  if (entry.state === "closed") return;
  // Defensive: a success seen while open (no probe gate) closes it.
  entry.state = "closed";
  entry.cooldownUntil = 0;
}

function open(entry, cfg, now) {
  const wasOpen = entry.state === "open";
  entry.state = "open";
  entry.cooldownUntil = now + cfg.cooldownMs;
  entry.successCount = 0;
  entry.halfOpenInFlight = 0;
  if (!wasOpen) fireOpenHook(entry.canonicalKey);
}

/** READ: a defensive copy of a breaker entry (or null). For observability/tests.
 *  Canonicalizes its argument so an alias reads the same entry. */
export function getBreakerEntry(key, now = Date.now()) {
  const entry = effectiveEntry(toCanonicalKey(key), now);
  return entry ? { ...entry } : null;
}

/** Test-only: wipe all breaker state for a hermetic run. */
export function _resetBreakers() {
  _breakers.clear();
}

export default {
  isBreakerOpen,
  assertBreakerAllowsDispatch,
  recordBreakerOutcome,
  setOnBreakerOpen,
  getBreakerEntry,
};
