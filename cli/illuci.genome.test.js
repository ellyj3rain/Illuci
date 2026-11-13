// node:test — [A88.1] the genome CLI surface: `illuci genome <status|profile>`
// against a REAL genome dir (the A81 atomic genesis is the fixture builder).
// Pins the CLI half of DR-181 with tests — closing the A72.5 smoke-only gap.
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadIdentity, appendDelta, replay } from "../core/agents/persona-memory.js";
import { getPreset } from "../core/agents/disposition-presets.js";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const GDIR = (dir, slug) => join(dir, ".illuci", "data", "memory", "personas", slug);

function runIlluci(args, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("genome status reports the raw HEAD projection for a born + accrued genome", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cli-genome-"));
  try {
    loadIdentity(dir, "worker-a", { preset: getPreset("O5C6E6A3N0") });
    appendDelta(dir, "worker-a", { pulls: { "C1-Competence": 0.05 }, runId: "r-1" });
    const status = JSON.parse(runIlluci(["genome", "status", "worker-a", "--project-dir", dir, "--json"]));
    assert.equal(status.schema, "illuci.genome.status/1");
    assert.equal(status.slug, "worker-a");
    assert.equal(status.exists, true);
    assert.equal(status.baseRef, 0);
    assert.equal(status.activeLedgerLen, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("genome profile is the canonical presetless fold with provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cli-genome-"));
  try {
    const identity = loadIdentity(dir, "worker-b", { preset: getPreset("O5C6E6A3N0") });
    appendDelta(dir, "worker-b", { pulls: { "C1-Competence": 0.05 }, runId: "r-1" });
    const p = JSON.parse(runIlluci(["genome", "profile", "worker-b", "--project-dir", dir, "--json"]));
    assert.equal(p.schema, "illuci.genome.profile/1");
    assert.equal(p.exists, true);
    assert.equal(p.baseRef, 0);
    assert.equal(p.activeLedgerLen, 1);
    assert.equal(p.compensated, false);
    assert.equal(p.ledger[0].runId, "r-1");
    assert.deepEqual(p.profile, replay(identity, p.ledger));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI read never births a genome ({ exists: false }, no dir created)", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cli-genome-"));
  try {
    for (const sub of ["status", "profile"]) {
      const out = JSON.parse(runIlluci(["genome", sub, "unborn-a", "--project-dir", dir, "--json"]));
      assert.equal(out.exists, false, `${sub}: a missing genome is data`);
    }
    assert.equal(existsSync(GDIR(dir, "unborn-a")), false, "the read path performed no genesis");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage errors are loud: missing slug and unknown subcommand exit 1", () => {
  const noSlug = spawnSync(process.execPath, [cliPath, "genome", "status"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(noSlug.status, 1);
  assert.match(noSlug.stderr, /usage: illuci genome status/);

  const badSub = spawnSync(process.execPath, [cliPath, "genome", "frobnicate"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(badSub.status, 1);
  assert.match(badSub.stderr, /Unknown genome subcommand/);
});
