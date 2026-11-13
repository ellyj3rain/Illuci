import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { composeBehavioralDisposition } from "./disposition-resolver.js";
import { appendDelta, genomeExists } from "../agents/persona-memory.js";

test("matrix role ids bridge to skill-bundle roles for dimensional disposition", async () => {
  const result = await composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "implementer",
    seatDef: {},
    dispatchOpts: { seatDispositions: { implementer: { presetId: "O5C6E6A3N0", role: "implementer" } } },
  });

  assert.equal(result.engine, "dimensional");
  assert.equal(result.meta.role, "implementer");
  assert.equal(result.meta.compositionRole, "senior-engineer");
  assert.match(result.block, /\[Role: Senior Engineer\]/);
  // A76/DR-169: composed identity threaded into meta for run provenance.
  assert.equal(result.meta.identity.base.slug, "O5C6E6A3N0"); // the source preset
  assert.match(result.meta.identity.base.fingerprint, /^sha256v1:/);
  assert.match(result.meta.identity.composed.fingerprint, /^sha256v1:/);
  assert.equal(typeof result.meta.identity.composed.slug, "string");
});

test("matrix role aliases also bridge before disposition composition", async () => {
  const result = await composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "builder",
    seatDef: {},
    dispatchOpts: { seatDispositions: { builder: { presetId: "O5C6E0A2N4", role: "builder" } } },
  });

  assert.equal(result.meta.role, "builder");
  assert.equal(result.meta.compositionRole, "senior-engineer");
  assert.match(result.block, /\[Role: Senior Engineer\]/);
});

// ───────────────────────────────────────────────────────────────────────────
// A80/DR-173 (DR-170 Phase A3) — the genome wiring behind the explicit control
// ───────────────────────────────────────────────────────────────────────────
const GENOME_SEAT = (genome, agentId = "worker-alpha") => ({
  modelId: "test-model",
  seatId: "implementer",
  agentId,
  seatDef: {},
  dispatchOpts: {
    seatDispositions: { implementer: { presetId: "O5C6E6A3N0", role: "implementer" } },
    ...(genome ? { genome } : {}),
  },
});

test("A3: without the explicit control the genome stays fully dark — no meta.genome, no genome dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-a3-"));
  try {
    const r = await composeBehavioralDisposition(GENOME_SEAT(null));
    assert.equal(r.meta.genome, undefined);
    assert.equal(genomeExists(dir, "worker-alpha"), false, "nothing touched the filesystem");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: the control is fail-closed — genome without a projectDir throws loudly", async () => {
  await assert.rejects(
    () => composeBehavioralDisposition(GENOME_SEAT({ precedence: "seed" })),
    /requires a projectDir/,
  );
});

test("A3: fresh genome (empty ledger) is a verified no-op — output equals the dark path; genesis is born", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-a3-"));
  try {
    const dark = await composeBehavioralDisposition(GENOME_SEAT(null));
    const lit = await composeBehavioralDisposition(GENOME_SEAT({ projectDir: dir }));
    // genesis born lazily on first genome-enabled compose
    assert.equal(genomeExists(dir, "worker-alpha"), true);
    // provenance says which genome seeded the run
    assert.deepEqual(lit.meta.genome, { slug: "worker-alpha", precedence: "seed", baseRef: 0, activeLedgerLen: 0 });
    // and the COMPOSITION is unchanged: block + composed identity byte-equal to dark
    assert.equal(lit.block, dark.block);
    assert.deepEqual(lit.meta.identity, dark.meta.identity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: an accrued ledger changes the composition under seed mode — learning is visible end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-a3-"));
  try {
    const fresh = await composeBehavioralDisposition(GENOME_SEAT({ projectDir: dir }));
    // -0.8 so the accrued shift survives role/skill re-pulls AND band7 quantization
    // (the composed fingerprint is over the BANDED L2 — small deltas can band-collapse).
    appendDelta(dir, "worker-alpha", { pulls: { "C1-Competence": -0.8 } });
    const learned = await composeBehavioralDisposition(GENOME_SEAT({ projectDir: dir }));
    assert.equal(learned.meta.genome.activeLedgerLen, 1);
    assert.notEqual(
      learned.meta.identity.composed.fingerprint,
      fresh.meta.identity.composed.fingerprint,
      "the accrued delta shifts the composed identity",
    );
    assert.equal(learned.meta.identity.base.slug, "O5C6E6A3N0", "base provenance still names the preset");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: no agentId means no genome — the control needs a durable persona", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-a3-"));
  try {
    const r = await composeBehavioralDisposition(GENOME_SEAT({ projectDir: dir }, null));
    assert.equal(r.meta.genome, undefined);
    assert.equal(genomeExists(dir, "worker-alpha"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: inline (preset-less) seats hand their profile to the grader seam", async () => {
  const r = await composeBehavioralDisposition({
    modelId: "test-model",
    seatId: "adhoc",
    seatDef: {},
    dispatchOpts: {
      seatDispositions: {
        adhoc: { profile: { facets: { "O5-Ideas": 0.9, "C6-Deliberation": 0.85, "N5-Impulsiveness": 0.1 } } },
      },
    },
  });
  assert.equal(r.engine, "dimensional");
  assert.deepEqual(r.graderProfile, { facets: { "O5-Ideas": 0.9, "C6-Deliberation": 0.85, "N5-Impulsiveness": 0.1 } });
  assert.equal(r.meta.presetId, null);
});

// ─── [A92]/DR-185 — the derive state at the composition gate ───

import { readFileSync as _rf, existsSync as _ex } from 'fs';
import { readLiveProfile as _rlp, genomeStatus as _gs } from '../agents/persona-memory.js';

const DERIVE_SEAT = (dir, extra = {}) => ({
  modelId: 'test-model',
  seatId: 'implementer',
  agentId: 'worker-alpha',
  seatDef: {},
  dispatchOpts: {
    seatDispositions: { implementer: { presetId: 'O5C6E6A3N0', role: 'implementer' } },
    genome: { projectDir: dir, childIdentity: 'derive' },
    runId: 'child-run-1',
    parentRunId: 'parent-run-1',
    topologyId: 'adversarial-debate',
    ...extra,
  },
});

test('A92: a CHILD run under derive mints <parent>-<seat>, genesis from the parent live profile, genealogy staged atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'illuci-a92-derive-'));
  try {
    // Give the parent persona accrued state so the derived genesis provably
    // seeds from the LIVE profile, not the bare preset.
    const parentLive0 = _rlp(dir, 'worker-alpha', { preset: (await import('../agents/disposition-presets.js')).getPreset('O5C6E6A3N0') });
    appendDelta(dir, 'worker-alpha', { pulls: { 'C1-Competence': 0.05 }, runId: 'pre-1' });
    const parentLive = _rlp(dir, 'worker-alpha');

    const r = await composeBehavioralDisposition(DERIVE_SEAT(dir));
    assert.equal(r.meta.genome.slug, 'worker-alpha-implementer', 'the derived slug');
    assert.equal(r.meta.genome.derivedFrom, 'worker-alpha');
    assert.equal(_gs(dir, 'worker-alpha-implementer').exists, true, 'the derived genome was born');

    const gdir = join(dir, '.illuci', 'data', 'memory', 'personas', 'worker-alpha-implementer');
    const genesis = JSON.parse(_rf(join(gdir, 'genesis.json'), 'utf8'));
    assert.deepEqual(genesis, parentLive.profile, 'genesis IS the parent persona live compensated profile');
    const genealogy = JSON.parse(_rf(join(gdir, 'genealogy.json'), 'utf8'));
    assert.equal(genealogy.parentSlug, 'worker-alpha');
    assert.equal(genealogy.spawn.parentRunId, 'parent-run-1');
    assert.equal(genealogy.spawn.seatId, 'implementer');
    assert.equal(genealogy.spawn.topologyId, 'adversarial-debate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A92: a ROOT run armed derive seats the agent UNDERIVED — derivation is a property of children', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'illuci-a92-root-'));
  try {
    const r = await composeBehavioralDisposition(DERIVE_SEAT(dir, { parentRunId: null }));
    assert.equal(r.meta.genome.slug, 'worker-alpha', 'no parent, no derivation');
    assert.equal(r.meta.genome.derivedFrom, undefined);
    assert.equal(_ex(join(dir, '.illuci', 'data', 'memory', 'personas', 'worker-alpha-implementer')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
