// node:test - the FLOOR CLI (floor-check-cli.mjs) behaviors that the pure aggregator cannot
// cover: the override-must-fail-CLOSED-when-its-audit-cannot-persist guard (HIGH-1), and the
// base-ref (CI / PR) diff mode that inspects a PR's COMMITTED changes (the working/staged modes
// diff against HEAD and would no-op on a PR checkout - HIGH-3/HIGH-4). These exercise real git
// + filesystem state, so they run the CLI as a subprocess against a throwaway tmp repo.
//
// CONTRACT (mirrors the rest of the suite): no git CONFIG is mutated, no hook is armed, the
// canonical worktree is untouched - everything happens inside an mkdtemp dir we delete after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "floor-check-cli.mjs");

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// A throwaway repo with a deterministic identity + a clean first commit. The HEAD commit is the
// "prior" the floor compares against.
function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "gzds-floorcli-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

// Run the CLI as a subprocess; capture exit code + stdio. GZDS_AUDIT_TS pins the clock.
function runCli(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GZDS_AUDIT_TS: "2026-06-22T00:00:00.000Z", ...env },
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ---- HIGH-1: an override whose audit cannot persist must FAIL CLOSED (exit 1). ----

test("override FAILS CLOSED when the audit record cannot be written (exit 1, no false bypass)", () => {
  // Stage an illegal VERSION jump (5.8.0.0 -> 5.10.0.0: a +2 minor jump the version-gate blocks).
  const dir = makeRepo({ VERSION: "5.8.0.0\n" });
  try {
    writeFileSync(join(dir, "VERSION"), "5.10.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);

    // Sabotage the audit destination: make .illuci a FILE so mkdir(.illuci/governance) throws. This is
    // the exact "audit cannot land" condition from the adversarial finding.
    writeFileSync(join(dir, ".illuci"), "blocker\n", "utf8");

    const r = runCli(dir, [], { GZDS_OVERRIDE: "deliberate emergency bypass for the test" });

    assert.equal(r.status, 1, "override must fail CLOSED (exit 1) when its audit write fails");
    assert.match(r.stderr, /override REFUSED/i, "the refusal is loud about WHY");
    assert.doesNotMatch(r.stderr, /OVERRIDDEN \(/, "must NOT report a successful audited bypass");
    assert.doesNotMatch(r.stderr, /audited ->/, "must NOT claim a record landed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("override SUCCEEDS (exit 0, audited) when the audit record CAN be written", () => {
  const dir = makeRepo({ VERSION: "5.8.0.0\n" });
  try {
    writeFileSync(join(dir, "VERSION"), "5.10.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);

    const r = runCli(dir, [], { GZDS_OVERRIDE: "deliberate emergency bypass for the test" });

    assert.equal(r.status, 0, "a reasoned override with a writable trail proceeds (exit 0)");
    assert.match(r.stderr, /OVERRIDDEN/, "the audited bypass is loud");
    const auditPath = join(dir, ".illuci", "governance", "floor-audit.jsonl");
    assert.ok(existsSync(auditPath), "the forensic record actually landed");
    const rec = JSON.parse(readFileSync(auditPath, "utf8").trim().split("\n").pop());
    assert.equal(rec.outcome, "overridden");
    assert.equal(rec.override.overridden, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a block with NO override exits 1 (sanity: the gate still stops a bad bump)", () => {
  const dir = makeRepo({ VERSION: "5.8.0.0\n" });
  try {
    writeFileSync(join(dir, "VERSION"), "5.10.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);
    const r = runCli(dir, []);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLOCKED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- HIGH-3 / HIGH-4: base-ref mode inspects a PR's COMMITTED changes. ----

test("base-ref mode DETECTS an illegal bump committed at HEAD (the working/staged modes no-op)", () => {
  // Simulate a PR: base branch 'main' at 1.0.0, a feature branch that COMMITS an illegal 1.5.0.0.
  const dir = makeRepo({ VERSION: "1.0.0\n" });
  try {
    git(dir, ["branch", "-m", "main"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "VERSION"), "1.5.0.0\n", "utf8"); // +5 minor jump = illegal
    git(dir, ["add", "VERSION"]);
    git(dir, ["commit", "-q", "-m", "illegal bump"]);

    // --working would diff HEAD vs the working tree (identical) -> EMPTY -> false clean.
    const working = runCli(dir, ["--working"]);
    assert.equal(working.status, 0, "control: --working is a no-op on a committed PR change (false clean)");
    assert.match(working.stdout, /OK/);

    // --base main diffs the merge-base of main and HEAD against HEAD -> sees the 1.0.0 -> 1.5.0.0
    // bump and BLOCKS. This is the fix: CI must run base-ref mode, not --working.
    const base = runCli(dir, ["--base", "main"]);
    assert.equal(base.status, 1, "base-ref mode inspects the PR's committed changes and blocks");
    assert.match(base.stderr, /BLOCKED/);
    assert.match(base.stderr, /version-gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("base-ref mode passes a LEGAL committed bump (1.0.0 -> 1.1.0)", () => {
  const dir = makeRepo({ VERSION: "1.0.0\n" });
  try {
    git(dir, ["branch", "-m", "main"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "VERSION"), "1.1.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);
    git(dir, ["commit", "-q", "-m", "legal bump"]);

    const base = runCli(dir, ["--base", "main"]);
    assert.equal(base.status, 0, "a legal committed minor bump passes base-ref mode");
    assert.match(base.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("base-ref mode supports --base=<ref> (single-token form) too", () => {
  const dir = makeRepo({ VERSION: "1.0.0\n" });
  try {
    git(dir, ["branch", "-m", "main"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "VERSION"), "1.5.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);
    git(dir, ["commit", "-q", "-m", "illegal bump"]);
    const r = runCli(dir, ["--base=main"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /version-gate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("base-ref mode with an UNRESOLVABLE base yields an empty changeset (no false verdict)", () => {
  const dir = makeRepo({ VERSION: "5.8.0.0\n" });
  try {
    writeFileSync(join(dir, "VERSION"), "5.10.0.0\n", "utf8");
    git(dir, ["add", "VERSION"]);
    git(dir, ["commit", "-q", "-m", "illegal but unreachable from a bogus base"]);
    // A base ref that does not exist -> merge-base fails -> empty changeset -> clean (it does NOT
    // silently fall back to a HEAD diff, which would itself be empty anyway, but the contract is
    // "empty changeset", not a thrown error).
    const r = runCli(dir, ["--base", "origin/does-not-exist"]);
    assert.equal(r.status, 0, "an unresolvable base produces a clean empty-changeset verdict, no crash");
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
