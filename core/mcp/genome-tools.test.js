// node:test — [A88] the genome read verbs: status/profile over the MCP
// surface against a REAL genome dir (the A81 atomic genesis is the fixture
// builder — never hand-written genome files). Read-law coverage: a read verb
// never births a genome, and the profile read is presetless (pure) because
// it only runs when the genome already exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENOME_TOOLS } from "./genome-tools.js";
import { startServer } from "./server.js";
import { loadIdentity, appendDelta, sealActiveLedger, replay } from "../agents/persona-memory.js";
import { getPreset } from "../agents/disposition-presets.js";

const tool = (name) => GENOME_TOOLS.find((t) => t.name === name);
const GDIR = (dir, slug) => join(dir, ".illuci", "data", "memory", "personas", slug);

test("the two verbs are declared; both read-shaped (requiredActions: [])", () => {
  assert.deepEqual(GENOME_TOOLS.map((t) => t.name), ["genome_status_v1", "genome_profile_v1"]);
  assert.deepEqual(tool("genome_status_v1").requiredActions, []);
  assert.deepEqual(tool("genome_profile_v1").requiredActions, []);
});

test("validation is loud: projectDir and slug are required strings", async () => {
  for (const name of ["genome_status_v1", "genome_profile_v1"]) {
    await assert.rejects(
      () => tool(name).handler({ slug: "worker-a" }),
      new RegExp(`${name}: projectDir \\(string\\) is required`),
    );
    await assert.rejects(
      () => tool(name).handler({ projectDir: "/somewhere" }),
      new RegExp(`${name}: slug \\(string\\) is required`),
    );
  }
});

test("a read verb never births a genome ({ exists: false }, no dir created)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-mcp-genome-"));
  try {
    const status = await tool("genome_status_v1").handler({ projectDir: dir, slug: "unborn-a" });
    assert.deepEqual(status, { projectDir: dir, slug: "unborn-a", exists: false });
    const profile = await tool("genome_profile_v1").handler({ projectDir: dir, slug: "unborn-a" });
    assert.deepEqual(profile, { projectDir: dir, slug: "unborn-a", exists: false });
    assert.equal(existsSync(GDIR(dir, "unborn-a")), false, "the read path performed no genesis");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status reports the raw HEAD projection across genesis, accrual, and seal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-mcp-genome-"));
  try {
    loadIdentity(dir, "worker-a", { preset: getPreset("O5C6E6A3N0") });
    let s = await tool("genome_status_v1").handler({ projectDir: dir, slug: "worker-a" });
    assert.equal(s.exists, true);
    assert.equal(s.baseRef, 0);
    assert.equal(s.activeLedgerLen, 0);

    appendDelta(dir, "worker-a", { pulls: { "C1-Competence": 0.05 }, runId: "r-1" });
    s = await tool("genome_status_v1").handler({ projectDir: dir, slug: "worker-a" });
    assert.equal(s.activeLedgerLen, 1);

    sealActiveLedger(dir, "worker-a", { now: "2026-07-10T02:00:00.000Z" });
    s = await tool("genome_status_v1").handler({ projectDir: dir, slug: "worker-a" });
    assert.equal(s.baseRef, 1);
    assert.equal(s.activeLedgerLen, 0);
    assert.equal(s.lastSealAt, "2026-07-10T02:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile is the canonical presetless fold (identity + unsealed ledger, provenance carried)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-mcp-genome-"));
  try {
    const identity = loadIdentity(dir, "worker-b", { preset: getPreset("O5C6E6A3N0") });
    appendDelta(dir, "worker-b", { pulls: { "C1-Competence": 0.05 }, runId: "r-1", seatId: "architect" });

    const p = await tool("genome_profile_v1").handler({ projectDir: dir, slug: "worker-b" });
    assert.equal(p.exists, true);
    assert.equal(p.baseRef, 0);
    assert.equal(p.activeLedgerLen, 1);
    assert.equal(p.compensated, false);
    assert.equal(p.ledger.length, 1);
    assert.equal(p.ledger[0].runId, "r-1");
    assert.equal(p.ledger[0].seatId, "architect");
    assert.deepEqual(p.profile, replay(identity, p.ledger), "the payload profile IS the fold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP server registers the genome read verbs and answers tools/call", async () => {
  const { handlers } = await startServer({ tenantId: "genome-verbs-test" });
  const listed = await handlers["tools/list"]({});
  const names = listed.tools.map((t) => t.name);
  for (const name of ["genome_status_v1", "genome_profile_v1"]) {
    assert.ok(names.includes(name), `${name} registered`);
  }
  const dir = mkdtempSync(join(tmpdir(), "illuci-mcp-genome-"));
  try {
    const called = await handlers["tools/call"]({
      params: { name: "genome_status_v1", arguments: { projectDir: dir, slug: "unborn-b" } },
    });
    assert.equal(called.schema_version, "1.0.0");
    const payload = JSON.parse(called.content[0].text);
    assert.deepEqual(payload, { projectDir: dir, slug: "unborn-b", exists: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
