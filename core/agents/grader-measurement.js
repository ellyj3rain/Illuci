/**
 * illuci — Grader-as-measurement (persona-genome Phase A1, DR-170).
 *
 * The MEASUREMENT half of the genome's learning loop, on the ratified
 * measurement/mutation seam: this module COLLECTS the multi-lens signals the
 * napi-gated Rust `grade` (kernel Phase 5) will consume, and emits ONE tagged
 * grader-input record per seat-composition. It never mutates anything — no
 * facet-delta is computed here (mutation is Rust-only, D6 napi-gate), and no
 * I/O happens here (the runner owns the telemetry read/write seam).
 *
 * Lenses (D3 — multi-lens, tagged; "all of the above if we are to learn"):
 *   - consistency  assessCompositionConsistency over composition_resolved
 *                  payloads (stabilityScore / directiveCountDrift / trend).
 *   - tension      computeTensionPairs over the banded preset profile
 *                  (curated | domain | structural, per DR-168).
 *   - provenance   the A76 fingerprint trail: latest composed fingerprint,
 *                  base fingerprint, distinct-fingerprint count across runs.
 *
 * Pure and deterministic: same inputs → same record; no clock, no randomness,
 * no filesystem. Inline (preset-less) seats are skipped by the runner seam in
 * Phase A1 — they carry an A76 identity but no stored profile handle for the
 * tension lens; they join when the genome wiring (Phase A3) lands.
 *
 * @module core/agents/grader-measurement
 */

import { assessCompositionConsistency } from "../governance/assess.js";
import { bandProfile, computeTensionPairs, computeSalience } from "./disposition-identity.js";
import { getPreset } from "./disposition-presets.js";
import { computeBehavioralAttribution } from "./genome-attribution.js";

export const GRADER_INPUT_SCHEMA = "illuci.genome.grader-input/1";

/**
 * Collect the tagged multi-lens grader-input record for one seat.
 *
 * @param {Object} args
 * @param {string} args.seatId - the seat whose composition history is measured
 * @param {string} [args.presetId] - the disposition preset (slug key); used to
 *        resolve the profile for the tension lens when `profile` is not given
 * @param {Array<Object>} args.events - UNWRAPPED composition_resolved payloads
 *        (the `.payload` objects: { engine, edges, disposition }), any order;
 *        the same contract assessCompositionConsistency consumes
 * @param {Object} [args.profile] - raw disposition profile (facets in [0,1]);
 *        overrides the presetId lookup when provided
 * @param {Object} [args.lineage] - [A91]/DR-184 (D2): the run-tree coordinate
 *        ({ runId, parentRunId, depth }) tagged onto the record verbatim for
 *        the lenses
 * @returns {{schema:string, seatId:string, presetId:(string|null),
 *            lenses:{consistency:Object, tension:Object, provenance:Object}}}
 */
export function collectGraderInput({ seatId, presetId = null, events = [], profile = null, outcomes = [], lineage = null } = {}) {
  const seat = String(seatId == null ? "" : seatId).trim();
  const rows = Array.isArray(events) ? events : [];

  // Lens 1 — consistency (tagged verbatim from the existing assessor).
  const consistency = { tag: "consistency", ...assessCompositionConsistency(rows, seat) };

  // Lens 2 — tension (static per profile, banded; empty when no profile resolves).
  const resolved = profile || (presetId ? (getPreset(presetId) || {}).profile : null) || null;
  const banded = resolved ? bandProfile(resolved) : null;
  const tension = {
    tag: "tension",
    pairs: banded ? computeTensionPairs(banded) : [],
  };

  // Lens 2b — salient ([A101]/DR-194): the profile's expressed-pole markers
  // (computeSalience → "C1-Competence↑"). Always emitted for record-completeness
  // (the D3 obligation to carry each lens); UNCONSUMED unless genomeGradingSources
  // selects "salient" — so this is byte-identical to A100 by default. A balanced
  // disposition has salient markers even when it has zero tension pairs; that is
  // exactly the pending-direction seam this lens can (informed-consent only) fill.
  const salientMarkers = banded ? computeSalience(banded, { topN: 6 }) : [];
  const salient = { tag: "salient", markers: salientMarkers };

  // Lens 2c — behavioral ([A102]/DR-195): outcome-grounded attribution over the
  // salient facets, conditioned on the persona's accrued PRIOR outcomes. Unlike
  // salient (which fires on geometry alone), behavioral markers appear ONLY when
  // the disposition's expression has actually earned good outcomes (substantive,
  // gate-passing) across enough runs — and are empty (honest null) otherwise.
  // Always emitted (D3 record-completeness); UNCONSUMED unless gradingSources
  // selects "behavioral" — byte-identical by default.
  const behavioral = computeBehavioralAttribution({ salientMarkers, outcomes: Array.isArray(outcomes) ? outcomes : [] });

  // Lens 3 — provenance (the A76 fingerprint trail for this seat).
  const seatRows = rows.filter((r) => r && r.edges && r.edges.seatId === seat);
  const fingerprints = seatRows
    .map((r) => (r.disposition ? r.disposition.fingerprint : null))
    .filter((f) => typeof f === "string" && f.length > 0);
  const baseFingerprints = seatRows
    .map((r) => (r.disposition ? r.disposition.baseFingerprint : null))
    .filter((f) => typeof f === "string" && f.length > 0);
  const provenance = {
    tag: "provenance",
    fingerprint: fingerprints.length ? fingerprints[fingerprints.length - 1] : null,
    baseFingerprint: baseFingerprints.length ? baseFingerprints[baseFingerprints.length - 1] : null,
    distinctFingerprints: new Set(fingerprints).size,
    runCount: seatRows.length,
  };

  return {
    schema: GRADER_INPUT_SCHEMA,
    seatId: seat,
    presetId: presetId || null,
    lenses: { consistency, tension, salient, behavioral, provenance },
    ...(lineage ? { lineage } : {}),
  };
}

/**
 * [A91]/DR-184 (the D2 fallback partition): the set of runIds connected to
 * THIS run through the parentRunId edges the window itself carries. Pure set
 * algebra over unwrapped composition_resolved payloads — iterates to a
 * fixpoint so multi-level trees resolve regardless of window order. Seeds
 * with the current runId + its immediate parent (the parent edge exists even
 * when the parent composed outside the window).
 *
 * @param {Array<Object>} payloads - unwrapped composition_resolved payloads
 * @param {string|null} runId - the current run's minted id
 * @param {string|null} parentRunId - the current run's parent (spawn lineage)
 * @returns {Set<string>} every window-connected runId in this run's tree
 */
export function collectRunTreeIds(payloads = [], runId = null, parentRunId = null) {
  const ids = new Set();
  if (runId) ids.add(runId);
  if (parentRunId) ids.add(parentRunId);
  if (!ids.size) return ids;
  const rows = Array.isArray(payloads) ? payloads : [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of rows) {
      const e = p && p.edges;
      if (!e || !e.runId || !e.parentRunId) continue;
      if (ids.has(e.parentRunId) && !ids.has(e.runId)) {
        ids.add(e.runId);
        grew = true;
      }
      if (ids.has(e.runId) && !ids.has(e.parentRunId)) {
        ids.add(e.parentRunId);
        grew = true;
      }
    }
  }
  return ids;
}

export default { GRADER_INPUT_SCHEMA, collectGraderInput, collectRunTreeIds };
