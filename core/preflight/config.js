/**
 * illuci — Preflight readiness gate: configuration
 *
 * The preflight gate is a PROACTIVE pre-task assessment (the operator's PCC/PCI
 * frame: per-seat Pre-Combat Checks + a runner Pre-Combat Inspection) that runs
 * BEFORE a topology commits, so dead endpoints and invalid run-config fail fast
 * with a readiness report instead of failing mid-run. It is the proactive
 * complement to the REACTIVE DRL (resilience/), which only learns deadness after
 * real failures accumulate.
 *
 * Two flags, both read at CALL TIME (never module-load), default OFF, exact-
 * string family (1/true/yes/on/enabled) — copying the DRL convention verbatim
 * (resilience/config.js) so coercion matches byte-for-byte:
 *   - ILLUCI_PREFLIGHT_ENABLED  master. The cheap, deterministic CONFIG-VALIDITY
 *                            half (preset / topology / budget) runs when on; with
 *                            it off the gate returns { ready: true } and the
 *                            runner path is byte-identical to today.
 *   - ILLUCI_PREFLIGHT_PROBE    sub-flag. Gates the billable NETWORK half (per-seat
 *                            liveness probe + bounded auto-reseat). Default off so
 *                            the deterministic config-safety can ship enabled
 *                            while the probe/reseat halves stay dark until
 *                            see-and-verify on a real degraded run.
 *
 * Operator-ratified 2026-06-21 (via crucible): BOTH fail-mode (HALT irrecoverable
 * + auto-reseat recoverable + clamp-warn budget), strict-HALT on a bad preset,
 * the ILLUCI_PREFLIGHT_PROBE sub-flag for early config-safety.
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

/** Master flag. Default ON as of [A50]/DR-130 — the cheap, deterministic
 *  config-validity gate (preset/topology/budget) runs before every step-off, so a
 *  malformed run fails fast with a readiness report instead of mid-run. It is
 *  disclosed by the defaults registry (the DR-130 law: no silent default), and the
 *  billable network PROBE half stays OFF (opt-in per run via --preflight probe).
 *  Set ILLUCI_PREFLIGHT_ENABLED=0 to restore the pre-[A50] no-gate path. Read at call
 *  time so a flip takes effect at once. */
export function isPreflightEnabled(env = process.env) {
  return readBool("ILLUCI_PREFLIGHT_ENABLED", true, env);
}

/** Sub-flag for the NETWORK half (liveness probe + auto-reseat, Phase 2-3).
 *  Default OFF so the deterministic config-validity half can ship enabled without
 *  billable probe traffic. Meaningless unless the master is also on. */
export function isPreflightProbeEnabled(env = process.env) {
  return readBool("ILLUCI_PREFLIGHT_PROBE", false, env);
}

/**
 * [A49]/DR-129: the EXPLICIT per-run preflight control. The engine mediates
 * between a human and the work, so the readiness posture must be a legible,
 * optional CHOICE at every level (engine option -> CLI flag -> GUI), not an
 * ambient env var only. One closed, ordered vocabulary — mirroring the autonomy
 * dial:
 *   off    — no preflight; step off immediately (the pre-[A49] default posture).
 *   config — the cheap, deterministic config-validity half (preset/topology/
 *            budget), no network, no cost.
 *   probe  — config PLUS the network liveness probe + bounded auto-reseat (the
 *            "test them, see if they work" cold-start kill; a probe per run).
 *
 * An EXPLICIT options.preflight wins over the env flags (the specific beats the
 * ambient, exactly like the autonomy dial); ABSENT, resolution falls through to
 * the ILLUCI_PREFLIGHT_ENABLED / ILLUCI_PREFLIGHT_PROBE env defaults, so an unset option
 * is byte-identical to today. Invalid values throw (fail-closed, never a silent
 * downgrade to a weaker posture).
 */
export const PREFLIGHT_MODES = Object.freeze(["off", "config", "probe"]);

export class PreflightConfigError extends Error {
  constructor(message) {
    super(`preflight: ${message}`);
    this.name = "PreflightConfigError";
    this.code = "PREFLIGHT_CONFIG_INVALID";
  }
}

/**
 * Resolve the effective preflight posture for a run.
 * @param {{ preflight?: string }} [options]
 * @param {object} [env]
 * @returns {{ enabled: boolean, probe: boolean, mode: string, source: "explicit"|"env" }}
 */
export function resolvePreflightMode(options = {}, env = process.env) {
  const explicit = options?.preflight;
  if (explicit !== undefined && explicit !== null) {
    if (!PREFLIGHT_MODES.includes(explicit)) {
      throw new PreflightConfigError(`mode must be one of ${PREFLIGHT_MODES.join(", ")} (got "${explicit}")`);
    }
    return { enabled: explicit !== "off", probe: explicit === "probe", mode: explicit, source: "explicit" };
  }
  const enabled = isPreflightEnabled(env);
  const probe = enabled && isPreflightProbeEnabled(env);
  return { enabled, probe, mode: enabled ? (probe ? "probe" : "config") : "off", source: "env" };
}

/** Probe + gate timing knobs (consumed by the Phase-2 network half). Liveness is
 *  a 24h "is this model in the plan" TTL; throttle (a 429) is a minutes-scale
 *  condition, so it carries its own short TTL — a category distinction, not one
 *  TTL for both. Per-probe timeout caps a hung endpoint; the gate deadline caps
 *  total wall-clock; reseat attempts are bounded to break a reseat->dead loop. */
export function probeConfig(env = process.env) {
  return {
    probeTimeoutMs: readInt("ILLUCI_PREFLIGHT_PROBE_TIMEOUT_MS", 8000, { min: 1 }, env),
    gateDeadlineMs: readInt("ILLUCI_PREFLIGHT_GATE_DEADLINE_MS", 20000, { min: 1 }, env),
    livenessTtlMs: readInt("ILLUCI_PREFLIGHT_LIVENESS_TTL_MS", 86400000, { min: 1 }, env),
    throttleTtlMs: readInt("ILLUCI_PREFLIGHT_THROTTLE_TTL_MS", 120000, { min: 1 }, env),
    maxReseatAttempts: readInt("ILLUCI_PREFLIGHT_MAX_RESEAT_ATTEMPTS", 3, { min: 1 }, env),
  };
}

export default { isPreflightEnabled, isPreflightProbeEnabled, probeConfig, resolvePreflightMode, PREFLIGHT_MODES, PreflightConfigError };
