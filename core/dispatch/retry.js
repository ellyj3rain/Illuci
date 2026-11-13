/**
 * illuci — Dispatch Resilience
 *
 * Core-loop remediation 2. The audit found one transient model error fatal to
 * the whole run: no retry, no backoff, errors unclassified, and a paused model
 * silently reported as success. This classifies errors and retries transient
 * faults with bounded exponential backoff — and never retries an abort or a
 * permanent (4xx / auth / unknown-model) error.
 *
 * Retry is applied to single-shot bridge calls — bridge.query (the CLI fleet's
 * path) and the non-streaming fallback inside queryModelStream — where there is no
 * partial output to corrupt. A native streaming bridge (bridge.queryStream) is NOT
 * wrapped today: a failure even before the first delta surfaces as terminal rather
 * than retrying. Adding a before-first-delta retry guard on that path (it must stop
 * retrying the instant a token has flowed) lands with the streaming-bridge work; the
 * earlier claim that streaming "retries before the first delta" was aspirational.
 */

// Connection / server / rate-limit faults are retry candidates only when the
// caller has not marked the outcome uncertain or retry unsafe.
// Timeouts are deliberately NOT here: the adaptive reasoning-tier fallback
// (dispatch.js) already escalates on timeout, and re-running an attempt that
// just consumed its full timeout window is wasteful.
const TRANSIENT_PATTERNS = [
  /\bECONNRESET\b/i, /\bEAI_AGAIN\b/i, /\bENOTFOUND\b/i,
  /\bEPIPE\b/i, /socket hang ?up/i, /fetch failed/i, /network/i,
  /\b429\b/, /\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/, /\b529\b/,
  /rate.?limit/i, /overloaded/i, /temporarily unavailable/i, /try again/i,
];

const PERMANENT_PATTERNS = [
  /\b400\b/, /\b401\b/, /\b403\b/, /\b404\b/, /\b422\b/,
  /unknown model/i, /not found/i, /invalid/i, /unauthor/i, /forbidden/i,
  /api[_ ]?key not set/i, /no such/i, /bad request/i,
];

/**
 * Classify an error into "aborted" | "permanent" | "transient".
 * Default for the genuinely unknown is "transient" only when it carries no
 * permanent marker — an unrecognized error is retried once cautiously rather
 * than either always-fatal (today) or always-retried (unsafe).
 */
export function classifyError(err) {
  if (!err) return "transient";
  const name = err.name || "";
  const msg = String(err.message || err);
  if (name === "AbortError" || /\bABORTED\b/.test(msg) || /\baborted\b/i.test(msg)) return "aborted";
  if (PERMANENT_PATTERNS.some((re) => re.test(msg))) return "permanent";
  if (TRANSIENT_PATTERNS.some((re) => re.test(msg))) return "transient";
  return "unknown";
}

/** Whether an error should be retried given its class. */
export function isRetryable(err) {
  const cls = classifyError(err);
  return cls === "transient";
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an async function with bounded exponential backoff on transient errors.
 *
 * @param {() => Promise<any>} fn          the operation (a fresh attempt each call)
 * @param {object} opts
 * @param {number} [opts.maxAttempts=3]    total attempts (1 = no retry)
 * @param {number} [opts.baseDelayMs=500]  backoff base; delay = base * 2^(n-1)
 * @param {number} [opts.maxDelayMs=8000]  backoff ceiling
 * @param {boolean}[opts.jitter=true]      add 0..base random jitter
 * @param {AbortSignal} [opts.signal]      abort stops retrying immediately
 * @param {(ms:number)=>Promise} [opts.sleep] injectable for tests
 * @param {(info:object)=>void} [opts.onRetry] observability hook
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    jitter = true,
    signal = null,
    sleep = defaultSleep,
    onRetry = null,
  } = opts;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error("ABORTED");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // A source-qualified unconfirmed effect must be reconciled by its owner.
      // Classification as a transient or unknown error cannot override it.
      if (err?.retrySafe === false || err?.outcome === 'unknown') throw err;
      const cls = classifyError(err);
      const hasNext = attempt < maxAttempts;
      // Never retry an abort or a permanent error; "unknown" is retried at most
      // once (treated as transient only on the first failure).
      const retryable = cls === "transient" || (cls === "unknown" && attempt === 1);
      if (!retryable || !hasNext) throw err;

      const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = jitter ? raw + Math.floor(Math.random() * baseDelayMs) : raw;
      if (onRetry) onRetry({ attempt, nextAttempt: attempt + 1, class: cls, delayMs: delay, error: String(err.message || err) });
      await sleep(delay);
    }
  }
  throw lastErr;
}

export default { classifyError, isRetryable, withRetry };
