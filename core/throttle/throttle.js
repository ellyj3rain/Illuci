/**
 * illuci — Throttle Layer
 *
 * Self-imposed rate limiting per provider. Protects consumer-tier
 * subscriptions from tripping abuse detection. This exists to protect
 * access, not manage costs.
 *
 * Sliding window per throttle key (provider id, or alias-level override):
 *   - tokensPerMinute: max tokens dispatched in rolling 60s
 *   - requestsPerMinute: max requests in rolling 60s
 *   - concurrencyLimit: max in-flight requests
 *   - minDelayMs: minimum gap between requests on the same key
 *
 * Limits are operator-settable configuration (core/config/throttle-config.js:
 * defaults <- illuci.config.json "throttle" <- ILLUCI_THROTTLE_LIMITS env), and
 * adjustable live via setLimits()/removeLimits(). Keys with no entry fall to
 * the "default" limits — unknown models are protected-by-default, never
 * silently unlimited.
 *
 * Throttle decisions are logged with full provenance.
 */

import { logDecision } from "../decisions/logger.js";
import { DEFAULT_THROTTLE_LIMITS, loadThrottleLimits } from "../config/throttle-config.js";

// ─── LIVE LIMITS TABLE ───
// Loaded from operator-settable configuration; mutable at runtime through
// setLimits()/removeLimits() so consumer UIs (e.g. OTL settings) can adjust
// live limits. The throttle's protective role is retained — only its
// parameters moved to a configuration surface.

const LIMITS = loadThrottleLimits();

// ─── SLIDING WINDOW STATE ───

const windows = {};

function getWindow(provider) {
  if (!windows[provider]) {
    windows[provider] = {
      requests: [],    // timestamps of recent requests
      tokens: [],      // { timestamp, count } of recent token usage
      inflight: 0,
      lastRequest: 0,
      waiters: new Set(), // Phase F: resolve fns of acquires blocked on the concurrency cap
    };
  }
  return windows[provider];
}

function pruneWindow(win) {
  const cutoff = Date.now() - 60000;
  win.requests = win.requests.filter((t) => t > cutoff);
  win.tokens = win.tokens.filter((t) => t.timestamp > cutoff);
}

// ─── ATOMIC RESERVE (Phase F — concurrency safety) ───
//
// acquireSlot's hot path is: checkThrottle() reads win.inflight, then — on a separate
// statement — win.inflight++. Under runCompany, parallel seats call acquireSlot on the
// SAME key concurrently. Each await yields the event loop, so two acquires can both pass
// the concurrency check (both see inflight = limit-1) before either increments — the
// throttle is bypassed and inflight exceeds concurrencyLimit. The fix folds the check and
// the inflight reservation into ONE synchronous, non-yielding critical section
// (tryReserveSlot): it cannot be preempted mid-read-modify-write, so two reservations can
// never both succeed past the cap. The async backoff loop stays in acquireSlot and is
// byte-identical for a single caller (one un-contended reserve succeeds on the first try,
// same requests/lastRequest/inflight writes, same order). This is the shimmable seam
// (acquireSlot) batch 2's worker-thread isolation reuses for a real cross-thread mutex.
//
// Returns { ok: true } when the slot was reserved (inflight already incremented), or
// { ok: false, check } carrying the original checkThrottle verdict for the backoff wait.
function tryReserveSlot(provider) {
  const check = checkThrottle(provider);
  if (!check.allowed) return { ok: false, check };
  // Reserve synchronously, in the same tick as the check — no await between read and write.
  const win = getWindow(provider);
  win.requests.push(Date.now());
  win.lastRequest = Date.now();
  win.inflight++;
  return { ok: true, check };
}

// ─── WAITER WAKEUP (Phase F — liveness under contention) ───
//
// The atomic reserve above closes the *correctness* gap (no cap overshoot). It does not,
// on its own, close the *liveness* gap: a blocked acquire used to sleep a FIXED waitMs
// (1000ms for the concurrency reason) then re-poll, capped at 30 attempts. Under a
// concurrent-acquire storm — exactly the runCompany case — that fixed busy-poll collapses
// throughput from the ideal ~(n·hold/limit) into tens of seconds and can exhaust the
// attempt ceiling, throwing a false "Throttle timeout" even though slots free constantly.
//
// The fix wakes concurrency-blocked waiters the instant a slot frees instead of making
// them wait out a full fixed backoff. releaseSlot() drains the window's waiter set; each
// woken acquire immediately re-attempts tryReserveSlot. A concurrency wait also races a
// short safety timeout (so a missed wakeup can never deadlock) and does NOT consume an
// attempt (it is waiting for a deterministic free slot, not a rate window), so heavy
// bursts complete without spurious timeouts. Rate-window blocks (RPM / minDelay / TPM)
// keep their original time-based backoff and attempt accounting untouched — those are
// genuine clock windows, not slot contention. The single un-contended caller path is
// byte-identical: it reserves on the first tryReserveSlot and never reaches this code.

/** Wake every acquire blocked on this key's concurrency cap; each re-attempts at once. */
function wakeWaiters(win) {
  if (!win.waiters || win.waiters.size === 0) return;
  const woken = [...win.waiters];
  win.waiters.clear();
  for (const resolve of woken) resolve();
}

/**
 * Park a concurrency-blocked acquire until releaseSlot wakes it, or a short safety
 * timeout elapses (defends against a missed wakeup — never deadlocks). Resolves with no
 * value; the caller re-attempts tryReserveSlot after it settles.
 */
function waitForSlotFree(win, safetyMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.waiters.delete(wake);
      resolve();
    };
    const wake = () => { clearTimeout(timer); done(); };
    const timer = setTimeout(done, safetyMs);
    if (timer.unref) timer.unref();
    win.waiters.add(wake);
  });
}

// ─── PUBLIC API ───

/**
 * Resolve the throttle key for a model alias.
 * An alias-level entry in the limits table wins; otherwise throttling
 * happens at the provider level (provider comes from MODEL_DEFAULTS in
 * core/bridges/index.js, threaded through by dispatch), so all aliases of
 * one provider share one sliding window. A key with no entry at all keeps
 * its own window under the "default" limits.
 */
export function resolveThrottleKey(modelId, provider = null) {
  if (LIMITS[modelId]) return modelId;
  if (provider && LIMITS[provider]) return provider;
  return provider || modelId;
}

/**
 * Check if a request on this throttle key is allowed right now.
 * Returns { allowed, reason, waitMs }
 */
export function checkThrottle(provider) {
  const limits = LIMITS[provider] || LIMITS.default;
  if (!limits) return { allowed: true, reason: "unthrottled (no entry and no default limits configured)" };

  const win = getWindow(provider);
  pruneWindow(win);

  // Concurrency check
  if (win.inflight >= limits.concurrencyLimit) {
    return { allowed: false, reason: "concurrency limit", waitMs: 1000 };
  }

  // RPM check
  if (win.requests.length >= limits.requestsPerMinute) {
    const oldest = win.requests[0];
    const waitMs = oldest + 60000 - Date.now();
    return { allowed: false, reason: "requests per minute", waitMs: Math.max(waitMs, 100) };
  }

  // Min delay check
  const elapsed = Date.now() - win.lastRequest;
  if (elapsed < limits.minDelayMs) {
    return { allowed: false, reason: "min delay", waitMs: limits.minDelayMs - elapsed };
  }

  // TPM check
  const totalTokens = win.tokens.reduce((sum, t) => sum + t.count, 0);
  if (totalTokens >= limits.tokensPerMinute) {
    const oldest = win.tokens[0];
    const waitMs = oldest.timestamp + 60000 - Date.now();
    return { allowed: false, reason: "tokens per minute", waitMs: Math.max(waitMs, 100) };
  }

  return { allowed: true };
}

/**
 * Wait until the throttle allows a request, then mark it as started.
 * Returns when clear to proceed.
 */
export async function acquireSlot(provider) {
  let attempts = 0;
  const maxAttempts = 30;
  let logged = false;

  while (attempts < maxAttempts) {
    // Atomic check-and-reserve: the concurrency read and the inflight increment happen
    // in one non-yielding tick, so concurrent acquires on the same key cannot both pass
    // the cap. For a single caller this is byte-identical to the prior inline path.
    const reserved = tryReserveSlot(provider);
    if (reserved.ok) return;
    const check = reserved.check;

    // Log the first block once, regardless of which wait path follows.
    if (!logged) {
      logged = true;
      logDecision({
        humanStatus: "operator-absent",
        modelStatus: { model: provider, role: "throttled" },
        context: `Throttle: ${provider} — ${check.reason}`,
        type: "throttle",
        decision: `Waiting ${check.waitMs}ms for ${provider} (${check.reason})`,
      });
    }

    if (check.reason === "concurrency limit") {
      // Slot contention: wait to be WOKEN by a releaseSlot rather than burning a fixed
      // backoff, and don't count it against the attempt ceiling (a free slot is
      // deterministic, so this can never spuriously time out under a storm). A short
      // safety timeout caps the park in case a wakeup is ever missed.
      await waitForSlotFree(getWindow(provider), Math.min(check.waitMs, 100));
      continue;
    }

    // Rate-window block (RPM / minDelay / TPM): a genuine clock window — keep the
    // original time-based backoff and attempt accounting unchanged.
    await new Promise((resolve) => setTimeout(resolve, check.waitMs));
    attempts++;
  }

  throw new Error(`Throttle timeout: ${provider} did not become available after ${maxAttempts} attempts`);
}

/**
 * Mark a request as completed and record token usage.
 */
export function releaseSlot(provider, tokenCount = 0) {
  const win = getWindow(provider);
  win.inflight = Math.max(0, win.inflight - 1);
  if (tokenCount > 0) {
    win.tokens.push({ timestamp: Date.now(), count: tokenCount });
  }
  // A slot just freed — wake any acquires parked on the concurrency cap so they
  // re-attempt immediately instead of waiting out a fixed backoff (liveness).
  wakeWaiters(win);
}

/**
 * Get current throttle status for every configured key plus every key with
 * live window activity (unknown keys running under "default" limits).
 */
export function getThrottleStatus() {
  const status = {};
  const keys = new Set([
    ...Object.keys(LIMITS).filter((k) => k !== "default"),
    ...Object.keys(windows),
  ]);
  for (const key of keys) {
    const win = getWindow(key);
    pruneWindow(win);
    const totalTokens = win.tokens.reduce((sum, t) => sum + t.count, 0);
    status[key] = {
      inflight: win.inflight,
      rpm: win.requests.length,
      tpm: totalTokens,
      limits: LIMITS[key] || LIMITS.default || null,
      explicit: Boolean(LIMITS[key]),
    };
  }
  return status;
}

/**
 * Full configuration view for settings surfaces (e.g. OTL settings UI):
 * the live limits table, the shipped defaults, and the resolution order.
 * Returned copies are detached — adjust via setLimits()/removeLimits().
 */
export function getThrottleConfig() {
  return {
    limits: JSON.parse(JSON.stringify(LIMITS)),
    defaults: JSON.parse(JSON.stringify(DEFAULT_THROTTLE_LIMITS)),
    resolution: ["alias", "provider", "default"],
  };
}

/**
 * Override limits at runtime (e.g., from a settings UI, after a TOS
 * warning, or to open up for enterprise). Creating a new entry seeds it
 * from the "default" limits so partial overrides stay protective.
 */
export function setLimits(provider, overrides) {
  if (!LIMITS[provider]) LIMITS[provider] = { ...(LIMITS.default || {}) };
  Object.assign(LIMITS[provider], overrides);

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: { model: provider, role: "config" },
    context: `Throttle limits updated for ${provider}`,
    type: "config",
    decision: `Updated throttle limits: ${JSON.stringify(overrides)}`,
  });
}

/**
 * Remove an explicit entry so the key falls back through provider/default
 * resolution. Returns false if no entry existed.
 */
export function removeLimits(provider) {
  if (!LIMITS[provider]) return false;
  delete LIMITS[provider];

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: { model: provider, role: "config" },
    context: `Throttle limits entry removed for ${provider}`,
    type: "config",
    decision: `Removed throttle limits entry: ${provider}`,
  });
  return true;
}

export default {
  resolveThrottleKey,
  checkThrottle,
  acquireSlot,
  releaseSlot,
  getThrottleStatus,
  getThrottleConfig,
  setLimits,
  removeLimits,
};
