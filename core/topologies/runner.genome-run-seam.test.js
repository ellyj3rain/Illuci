/**
 * illuci — [A90]/DR-182 Phase 1: the genome run seam (vitest, hermetic)
 *
 * The three P1 repairs, proven through the PUBLIC run seam end to end:
 *  P1.1 `options.genome` reaches composition — a real topology run with an armed
 *       genome + a seated durable agent BIRTHS that agent's genome (pre-A90 the
 *       option died at runTopology's dispatchOpts literal: disclosed-but-dark).
 *  P1.2 lineage + identity edges — composition_resolved carries the MINTED
 *       runId, parentRunId (null at the root), depth, and the seated agentId.
 *  P1.3 the F-127 ordering repair — the grader window is chronological at the
 *       collector seam, so the provenance lens's "latest fingerprint" is the
 *       CURRENT composition's, not the window's oldest row.
 *
 * Same harness as runner.golden-trace.test.js: vi.mock on the ONE queryModel
 * choke-point makes the whole run hermetic (no bridges, no keys, no network).
 * Telemetry is isolated per-file via ILLUCI_CONTEXT_DB before any illuci import.
 *
 * Run: npx vitest run core/topologies/runner.genome-run-seam.test.js
 */

import { describe, it, beforeAll, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ILLUCI_HOME ||= join(process.cwd(), ".tmp", "illuci-test-home");
process.env.ILLUCI_DATA_HOME ||= join(process.cwd(), ".tmp", "illuci-test-data");
process.env.ILLUCI_GATE_MODE ||= "headless";
process.env.ILLUCI_DRL_ENABLED ||= "0";
// Isolated telemetry: this file's runs must not share the lane-wide store —
// the ordering assertion below reads the window this file alone wrote.
const CONTEXT_DB_DIR = mkdtempSync(join(tmpdir(), "illuci-a90-telemetry-"));
process.env.ILLUCI_CONTEXT_DB = join(CONTEXT_DB_DIR, "context.db");

vi.mock("../dispatch/dispatch.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    queryModel: async (model) => ({
      model,
      response: `[a90:${model}] deterministic clean answer for the genome-run-seam proof.`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      latency: 1,
    }),
  };
});

let runTopology;
let getTopology;
let MODEL_POOL;
let genomeStatus;
let telemetryStore;
let PRESET_IDS;

beforeAll(async () => {
  ({ runTopology } = await import("./runner.js"));
  ({ getTopology } = await import("./index.js"));
  const { MODELS } = await import("../matrix/capability-matrix.js");
  MODEL_POOL = [...MODELS].sort();
  ({ genomeStatus } = await import("../agents/persona-memory.js"));
  telemetryStore = await import("../telemetry/store.js"); // namespace import, same as the runner
  const { DISPOSITION_PRESETS } = await import("../agents/disposition-presets.js");
  PRESET_IDS = Object.keys(DISPOSITION_PRESETS).sort();
});

function lineupFor(topology) {
  const lineup = {};
  let slot = 0;
  for (const seat of topology.seats || []) {
    const count = Math.min(Math.max(seat.min || 0, 1), seat.max ?? Infinity);
    lineup[seat.id] = Array.from({ length: count }, () => MODEL_POOL[slot++ % MODEL_POOL.length]);
  }
  return lineup;
}

const RUN_OPTIONS = Object.freeze({
  runControl: {
    agenda: { strategy: "ritual" },
    execution: { mutationAuthority: "blocked" },
    tools: { autonomy: "directed" },
  },
  projectId: null,
});

describe("A90/DR-182 P1 — the genome run seam", () => {
  it("options.genome + a seated agent births the genome and stamps lineage + agent edges; the grader window is chronological", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a90-genome-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      assert.ok(topology, "a known topology resolves");
      const seatId = topology.seats[0].id;
      const agentId = "a90-wire-agent";
      const [presetA, presetB] = PRESET_IDS;
      assert.ok(presetA && presetB && presetA !== presetB, "two distinct presets exist");

      const baseOptions = (presetId) => ({
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId } },
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
        genome: { projectDir },
      });

      // Run 1 (preset A): the plumbing proof — the genome is BORN via the
      // public seam (pre-A90 this exact call left no genome behind).
      const t1 = await runTopology(topology.id, lineupFor(topology), "A90 wiring proof, run one.", baseOptions(presetA), "a90-seam-1");
      assert.ok(!t1.halted, "run one completes");
      const born = genomeStatus(projectDir, agentId);
      assert.equal(born.exists, true, "P1.1: options.genome reached composition — the agent's genome exists");
      assert.equal(born.baseRef, 0, "fresh genome at base 0");

      // Run 2 (preset B): a second composition for the SAME seat with a
      // DIFFERENT fingerprint — the ordering probe.
      const t2 = await runTopology(topology.id, lineupFor(topology), "A90 wiring proof, run two.", baseOptions(presetB), "a90-seam-2");
      assert.ok(!t2.halted, "run two completes");

      // P1.2: the newest composition_resolved for our seat carries the minted
      // runId, root lineage, and the seated agentId.
      const compositions = telemetryStore
        .getEvents({ event_type: "composition_resolved", limit: 200 })
        .map((e) => e && e.payload)
        .filter((p) => p && p.edges && p.edges.seatId === seatId && p.edges.agentId === agentId);
      assert.ok(compositions.length >= 2, "both runs composed for the seat");
      const newest = compositions[0]; // getEvents is newest-first
      assert.match(String(newest.edges.runId), new RegExp(`^${topology.id}-\\d+-`), "P1.2: the MINTED runId rides the edges (not the bare topology id)");
      assert.equal(newest.edges.parentRunId, null, "P1.2: a root run has no parent");
      assert.equal(newest.edges.depth, 0, "P1.2: a root run sits at depth 0");
      assert.equal(newest.edges.presetId, presetB, "the newest composition is run two's");

      // P1.3 (F-127): the provenance lens's fingerprint equals the CURRENT
      // (newest) composition's — under the pre-A90 un-reversed window it was
      // the window's OLDEST row (run one's preset-A fingerprint).
      const graderRecords = telemetryStore
        .getEvents({ event_type: "grader_input", limit: 50 })
        .map((e) => e && e.payload)
        .filter((p) => p && p.seatId === seatId && p.presetId === presetB);
      assert.ok(graderRecords.length >= 1, "run two produced a grader record");
      const lensFp = graderRecords[0].lenses.provenance.fingerprint;
      assert.equal(lensFp, newest.disposition.fingerprint, "P1.3: the lens's 'latest fingerprint' IS the current composition's");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);

  it("the default stays dark: the same run WITHOUT options.genome births nothing", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a90-dark-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      const seatId = topology.seats[0].id;
      const agentId = "a90-dark-agent";
      const t = await runTopology(topology.id, lineupFor(topology), "A90 dark-default proof.", {
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId: PRESET_IDS[0] } },
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
      }, "a90-seam-dark");
      assert.ok(!t.halted);
      assert.equal(genomeStatus(projectDir, agentId).exists, false, "no arm, no genome — byte-identical default");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);

  it("A100/DR-193: a structurally-mute disposition (zero tension pairs) emits a TYPED genome_no_delta event, never a silent skip", async (ctx) => {
    // DR-175 skip-tier: the C1 grade path needs the napi kernel, which is
    // built locally and gitignored — kernel-less CI skips this proof (the
    // JS-side no-delta contract is pinned kernel-free in genome-grade.test.js).
    const { loadPersonaKernel } = await import("../agents/persona-kernel.js");
    if (!loadPersonaKernel({ force: true }).available) return ctx.skip();
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a100-mute-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      const seatId = topology.seats[0].id;
      const agentId = "a100-balanced-arbiter";
      // O3C6E3A5N1 is the F-133 repro: a balanced high-C/high-A profile with no
      // opposing saliences — computeTensionPairs yields [] deterministically,
      // so direction (tension-lens-only in DR-176 v1) has nothing to grade.
      const t = await runTopology(topology.id, lineupFor(topology), "A100 mute-disposition proof.", {
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId: "O3C6E3A5N1" } },
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
        genome: { projectDir },
      }, "a100-mute-1");
      assert.ok(!t.halted, "the run completes");
      const noDelta = telemetryStore
        .getEvents({ event_type: "genome_no_delta", limit: 50 })
        .map((e) => e && e.payload)
        .filter((pl) => pl && pl.slug === agentId);
      assert.ok(noDelta.length >= 1, "the mute seat recorded a typed no-delta observation");
      assert.equal(noDelta[0].reason, "no-graded-facets", "and it names WHY (the F-133 shape)");
      assert.equal(typeof noDelta[0].runCount, "number", "gate signals ride the event for the DR-176 analysis");
      // and the ledger honestly stays empty — observation, not learning
      const status = genomeStatus(projectDir, agentId);
      assert.equal(status.exists, true, "the genome was born (composition is real)");
      assert.equal(status.activeLedgerLen, 0, "but nothing was appended");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);

  it("A101/DR-194: the SAME balanced arbiter LEARNS when salient is armed — a lens-tagged genome_appended, no longer silent", async (ctx) => {
    const { loadPersonaKernel } = await import("../agents/persona-kernel.js");
    if (!loadPersonaKernel({ force: true }).available) return ctx.skip();
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a101-salient-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      const seatId = topology.seats[0].id;
      const agentId = "a101-salient-arbiter";
      // Two runs of the SAME balanced preset (O3C6E3A5N1) with salient armed —
      // run 1 births it; run 2 grades (runCount>=2, stable) and appends.
      const opts = () => ({
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId: "O3C6E3A5N1" } },
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
        genome: { projectDir, gradingSources: ["tension", "salient"] },
      });
      await runTopology(topology.id, lineupFor(topology), "A101 salient run one.", opts(), "a101-sal-1");
      await runTopology(topology.id, lineupFor(topology), "A101 salient run two.", opts(), "a101-sal-2");
      const appended = telemetryStore
        .getEvents({ event_type: "genome_appended", limit: 50 })
        .map((e) => e && e.payload)
        .filter((pl) => pl && pl.slug === agentId);
      assert.ok(appended.length >= 1, "the balanced arbiter LEARNED under salient (pre-A101 it was structurally mute)");
      assert.deepEqual(appended[0].lenses, ["salient"], "and the delta names its director");
      assert.ok(genomeStatus(projectDir, agentId).activeLedgerLen >= 1, "the ledger grew");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);

  it("A102/DR-195: behavioral learns ONLY with accrued good outcomes — the phase_outcome pipeline + attribution end-to-end", async (ctx) => {
    const { loadPersonaKernel } = await import("../agents/persona-kernel.js");
    if (!loadPersonaKernel({ force: true }).available) return ctx.skip();
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a102-behav-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      const seatId = topology.seats[0].id;
      const agentId = "a102-behavioral-arbiter";
      const opts = () => ({
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId: "O3C6E3A5N1" } }, // balanced
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
        genome: { projectDir, gradingSources: ["behavioral"] },
      });
      // The mocked queryModel returns a ~60-char answer — below SUBSTANTIVE_CHARS
      // (200). So the accrued phase_outcomes are THIN → behavioral honestly nulls
      // even across many runs. This proves the honest-null half against a live seam.
      for (let i = 0; i < 4; i++) await runTopology(topology.id, lineupFor(topology), `A102 thin run ${i}.`, opts(), `a102-thin-${i}`);
      const outcomes = telemetryStore.getEvents({ event_type: "phase_outcome", limit: 200 }).map((e) => e && e.payload).filter((p) => p && p.agentId === agentId);
      assert.ok(outcomes.length >= 2, "the phase_outcome evidence pipeline persisted per-persona outcomes");
      assert.ok(outcomes.every((o) => o.substantive === false), "the mocked thin answers are not substantive evidence");
      const appended = telemetryStore.getEvents({ event_type: "genome_appended", limit: 50 }).map((e) => e && e.payload).filter((p) => p && p.slug === agentId);
      assert.equal(appended.length, 0, "behavioral did NOT reinforce a disposition whose expression never earned it (the honest null — salient WOULD have)");
      const noDelta = telemetryStore.getEvents({ event_type: "genome_no_delta", limit: 50 }).map((e) => e && e.payload).filter((p) => p && p.slug === agentId);
      assert.ok(noDelta.length >= 1, "and it recorded the typed no-delta observation");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);

  it("the D2 composite partition: a persona's measurement is unpolluted by another persona on the same seat ([A91]/DR-184)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "illuci-a91-partition-"));
    try {
      const topology = getTopology("adversarial-debate") || getTopology("dev-team");
      const seatId = topology.seats[0].id;
      const [presetA, presetB] = PRESET_IDS;
      const opts = (agentId, presetId) => ({
        ...RUN_OPTIONS,
        seatDispositions: { [seatId]: { presetId } },
        agents: { agents: { [agentId]: {} }, seatAgents: { [seatId]: agentId } },
        genome: { projectDir },
      });
      await runTopology(topology.id, lineupFor(topology), "partition x1", opts("a91-persona-x", presetA), "a91-part-1");
      await runTopology(topology.id, lineupFor(topology), "partition y", opts("a91-persona-y", presetB), "a91-part-2");
      const t3 = await runTopology(topology.id, lineupFor(topology), "partition x2", opts("a91-persona-x", presetA), "a91-part-3");
      assert.ok(!t3.halted);
      const records = telemetryStore
        .getEvents({ event_type: "grader_input", limit: 50 })
        .map((e) => e && e.payload)
        .filter((r) => r && r.seatId === seatId && r.presetId === presetA);
      const newest = records[0];
      assert.ok(newest, "persona X's grader record exists");
      assert.equal(newest.lenses.provenance.distinctFingerprints, 1, "persona Y's same-seat composition never entered X's window");
      assert.ok(newest.lenses.provenance.runCount >= 2, "X's own history accrues");
      assert.ok(newest.lineage && typeof newest.lineage.runId === "string", "the run-tree lens tag rides the record");
      assert.equal(newest.lineage.parentRunId, null);
      assert.equal(newest.lineage.depth, 0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 120000);
});
