/**
 * illuci — genome grade shim (DR-170 Phase B2, [A83]/DR-176).
 *
 * The bridge between the grader-input record (A78, `illuci.genome.grader-input/1`)
 * and the Rust mutation core: JS does the DOMAIN bookkeeping (which facets,
 * which directions — extracted from the tension lens's `Facet↑`/`Facet↓`
 * markers), the kernel does ALL the math (gates, step size, determinism —
 * DR-176 v1 policy), and JS zips the returned Q32.32 deltas back onto facet
 * keys as an appendDelta-ready `{ pulls }` (exact dyadic floats).
 *
 * No-learning is a typed OBSERVATION, not a silent skip ([A100]/DR-193,
 * F-133): no tension facets -> `{ noDelta: "no-graded-facets" }`, ungated or
 * all-zero deltas -> `{ noDelta: "gates-closed" }` (both carry the gate
 * signals for the DR-176 analysis). Only a missing kernel returns bare null —
 * the runner pre-checks and warns for that case. Contract violations
 * (malformed signals) stay LOUD via the kernel's typed errors.
 *
 * Phase C1 ([A84]/DR-177) closes the loop: `applyGradeFromRecord` grades a
 * record AND appends the resulting delta to the persona's ledger — the one
 * call the runtime seam makes per graded seat-composition. The persona's
 * NEXT composition replays the accrued delta (A80): run N's signals shape
 * run N+1's disposition.
 *
 * @module core/agents/genome-grade
 */

import { appendDelta, sealActiveLedger } from "./persona-memory.js";
import { normalizeGradingSources } from "./genome-grading-sources.js";

/**
 * C2 default (DR-178): seal the active ledger into the next immutable base
 * once it accrues this many deltas. Opportunistic — checked at the append
 * seam, no worker process, no clock. 0 disables auto-seal. Disclosed in the
 * defaults registry; per-run via dispatchOpts.genome.sealThreshold.
 */
export const DEFAULT_SEAL_THRESHOLD = 32;

/** Parse "E3-Assertiveness↑" / "N5-Impulsiveness↓" into { facet, direction }. */
function parseFacetMarker(marker) {
  if (typeof marker !== "string" || marker.length < 2) return null;
  const dir = marker.endsWith("↑") ? 1 : marker.endsWith("↓") ? -1 : 0;
  if (dir === 0) return null;
  const facet = marker.slice(0, -1);
  return facet ? { facet, direction: dir } : null;
}

/**
 * Extract the graded facet set from a grader-input record, per the active
 * DIRECTION sources ([A101]/DR-194). Each facet carries its expressed direction
 * AND the lens that surfaced it. Sources are consulted in KNOWN order so the
 * lens tags are deterministic; a facet surfaced by more than one lens is graded
 * ONCE, tagged by the first (highest-priority) lens that named it.
 *
 *  - "tension"  (default): facets named by opposing-salience pairs. A balanced
 *               disposition yields none — the pending-direction state (DR-193).
 *  - "salient"  (opt-in, disclosed): the profile's expressed-pole markers
 *               (computeSalience). Reinforces the identity already expressed —
 *               grade-gated, NOT attribution-grounded (SALIENT_LIMITATION).
 *  - "behavioral" (opt-in, DR-195): outcome-grounded — the same expressed-pole
 *               markers, but present ONLY when the persona's accrued outcomes
 *               earned them (the attribution lens already applied its evidence +
 *               confidence gate; here it is just markers with a capped confidence).
 *
 * Priority on facet overlap: tension > behavioral > salient (the most-grounded
 * lens that named a facet wins its tag, deterministically).
 *
 * @param {object} graderInput  a `illuci.genome.grader-input/1` record
 * @param {string[]} [sources]  normalized grading sources (default ["tension"])
 * @returns {Array<{facet:string, direction:1|-1, lens:string}>}
 */
export function extractGradedFacets(graderInput, sources = normalizeGradingSources(null)) {
  const active = normalizeGradingSources(sources);
  const byFacet = new Map();

  const add = (marker, lens) => {
    const parsed = parseFacetMarker(marker);
    if (parsed && !byFacet.has(parsed.facet)) byFacet.set(parsed.facet, { ...parsed, lens });
  };

  if (active.includes("tension")) {
    const pairs = graderInput?.lenses?.tension?.pairs;
    if (Array.isArray(pairs)) {
      for (const pair of pairs) {
        if (!pair || !Array.isArray(pair.facets)) continue;
        for (const marker of pair.facets) add(marker, "tension");
      }
    }
  }
  if (active.includes("behavioral")) {
    // The attribution lens already gated on evidence + quality; a below-floor /
    // insufficient-evidence run carries EMPTY markers (the honest null).
    const b = graderInput?.lenses?.behavioral;
    if (b && Array.isArray(b.markers)) {
      for (const marker of b.markers) add(marker, "behavioral");
    }
  }
  if (active.includes("salient")) {
    const markers = graderInput?.lenses?.salient?.markers;
    if (Array.isArray(markers)) {
      for (const marker of markers) add(marker, "salient");
    }
  }
  return [...byFacet.values()];
}

/**
 * Derive an appendDelta-ready delta from a grader-input record via the Rust
 * mutation core (D6: the kernel is the ONLY delta producer).
 *
 * @param {object} kernel  a LOADED persona-kernel (loadPersonaKernel(), available:true)
 * @param {object} graderInput  the `illuci.genome.grader-input/1` record
 * @returns {{pulls: Object<string, number>, gradedFacets: number, stabilityScore: number, runCount: number}|null}
 *          null when there is nothing to learn from this run (fail-quiet).
 */
export function deriveGradeDelta(kernel, graderInput, sources = normalizeGradingSources(null)) {
  if (!kernel || kernel.available !== true) return null;
  const active = normalizeGradingSources(sources);

  const consistency = graderInput?.lenses?.consistency || {};
  const stabilityScore = typeof consistency.stabilityScore === "number" ? consistency.stabilityScore : 0;
  const runCount = typeof consistency.runCount === "number" ? consistency.runCount : 0;

  // [A100]/DR-193 (F-133): a run that yields no delta is a typed OBSERVATION,
  // never a silent skip. Direction currently derives from the tension lens
  // alone, so a BALANCED disposition (zero tension pairs — e.g. an arbiter
  // preset with no opposing saliences) is structurally mute: it composes, it
  // is measured, and it can never learn. Pre-A100 this returned bare null and
  // nothing recorded it — the dogfood arbiter sat at activeLedgerLen 0 for
  // nine runs, invisibly. The typed reasons feed the DR-176 re-weighting
  // analysis (structurally-mute vs gates-closed rates are its evidence).
  // Whether balanced dispositions SHOULD learn (folding direction from the
  // other D3 lenses) is the operator's ratification fork recorded in DR-193 —
  // this seam only stops being silent about it.
  const entries = extractGradedFacets(graderInput, active);
  if (entries.length === 0) {
    // Under tension-only (default) this is the pending-direction state (DR-193):
    // a balanced disposition has no opposing saliences to grade. Selecting the
    // "salient" source fills it (informed-consent only, SALIENT_LIMITATION).
    return { noDelta: "no-graded-facets", stabilityScore, runCount, gradedFacets: 0, sources: active };
  }

  const blob = kernel.gradeSignals(stabilityScore, runCount, entries.map((e) => e.direction));
  const deltas = kernel.decodeDeltas(blob);

  const pulls = {};
  const lensSet = new Set();
  let nonZero = 0;
  for (let i = 0; i < entries.length; i++) {
    if (deltas[i] !== 0) {
      pulls[entries[i].facet] = deltas[i];
      lensSet.add(entries[i].lens);
      nonZero++;
    }
  }
  if (nonZero === 0) {
    return { noDelta: "gates-closed", stabilityScore, runCount, gradedFacets: 0, sources: active };
  }

  // [A101]/DR-194: every delta carries the LENSES that directed it (Rosa's "tag
  // every delta") — a default run reads ["tension"]; a salient-armed balanced
  // seat reads ["salient"] (or a mix). Order-stable (KNOWN order).
  const lenses = ["tension", "behavioral", "salient"].filter((l) => lensSet.has(l));
  // [A102]/DR-195: when behavioral directed any facet, carry its capped
  // confidence + method onto the delta for the DR-176 re-weighting analysis
  // (the step stays dyadic 1/32; confidence GATED, it does not scale).
  const out = { pulls, gradedFacets: nonZero, stabilityScore, runCount, lenses };
  if (lensSet.has("behavioral")) {
    const b = graderInput?.lenses?.behavioral;
    out.attribution = { method: b?.method ?? "outcome-conditioned/1", confidence: b?.confidence ?? null, quality: b?.quality ?? null };
  }
  return out;
}

/**
 * The C1 learning step (DR-177): grade a grader-input record and, when it
 * yields a delta, APPEND it to the persona's ledger (AM-23, fail-closed via
 * A79's validateDelta seam). Returns what happened, or null when there was
 * nothing to learn (no kernel / no tension facets / gates closed).
 *
 * A85/DR-178 (Phase C2): after a successful append, the OPPORTUNISTIC SEAL
 * trigger fires when the active ledger has accrued `sealThreshold` deltas —
 * base/<n+1> = replay(base/<n>, segment) (A79's D4 pure accumulator), and the
 * next composition reads the folded base with an empty active ledger.
 *
 * @param {Object} args
 * @param {object} args.kernel       a loadPersonaKernel() result
 * @param {object} args.graderInput  the `illuci.genome.grader-input/1` record
 * @param {string} args.projectDir   the genome home (the A80 explicit control's projectDir)
 * @param {string} args.slug         the persona agentSlug
 * @param {object} [args.provenance] extra ledger fields (runId, seatId, fingerprint, ...)
 * @param {number} [args.sealThreshold] auto-seal at this ledger length (0 disables;
 *        default DEFAULT_SEAL_THRESHOLD — the disclosed control)
 * @param {string[]} [args.gradingSources] direction sources ([A101]/DR-194;
 *        default ["tension"] — byte-identical). The delta's `lenses` are threaded
 *        onto the ledger record so provenance names which lens directed each run.
 * @returns {{pulls:Object, gradedFacets:number, stabilityScore:number, runCount:number,
 *            lenses:string[], activeLedgerLen:number, baseRef:number,
 *            sealed:({baseRef:number, deltasSealed:number}|null)}|null}
 */
export function applyGradeFromRecord({
  kernel, graderInput, projectDir, slug, provenance = {}, sealThreshold = DEFAULT_SEAL_THRESHOLD,
  gradingSources = normalizeGradingSources(null),
} = {}) {
  const graded = deriveGradeDelta(kernel, graderInput, gradingSources);
  if (!graded) return null;
  // [A100]/DR-193: the typed no-delta observation propagates to the caller —
  // the runner records it as a genome_no_delta telemetry event. No append.
  if (graded.noDelta) return graded;
  // [A101]/DR-194 + [A102]/DR-195: the directing lenses (and, when behavioral
  // directed, its capped confidence + method) ride the ledger record as
  // provenance — extra top-level fields validateDelta tolerates and replay ignores.
  const appended = appendDelta(projectDir, slug, {
    ...provenance,
    lenses: graded.lenses,
    ...(graded.attribution ? { attribution: graded.attribution } : {}),
    pulls: graded.pulls,
  });

  let sealed = null;
  if (Number.isInteger(sealThreshold) && sealThreshold > 0 && appended.activeLedgerLen >= sealThreshold) {
    const seal = sealActiveLedger(projectDir, slug);
    if (seal.sealed) sealed = { baseRef: seal.baseRef, deltasSealed: seal.deltasSealed };
  }

  return {
    ...graded,
    activeLedgerLen: sealed ? 0 : appended.activeLedgerLen,
    baseRef: sealed ? sealed.baseRef : appended.baseRef,
    sealed,
  };
}

export default { extractGradedFacets, deriveGradeDelta, applyGradeFromRecord, DEFAULT_SEAL_THRESHOLD };
