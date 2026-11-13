/**
 * illuci — Dynamic-Resilience Layer (DRL): configuration
 *
 * Every ILLUCI_DRL_* knob is read at CALL TIME (never module-load time), so a test
 * or an operator can flip an env var and the next read observes it without a
 * process restart. The master flag ILLUCI_DRL_ENABLED defaults ON: setting it off leaves the
 * whole layer is inert and dispatch is byte-identical to today's behavior (no
 * breaker veto, no p95 timeout extension, no fast-fail). The legislature ratified
 * this explicit runtime control; operators may disable the learned circuit and latency behavior.
 *
 * Boolean parsing mirrors the dispatch convention (1/true/yes/on/enabled). A
 * numeric knob that is unset, blank, or non-finite falls back to its documented
 * default; a value below a sane floor clamps UP to the default rather than
 * silently weakening the layer (a 0-failure threshold would trip instantly).
 */

function readBool(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(n)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(n)) return false;
  return fallback;
}

function readInt(name, fallback, { min = 1 } = {}, env = process.env) {
  const raw = Number(env[name]);
  if (!Number.isFinite(raw)) return fallback;
  const floored = Math.trunc(raw);
  return floored < min ? fallback : floored;
}

function readFloat(name, fallback, { min = 0, max = Infinity } = {}, env = process.env) {
  const raw = Number(env[name]);
  if (!Number.isFinite(raw)) return fallback;
  if (raw < min || raw > max) return fallback;
  return raw;
}

/** Master flag. Default ON as of [A48]/DR-128 — the operator's ratified
 *  ACTIVATION (the dark-by-default posture was always "activation is an operator
 *  decision, not a ship event"; this is that decision). With DRL live, observed
 *  terminal failures demote a lane through the breaker veto in isAvailable, and
 *  reliability accrues per (model, seat) — availability stops being a static
 *  presence-assertion and becomes learned health. Set ILLUCI_DRL_ENABLED=0 to
 *  restore the pre-[A48] inert layer (byte-identical dispatch). Read at call time
 *  so a flip takes effect at once. */
export function isDrlEnabled(env = process.env) {
  return readBool("ILLUCI_DRL_ENABLED", true, env);
}

/** Circuit-breaker thresholds. closed -> open after N consecutive terminal
 *  failures; half-open after a cooldown; closed again after M half-open
 *  successes; at most one in-flight probe while half-open. */
export function breakerConfig(env = process.env) {
  return {
    failureThreshold: readInt("ILLUCI_DRL_BREAKER_FAILURE_THRESHOLD", 5, { min: 1 }, env),
    cooldownMs: readInt("ILLUCI_DRL_BREAKER_COOLDOWN_MS", 30000, { min: 1 }, env),
    successThreshold: readInt("ILLUCI_DRL_BREAKER_SUCCESS_THRESHOLD", 2, { min: 1 }, env),
    halfOpenMax: 1, // the half-open probe budget is exactly one (ratified, not a knob)
  };
}

/** Per-canonical latency ring size — how many recent samples feed getP95. */
export function latencyRingSize(env = process.env) {
  return readInt("ILLUCI_DRL_LATENCY_RING_SIZE", 100, { min: 2 }, env);
}

/** EWMA stall-watcher config: smoothing alpha (0..1) and the stall ceiling. A
 *  per-canonical override (ILLUCI_DRL_STALL_THRESHOLD_<CANONICAL>) beats the global
 *  default; the caller passes the canonical key. */
export function stallConfig(canonicalKey = null, env = process.env) {
  const alpha = readFloat("ILLUCI_DRL_STALL_EWMA_ALPHA", 0.2, { min: 0, max: 1 }, env);
  let thresholdMs = readInt("ILLUCI_DRL_STALL_THRESHOLD_MS", 5000, { min: 1 }, env);
  if (canonicalKey) {
    // Env var names are conservative-char only; canonical ids use [a-z0-9.-].
    // Map to an uppercase, underscore-safe suffix so claude-fable -> CLAUDE_FABLE
    // and gemini-3.1-pro -> GEMINI_3_1_PRO.
    const suffix = String(canonicalKey).toUpperCase().replace(/[^A-Z0-9]/g, "_");
    thresholdMs = readInt(`ILLUCI_DRL_STALL_THRESHOLD_${suffix}`, thresholdMs, { min: 1 }, env);
  }
  return { alpha, thresholdMs };
}

export default { isDrlEnabled, breakerConfig, latencyRingSize, stallConfig };
