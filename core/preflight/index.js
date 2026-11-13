/**
 * illuci/core/preflight — the PCI readiness gate.
 *
 * preflightLineup(topologyId, lineup, options) runs BEFORE a topology commits
 * (runner.js, right after the lineup resolves + normalizes, strictly before the
 * first side effect: logDecision / setActiveSession / emitTopologyStart). It
 * aggregates each seat's readiness into a report and decides step-off: ready
 * (proceed), reseated (proceed on a healed lineup), or HALT (the runner throws
 * PreflightError before anything is registered or emitted — a clean abort).
 *
 * PHASE 1 (this build): the CONFIG-VALIDITY half — deterministic, no network,
 * gated by ILLUCI_PREFLIGHT_ENABLED. Validates dispositions (presets), topology
 * existence, and budget shape. Strict-HALT on an invalid preset (operator-
 * ratified: a wrong disposition silently swapped to default would distort a
 * council). This is the half that would have caught the conformist/perfectionist
 * failure BEFORE step-off instead of nulling seats mid-run.
 *
 * PHASE 2-3 (ILLUCI_PREFLIGHT_PROBE, not yet built): the NETWORK half — per-seat
 * liveness/throttle probe + bounded, re-probed, cardinality-re-validated reseat.
 *
 * Behavior-identical-off: master flag off -> { ready: true } with no `lineup`,
 * no validation, no side effect (the runner skips its authoritative-lineup
 * reassignment when `lineup` is absent). Fail-closed: any internal throw ->
 * ready:false, never a silent swallow that proceeds.
 */
import { probeConfig, resolvePreflightMode } from "./config.js";
import { validateSeatDispositions } from "../composition/seat-disposition-config.js";
import { probeModel } from "../bridges/model-discovery.js";
import { getEntry, isSuspended } from "../bridges/model-registry.js";
import { resolveRole } from "../matrix/capability-matrix.js";
import { getTopology, validateLineup } from "../topologies/index.js";

/** Thrown by the runner when preflight HALTs. Carries the full readiness report. */
export class PreflightError extends Error {
  constructor(report) {
    const blocking = report?.summary?.blocking ?? 0;
    super(`Preflight HALT for ${report?.topologyId}: ${blocking} blocking readiness failure(s)`);
    this.name = "PreflightError";
    this.report = report;
  }
}

/** Validate each seat's disposition config against the live catalogs. Unknown
 *  preset/role/skill ids are BLOCKING readiness failures (strict-HALT): silently
 *  swapping to defaults would distort a council before the first model call. */
function validatePresets(seatDispositions) {
  return validateSeatDispositions(seatDispositions);
}

/** PCC liveness — probe the SEATED lineup only, in parallel, each bounded by the
 *  per-probe timeout (the network half, behind ILLUCI_PREFLIGHT_PROBE). Maps each
 *  seated model id -> its registry entry -> a probeModel candidate. A dead /
 *  missing / throttled seat is BLOCKING (Phase 2 HALTs; Phase 3 will reseat); a
 *  transient `unknown` is non-blocking (a blip never wrongly drops a model);
 *  ollama-local seats are tag-authoritative (no remote outage surface) so they
 *  skip the billable probe. */
async function probeSeats(lineup) {
  const { probeTimeoutMs } = probeConfig();
  const pairs = [];
  for (const [seatId, models] of Object.entries(lineup || {})) {
    for (const m of Array.isArray(models) ? models : [models]) pairs.push({ seatId, model: m });
  }
  return Promise.all(pairs.map(async ({ seatId, model }) => {
    const entry = getEntry(model);
    if (!entry) return { seatId, model, status: "missing", live: false, blocking: true, detail: "no registry entry" };
    if (isSuspended(model)) return { seatId, model, status: "suspended", live: false, blocking: true, detail: "existing model or route hold" };
    if (entry.provider === "ollama-local") return { seatId, model, status: "live", live: true, blocking: false, detail: "ollama-local (tag-authoritative)" };
    let probe;
    try {
      probe = await probeModel({ id: entry.id, bridge: entry.bridge, model: entry.model || entry.id }, { timeoutMs: probeTimeoutMs });
    } catch (err) {
      probe = { status: "unknown", detail: String(err?.message || err) };
    }
    const s = probe.status;
    const blocking = ["unavailable", "missing", "throttled", "suspended", "auth-or-access-denied", "invalid-request"].includes(s);
    return { seatId, model, status: s === "available" ? "live" : s, live: s === "available", blocking, detail: probe.detail || null };
  }));
}

/** Phase 3 — bounded auto-reseat. For each dead/throttled/missing seat, drop the
 *  dead model and re-derive the seat from its roleHint, RE-PROBING each candidate
 *  (isAvailable lies for a credentialed-but-dead seat, so a freshly-resolved
 *  candidate is not trusted until its own probe says live), excluding the dead
 *  model + already-seated + already-failed candidates, and bounding attempts (a
 *  reseat -> dead -> reseat loop is capped per-seat and gate-wide). Returns
 *  { ok, lineup, reseatLog }, or { ok:false, reason, fleetOutage } when a seat has
 *  no roleHint (irrecoverable) or no live candidate (exhausted). The caller
 *  re-validates cardinality. A multi-model seat keeps its surviving models and
 *  only the dead one is swapped. */
export async function reseatDeadSeats(topologyId, lineup, deadSeats, options = {}) {
  const { maxReseatAttempts, probeTimeoutMs } = probeConfig();
  const topology = getTopology(topologyId);
  const seatDefs = Object.fromEntries((topology.seats || []).map((s) => [s.id, s]));
  const probeOne = options._probeOne || (async (cand) => {
    const e = getEntry(cand);
    if (!e) return { status: "missing" };
    return probeModel({ id: e.id, bridge: e.bridge, model: e.model || e.id }, { timeoutMs: probeTimeoutMs });
  });

  const newLineup = { ...lineup };
  const assigned = new Set(Object.values(lineup).flatMap((v) => (Array.isArray(v) ? v : [v])));
  const exclude = new Set();
  const reseatLog = [];
  const gateCap = (topology.seats?.length || 1) * maxReseatAttempts + 2;
  let totalAttempts = 0;

  for (const dead of deadSeats) {
    const seatDef = seatDefs[dead.seatId];
    if (!seatDef || !seatDef.roleHint) {
      return { ok: false, reason: `seat "${dead.seatId}" has no roleHint — no reseat candidate`, fleetOutage: false };
    }
    exclude.add(dead.model);
    assigned.delete(dead.model);
    let healed = null;
    let attempts = 0;
    while (attempts < maxReseatAttempts && totalAttempts < gateCap) {
      attempts++; totalAttempts++;
      const pool = resolveRole(seatDef.roleHint).map((c) => c.model).filter((m) => !exclude.has(m) && !assigned.has(m));
      if (pool.length === 0) break;
      const cand = pool[0];
      let probe;
      try { probe = await probeOne(cand); } catch { probe = { status: "unknown" }; }
      if (probe.status === "available") { healed = cand; break; }
      exclude.add(cand); // a dead/throttled candidate — never retry it (fresh probe wins over isAvailable)
    }
    if (!healed) {
      return { ok: false, reason: `seat "${dead.seatId}": no live reseat candidate after ${attempts} attempt(s)`, fleetOutage: true };
    }
    const cur = Array.isArray(newLineup[dead.seatId]) ? [...newLineup[dead.seatId]] : [newLineup[dead.seatId]];
    const idx = cur.indexOf(dead.model);
    if (idx >= 0) cur[idx] = healed; else cur.push(healed);
    newLineup[dead.seatId] = cur.length === 1 ? cur[0] : cur;
    assigned.add(healed);
    reseatLog.push({ seatId: dead.seatId, from: dead.model, to: healed });
  }
  return { ok: true, lineup: newLineup, reseatLog };
}

/** Common readiness-report shape, so every return point is identical. */
function finalize({ topologyId, checkedAt, presetErrors, bindingErrors, warnings, ready, seats, lineup, reseated, reseatLog, liveBlocking, blocking, fleetOutage, reseatError, cardinalityError, mode }) {
  const log = reseatLog || [];
  return {
    ready,
    topologyId,
    checkedAt,
    flag: "ILLUCI_PREFLIGHT_ENABLED",
    mode: mode?.mode ?? null,          // [A49] the resolved posture (off|config|probe) + where it came from
    modeSource: mode?.source ?? null,
    probeArmed: !!mode?.probe,
    summary: { seats: Object.keys(lineup || {}).length, blocking, warnings: (warnings || []).length, liveBlocking: liveBlocking || 0, autoReseated: log.length, reseatAttempts: log.length },
    presetErrors: presetErrors || [],
    bindingErrors: bindingErrors || [],
    warnings: warnings || [],
    seats: seats || [],
    ...(fleetOutage ? { fleetOutage } : {}),
    ...(reseatError ? { reseatError } : {}),
    ...(cardinalityError ? { cardinalityError } : {}),
    reseatLog: log,
    lineup: { ...(lineup || {}) },
    reseated: !!reseated,
  };
}

/**
 * The PCI gate. Returns a readiness report; ready:false => the runner HALTs.
 * Flag-off => { ready: true } (no `lineup`, byte-identical). Fail-closed on throw.
 *
 * @param {string} topologyId
 * @param {Record<string, string|string[]>} lineup — the normalized, post-autoFill lineup
 * @param {object} [options] — the runTopology options (seatDispositions, tokenBudget, ...)
 * @returns {Promise<object>} the readiness report
 */
export async function preflightLineup(topologyId, lineup, options = {}) {
  // [A49]/DR-129: resolve the explicit-or-ambient posture first. An invalid
  // explicit mode fails closed (never a silent downgrade); an absent option
  // falls through to the env defaults (byte-identical to pre-[A49]).
  let mode;
  try {
    mode = resolvePreflightMode(options);
  } catch (err) {
    return { ready: false, topologyId, error: String(err?.message || err), summary: { blocking: 1 }, failClosed: true };
  }
  if (!mode.enabled) return { ready: true };

  try {
    const checkedAt = Date.now();

    // ── Config-validity (Phase 1, deterministic). Irrecoverable → HALT, no reseat. ──
    const presetErrors = validatePresets(options.seatDispositions);
    const bindingErrors = []; // reserved for Phase-1b (persona/anchor/boundary, org-scoped)

    const warnings = [];
    const tb = options.tokenBudget;
    if (tb !== undefined && tb !== null && !(Number.isFinite(Number(tb)) && Number(tb) > 0)) {
      warnings.push({ kind: "budget", detail: `tokenBudget is not a positive number (${tb}); clamping to unbounded`, remedy: "pass a positive token budget or omit it" });
    }

    const base = { topologyId, checkedAt, presetErrors, bindingErrors, warnings, mode };
    const configBlocking = presetErrors.length + bindingErrors.length;

    // A config failure (e.g. a wrong preset) is irrecoverable — it can't be reseated → HALT, skip the probe.
    if (configBlocking > 0) {
      return finalize({ ...base, ready: false, seats: [], lineup, reseated: false, reseatLog: [], liveBlocking: 0, blocking: configBlocking });
    }

    // ── Liveness + bounded reseat (Phase 2-3, the "probe" mode) ──
    if (!mode.probe) {
      return finalize({ ...base, ready: true, seats: [], lineup, reseated: false, reseatLog: [], liveBlocking: 0, blocking: 0 });
    }
    const seats = options._probeSeats ? await options._probeSeats(lineup) : await probeSeats(lineup);
    const dead = seats.filter((s) => s.blocking);
    if (dead.length === 0) {
      return finalize({ ...base, ready: true, seats, lineup, reseated: false, reseatLog: [], liveBlocking: 0, blocking: 0 });
    }

    // Phase 3 (ratified BOTH fail-mode): heal recoverable dead seats instead of HALTing.
    const reseatFn = options._reseatDeadSeats || reseatDeadSeats;
    const r = await reseatFn(topologyId, lineup, dead, options);
    if (!r.ok) {
      // Irrecoverable: a dead seat with no roleHint, or no live candidate (fleet outage / exhausted).
      return finalize({ ...base, ready: false, seats, lineup, reseated: false, reseatLog: [], liveBlocking: dead.length, blocking: dead.length, fleetOutage: r.fleetOutage ?? true, reseatError: r.reason });
    }
    // (iii) re-validate cardinality after reseat — a multi-model seat must still meet its min.
    const v = validateLineup(topologyId, r.lineup);
    if (!v.valid) {
      return finalize({ ...base, ready: false, seats, lineup: r.lineup, reseated: true, reseatLog: r.reseatLog, liveBlocking: dead.length, blocking: dead.length, cardinalityError: v.errors });
    }
    return finalize({ ...base, ready: true, seats, lineup: r.lineup, reseated: true, reseatLog: r.reseatLog, liveBlocking: 0, blocking: 0 });
  } catch (err) {
    // Fail-closed: a bug in the gate denies step-off, never silently proceeds.
    return { ready: false, topologyId, error: String(err?.message || err), summary: { blocking: 1 }, failClosed: true };
  }
}

export default { preflightLineup, PreflightError };
