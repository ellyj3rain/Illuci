/**
 * illuci — genome grade shim gate ([A83]/DR-176, Phase B2).
 *
 * Hermetic tier (always runs): tension-marker extraction + the fail-quiet
 * null paths. Addon tier (skips until `npm run kernel:napi:build`): the FULL
 * B2 chain over real machinery — a real preset -> the A78 collector's
 * grader-input record -> the Rust grade -> an appendDelta-ready delta that
 * A79's validateDelta ACCEPTS. Phase C only has to wire what is proven here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractGradedFacets, deriveGradeDelta, applyGradeFromRecord } from "./genome-grade.js";
import { loadPersonaKernel } from "./persona-kernel.js";
import { collectGraderInput } from "./grader-measurement.js";
import { validateDelta, loadIdentity, readActiveLedger, replay } from "./persona-memory.js";
import { getPreset } from "./disposition-presets.js";
import { composeBehavioralDisposition } from "../composition/disposition-resolver.js";

// ── hermetic ────────────────────────────────────────────────────────────────

test("extractGradedFacets: parses ↑/↓ markers, dedupes, tags each facet by lens (A101/DR-194)", () => {
  const record = {
    lenses: {
      tension: {
        pairs: [
          { kind: "curated", facets: ["E3-Assertiveness↑", "A4-Compliance↑"] },
          { kind: "domain", facets: ["E3-Assertiveness↑", "N5-Impulsiveness↓"] }, // E3 repeats
          { kind: "structural", facets: ["not-a-marker", ""] }, // no direction arrows
        ],
      },
      salient: { markers: ["C1-Competence↑", "E3-Assertiveness↑"] }, // E3 already tension-tagged
    },
  };
  // Default (tension-only): each facet now carries lens:"tension".
  assert.deepEqual(extractGradedFacets(record), [
    { facet: "E3-Assertiveness", direction: 1, lens: "tension" },
    { facet: "A4-Compliance", direction: 1, lens: "tension" },
    { facet: "N5-Impulsiveness", direction: -1, lens: "tension" },
  ]);
  // +salient: C1 joins tagged "salient"; E3 stays "tension" (first lens wins, deterministic).
  assert.deepEqual(extractGradedFacets(record, ["tension", "salient"]), [
    { facet: "E3-Assertiveness", direction: 1, lens: "tension" },
    { facet: "A4-Compliance", direction: 1, lens: "tension" },
    { facet: "N5-Impulsiveness", direction: -1, lens: "tension" },
    { facet: "C1-Competence", direction: 1, lens: "salient" },
  ]);
  // salient-only: just the salient markers.
  assert.deepEqual(extractGradedFacets(record, ["salient"]), [
    { facet: "C1-Competence", direction: 1, lens: "salient" },
    { facet: "E3-Assertiveness", direction: 1, lens: "salient" },
  ]);
  assert.deepEqual(extractGradedFacets({}), []);
  assert.deepEqual(extractGradedFacets(null), []);
});

test("A101/DR-194: a BALANCED disposition is pending-direction under tension-only, learnable under salient", () => {
  // zero tension pairs, but salient markers present — the F-133/DR-193 seam.
  const balanced = { lenses: { tension: { pairs: [] }, salient: { markers: ["C2-Order↑", "C3-Dutifulness↑"] } } };
  assert.deepEqual(extractGradedFacets(balanced, ["tension"]), [], "tension-only: nothing to grade (terminal-by-default)");
  const sal = extractGradedFacets(balanced, ["tension", "salient"]);
  assert.equal(sal.length, 2, "salient-armed: the expressed poles become graded facets");
  assert.ok(sal.every((e) => e.lens === "salient" && e.direction === 1), "reinforcement is toward the expressed pole");
});

test("deriveGradeDelta: bare null only for a missing kernel; no tension facets is a TYPED observation (A100/DR-193)", () => {
  assert.equal(deriveGradeDelta(null, {}), null);
  assert.equal(deriveGradeDelta({ available: false }, {}), null);
  const kernelStub = { available: true, gradeSignals: () => { throw new Error("must not be called"); }, decodeDeltas: () => [] };
  // Pre-A100 this was a silent null — the structurally-mute-disposition gap
  // (F-133: a balanced arbiter preset yields zero tension pairs and could
  // never learn, invisibly). Now it names itself, without touching the kernel.
  const mute = deriveGradeDelta(kernelStub, { lenses: { tension: { pairs: [] }, consistency: { stabilityScore: 0.9, runCount: 5 } } });
  // [A101]/DR-194: the no-delta observation now also names the active sources.
  assert.deepEqual(mute, { noDelta: "no-graded-facets", stabilityScore: 0.9, runCount: 5, gradedFacets: 0, sources: ["tension"] });
});

// ── addon (the full B2 chain) ───────────────────────────────────────────────

const kernel = loadPersonaKernel({ force: true });
const skip = kernel.available ? false : "addon not built (npm run kernel:napi:build)";

// A synthetic composition_resolved payload stream for a stable seat (same
// fingerprint every run) — the shape assessCompositionConsistency consumes.
const stableEvents = (n) =>
  Array.from({ length: n }, () => ({
    engine: "dimensional",
    edges: { seatId: "builder", presetId: "O5C6E6A3N0", role: "implementer", skills: [] },
    disposition: {
      fingerprint: "sha256v1:aaaaaaaaaaaaaaaa",
      baseFingerprint: "sha256v1:48654656600997a2",
      slug: "O5C6E6A3N0",
      activeFacets: 12, activeDarkTriad: 1, activePid5: 0, activeValues: 3,
      enneagramCore: 3, directiveCount: 1,
    },
  }));

test("addon: the full B2 chain — collector record -> Rust grade -> validateDelta-clean pulls", { skip }, () => {
  // O5C6E6A3N0 carries known tensions (A75), so the record has graded facets.
  const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(3) });
  assert.ok(record.lenses.tension.pairs.length >= 1, "the preset's tension lens fires");
  assert.equal(record.lenses.consistency.stabilityScore >= 0.75, true, "a stable seat grades");

  const graded = deriveGradeDelta(kernel, record);
  assert.ok(graded, "gated signals produce a delta");
  assert.ok(graded.gradedFacets >= 1);
  assert.deepEqual(graded.lenses, ["tension"], "A101/DR-194: a default delta is tension-directed");
  for (const [facet, shift] of Object.entries(graded.pulls)) {
    assert.ok(Math.abs(shift) === 0.03125, `${facet} moves exactly one dyadic step`);
  }
  // the delta is ledger-ready: A79's fail-closed seam accepts it verbatim
  assert.deepEqual(validateDelta({ pulls: graded.pulls, runId: "r-1" }), { ok: true });
});

test("addon A101/DR-194: a BALANCED preset learns ONLY when salient is armed — the delta is lens-tagged", { skip }, () => {
  // O3C6E3A5N1 is the F-133 balanced arbiter: zero tension pairs, stable seat.
  const balancedEvents = (n) =>
    Array.from({ length: n }, () => ({
      engine: "dimensional",
      edges: { seatId: "arbiter", presetId: "O3C6E3A5N1", role: "arbiter", skills: [] },
      disposition: { fingerprint: "sha256v1:bbbbbbbbbbbbbbbb", baseFingerprint: "sha256v1:bbbbbbbbbbbbbbbb", slug: "O3C6E3A5N1", activeFacets: 8, activeDarkTriad: 0, activePid5: 0, activeValues: 2, enneagramCore: 1, directiveCount: 1 },
    }));
  const record = collectGraderInput({ seatId: "arbiter", presetId: "O3C6E3A5N1", events: balancedEvents(3) });
  assert.equal(record.lenses.tension.pairs.length, 0, "the balanced arbiter has zero tension pairs");
  assert.ok(record.lenses.salient.markers.length >= 1, "but it has salient markers");
  assert.ok(record.lenses.consistency.stabilityScore >= 0.75, "and it is stable enough to grade");

  // tension-only (default): pending-direction — a typed no-delta, nothing learned.
  const def = deriveGradeDelta(kernel, record);
  assert.equal(def.noDelta, "no-graded-facets", "terminal-by-default: the balanced seat derives nothing");

  // salient-armed: it learns, and every pull is lens-tagged "salient".
  const sal = deriveGradeDelta(kernel, record, ["tension", "salient"]);
  assert.ok(sal.pulls && sal.gradedFacets >= 1, "salient-armed: the balanced seat now learns");
  assert.deepEqual(sal.lenses, ["salient"], "the delta names its director");
  for (const shift of Object.values(sal.pulls)) {
    assert.ok(Math.abs(shift) === 0.03125, "still exactly one dyadic step");
  }
  assert.deepEqual(validateDelta({ pulls: sal.pulls, runId: "r-sal", lenses: sal.lenses }), { ok: true }, "lens-tagged delta is ledger-ready");
});

test("addon: an unstable or single-run seat learns nothing — as a TYPED gates-closed observation (A100/DR-193)", { skip }, () => {
  // one run -> runCount gate closed
  const single = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(1) });
  const singleGraded = deriveGradeDelta(kernel, single);
  assert.equal(singleGraded.noDelta, "gates-closed");
  assert.equal(singleGraded.gradedFacets, 0);
  assert.equal(singleGraded.runCount, 1, "the observation carries the gate signals for the DR-176 analysis");
  // churn: distinct fingerprint every run -> stability below the gate
  const churnEvents = stableEvents(4).map((e, i) => ({
    ...e,
    disposition: { ...e.disposition, fingerprint: `sha256v1:${String(i).repeat(16).slice(0, 16)}`, directiveCount: i },
  }));
  const churn = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: churnEvents });
  if (churn.lenses.consistency.stabilityScore < 0.75) {
    assert.equal(deriveGradeDelta(kernel, churn).noDelta, "gates-closed", "churning composition must not learn");
  }
});

// ── addon: Phase C1 — the loop closes (A84/DR-177) ──────────────────────────

test("addon C1: applyGradeFromRecord grades AND appends — the ledger carries exact dyadic pulls", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-c1-"));
  try {
    const identity = loadIdentity(dir, "learner-a", { preset: getPreset("O5C6E6A3N0") });
    const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(3) });

    const learned = applyGradeFromRecord({
      kernel, graderInput: record, projectDir: dir, slug: "learner-a",
      provenance: { runId: "run-1", seatId: "builder" },
    });
    assert.ok(learned, "gated signals learn");
    assert.equal(learned.activeLedgerLen, 1);
    assert.equal(learned.baseRef, 0);

    const ledger = readActiveLedger(dir, "learner-a");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].runId, "run-1", "provenance rides the ledger");
    for (const shift of Object.values(ledger[0].pulls)) assert.equal(Math.abs(shift), 0.03125);

    // the fold sees the learning: each graded facet moved by exactly its pull
    const live = replay(identity, ledger);
    for (const [facet, shift] of Object.entries(ledger[0].pulls)) {
      const before = identity.facets[facet] ?? 0.5;
      assert.equal(live.facets[facet], Math.max(0, Math.min(1, before + shift)), facet);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addon C1: THE LOOP — run N learns, run N+1's composition replays it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-c1-"));
  try {
    const seat = () => composeBehavioralDisposition({
      modelId: "test-model",
      seatId: "implementer",
      agentId: "learner-b",
      seatDef: {},
      dispatchOpts: {
        seatDispositions: { implementer: { presetId: "O5C6E6A3N0", role: "implementer" } },
        genome: { projectDir: dir },
      },
    });

    const runN = await seat(); // genesis + fresh compose (ledger empty)
    assert.deepEqual(runN.meta.genome, { slug: "learner-b", precedence: "seed", baseRef: 0, activeLedgerLen: 0 });

    // the C1 learning step (what the runner seam performs after dispatch N);
    // the fixture stream carries seat "builder", so collect for that seat.
    const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(3) });
    const learned = applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "learner-b" });
    assert.ok(learned);

    const runN1 = await seat(); // the NEXT composition
    assert.equal(runN1.meta.genome.activeLedgerLen, 1, "run N+1 composes over the accrued ledger");
    // and the composed identity honestly reflects the learned profile shift
    const ledger = readActiveLedger(dir, "learner-b");
    assert.equal(ledger.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addon C1: nothing to learn -> nothing appended, and the no-delta observation propagates (A100/DR-193)", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-c1-"));
  try {
    loadIdentity(dir, "learner-c", { preset: getPreset("O5C6E6A3N0") });
    const single = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(1) });
    const result = applyGradeFromRecord({ kernel, graderInput: single, projectDir: dir, slug: "learner-c" });
    assert.equal(result.noDelta, "gates-closed", "the caller sees WHY nothing was learned");
    assert.equal(readActiveLedger(dir, "learner-c").length, 0, "and the ledger is untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── addon: Phase C2 — the opportunistic seal trigger (A85/DR-178) ───────────

test("addon C2: the seal trigger fires at the threshold — learning consolidates into the next base", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-c2-"));
  try {
    const identity = loadIdentity(dir, "sealer-a", { preset: getPreset("O5C6E6A3N0") });
    const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(3) });

    // threshold 2: the first learn appends (no seal), the second seals.
    const first = applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "sealer-a", sealThreshold: 2 });
    assert.equal(first.sealed, null, "below the threshold — no seal");
    assert.equal(first.activeLedgerLen, 1);

    const second = applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "sealer-a", sealThreshold: 2 });
    assert.deepEqual(second.sealed, { baseRef: 1, deltasSealed: 2 }, "at the threshold — sealed");
    assert.equal(second.activeLedgerLen, 0, "active ledger reset by the seal");
    assert.equal(second.baseRef, 1);

    // the learning is CONSOLIDATED: the new base is the fold of both deltas,
    // and the read path returns it with an empty active ledger.
    assert.equal(readActiveLedger(dir, "sealer-a").length, 0);
    const consolidated = loadIdentity(dir, "sealer-a", { preset: getPreset("O5C6E6A3N0") });
    for (const [facet, shift] of Object.entries(second.pulls)) {
      const before = identity.facets[facet] ?? 0.5;
      assert.equal(
        consolidated.facets[facet],
        Math.max(0, Math.min(1, before + 2 * shift)),
        `${facet} carries BOTH sealed deltas`,
      );
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("addon C2: sealThreshold 0 disables auto-seal; the default leaves short ledgers unsealed", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-c2-"));
  try {
    loadIdentity(dir, "sealer-b", { preset: getPreset("O5C6E6A3N0") });
    const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: stableEvents(3) });

    // disabled: two learns, no seal
    applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "sealer-b", sealThreshold: 0 });
    const r2 = applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "sealer-b", sealThreshold: 0 });
    assert.equal(r2.sealed, null);
    assert.equal(r2.activeLedgerLen, 2);
    assert.equal(r2.baseRef, 0);

    // default threshold (32): one more learn stays unsealed
    const r3 = applyGradeFromRecord({ kernel, graderInput: record, projectDir: dir, slug: "sealer-b" });
    assert.equal(r3.sealed, null);
    assert.equal(r3.activeLedgerLen, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
