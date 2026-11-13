// Hermetic tests for the worktree lifecycle sweep (DR-208; F-148).
// Fixtures live under mkdtemp; the suite never touches a real repo.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  WORKTREE_SWEEP_DEFAULTS,
  listRegisteredWorktrees,
  resolveAgainstRef,
  sweepWorktrees,
} from "./worktree-sweep.js";

function g(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** A repo with main at c2; helper to add worktrees beside it. */
function makeFixture(base) {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-b", "main");
  g(repo, "config", "user.email", "sweep-test@illuci");
  g(repo, "config", "user.name", "sweep-test");
  g(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g(repo, "add", ".");
  g(repo, "commit", "-m", "c1");
  const c1 = g(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "a.txt"), "two\n");
  g(repo, "add", ".");
  g(repo, "commit", "-m", "c2");
  const addWorktree = (name, branch, at = c1) => {
    const p = join(base, name);
    g(repo, "worktree", "add", "-b", branch, p, at);
    return p;
  };
  return { repo, c1, addWorktree };
}

describe("sweepWorktrees", () => {
  const base = mkdtempSync(join(tmpdir(), "illuci-wt-sweep-"));
  let fx;

  before(() => {
    fx = makeFixture(base);
  });

  after(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it("resolves the against ref and fails safe when none resolves", () => {
    assert.equal(resolveAgainstRef(fx.repo, "main"), "main");
    assert.equal(resolveAgainstRef(fx.repo, "no-such-ref-anywhere"), null);
    const report = sweepWorktrees({ repoDir: fx.repo, againstRef: "no-such-ref-anywhere", apply: true });
    assert.ok(report.errors.some((e) => e.name === "(against)"));
    assert.equal(report.swept.length, 0);
  });

  it("plan mode classifies without deleting anything", () => {
    const merged = fx.addWorktree("wt-plan-merged", "plan-merged");
    const report = sweepWorktrees({ repoDir: fx.repo, againstRef: "main", minAgeDays: 0 });
    assert.equal(report.mode, "plan");
    const rec = report.entries.find((e) => e.name === "wt-plan-merged");
    assert.equal(rec.verdict, "sweep");
    assert.ok(existsSync(merged), "plan mode must not delete");
    assert.equal(report.swept.length, 0);
    const mainRec = report.entries.find((e) => e.name === "repo");
    assert.equal(mainRec.verdict, "keep");
    assert.ok(mainRec.reasons.some((r) => r.includes("main worktree")));
    g(fx.repo, "worktree", "remove", "--force", merged);
    g(fx.repo, "branch", "-D", "plan-merged");
  });

  it("apply sweeps a stale merged clean worktree and keeps fresh ones under minAgeDays", () => {
    const merged = fx.addWorktree("wt-apply-merged", "apply-merged");
    // Fresh guard: with a large minAgeDays the same worktree is kept as fresh.
    const freshReport = sweepWorktrees({ repoDir: fx.repo, againstRef: "main", minAgeDays: 365 });
    const freshRec = freshReport.entries.find((e) => e.name === "wt-apply-merged");
    assert.equal(freshRec.verdict, "keep");
    assert.ok(freshRec.reasons.some((r) => r.includes("fresh")));

    const report = sweepWorktrees({ repoDir: fx.repo, againstRef: "main", minAgeDays: 0, apply: true });
    assert.ok(report.swept.some((s) => s.name === "wt-apply-merged"));
    assert.ok(!existsSync(merged), "apply must delete the directory");
    assert.ok(!listRegisteredWorktrees(fx.repo).some((w) => w.path === merged));
    g(fx.repo, "branch", "-D", "apply-merged");
  });

  it("never sweeps unmerged, dirty (default), locked, or the invoking worktree", () => {
    const unmerged = fx.addWorktree("wt-unmerged", "feat-live");
    writeFileSync(join(unmerged, "b.txt"), "new\n");
    g(unmerged, "add", ".");
    g(unmerged, "commit", "-m", "feature work");
    const dirty = fx.addWorktree("wt-dirty", "dirty-br");
    writeFileSync(join(dirty, "untracked.txt"), "wip\n");
    const locked = fx.addWorktree("wt-locked", "locked-br");
    g(fx.repo, "worktree", "lock", locked);
    const invoking = fx.addWorktree("wt-invoking", "invoking-br");

    const report = sweepWorktrees({
      repoDir: fx.repo,
      againstRef: "main",
      minAgeDays: 0,
      apply: true,
      cwd: invoking,
    });

    for (const [name, path, needle] of [
      ["wt-unmerged", unmerged, "unmerged"],
      ["wt-dirty", dirty, "dirty"],
      ["wt-locked", locked, "locked"],
      ["wt-invoking", invoking, "invoking"],
    ]) {
      const rec = report.entries.find((e) => e.name === name);
      assert.equal(rec.verdict, "keep", `${name} must be kept`);
      assert.ok(rec.reasons.some((r) => r.includes(needle)), `${name} reason names ${needle}`);
      assert.ok(existsSync(path), `${name} directory intact`);
    }

    g(fx.repo, "worktree", "unlock", locked);
    for (const p of [unmerged, dirty, locked, invoking]) g(fx.repo, "worktree", "remove", "--force", p);
    for (const b of ["feat-live", "dirty-br", "locked-br", "invoking-br"]) g(fx.repo, "branch", "-D", b);
  });

  it("quarantines dirty files (manifest + copies) before sweeping under the explicit control", () => {
    const dirty = fx.addWorktree("wt-q-dirty", "q-dirty-br");
    mkdirSync(join(dirty, "notes"));
    writeFileSync(join(dirty, "notes", "draft.md"), "unshipped deliverable\n");
    writeFileSync(join(dirty, "a.txt"), "modified\n");
    const quarantineRoot = join(base, "quarantine");

    const report = sweepWorktrees({
      repoDir: fx.repo,
      againstRef: "main",
      minAgeDays: 0,
      apply: true,
      quarantineAndSweep: true,
      quarantineRoot,
    });

    assert.ok(report.swept.some((s) => s.name === "wt-q-dirty"));
    assert.ok(!existsSync(dirty));
    const q = report.quarantined.find((q2) => q2.name === "wt-q-dirty");
    assert.ok(q && q.copied >= 2, "both dirty paths copied");
    assert.equal(readFileSync(join(quarantineRoot, "wt-q-dirty", "notes", "draft.md"), "utf8"), "unshipped deliverable\n");
    assert.equal(readFileSync(join(quarantineRoot, "wt-q-dirty", "a.txt"), "utf8"), "modified\n");
    const manifest = readFileSync(join(quarantineRoot, "wt-q-dirty", "MANIFEST.txt"), "utf8");
    assert.match(manifest, /worktree: /);
    // porcelain reports the untracked DIRECTORY (notes/), not files inside it
    assert.match(manifest, /notes\//);
    assert.match(manifest, /a\.txt/);
    g(fx.repo, "branch", "-D", "q-dirty-br");
  });

  it("unlinks reparse points link-only — the link target survives the sweep (F-148 hazard 1)", () => {
    const wt = fx.addWorktree("wt-linked", "linked-br");
    const victim = join(base, "victim-project");
    mkdirSync(victim);
    writeFileSync(join(victim, "precious.txt"), "do-not-delete\n");
    try {
      symlinkSync(victim, join(wt, "esc"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Symlink privilege unavailable — soft-skip like the cli-sandbox precedent.
      g(fx.repo, "worktree", "remove", "--force", wt);
      g(fx.repo, "branch", "-D", "linked-br");
      return;
    }

    // The junction itself is an untracked entry, so the worktree counts as
    // dirty — exactly the real F-148 shape. Quarantine control opts it in;
    // the quarantine must SKIP the link (never copy through it).
    const quarantineRoot = join(base, "quarantine-link");
    const report = sweepWorktrees({
      repoDir: fx.repo,
      againstRef: "main",
      minAgeDays: 0,
      apply: true,
      quarantineAndSweep: true,
      quarantineRoot,
    });

    assert.ok(report.swept.some((s) => s.name === "wt-linked"), "worktree swept");
    assert.ok(!existsSync(wt), "worktree gone");
    assert.ok(existsSync(join(victim, "precious.txt")), "link target intact");
    assert.ok(readdirSync(victim).includes("precious.txt"));
    assert.ok(report.reparseUnlinked.some((r) => r.name === "wt-linked"), "unlink recorded");
    assert.ok(
      !existsSync(join(quarantineRoot, "wt-linked", "esc", "precious.txt")),
      "quarantine never copies through a link",
    );
    g(fx.repo, "branch", "-D", "linked-br");
  });

  it("culls only branches fully merged into the ref; -d semantics, protected names survive", () => {
    const merged = fx.addWorktree("wt-cull", "cull-merged");
    const keeper = fx.addWorktree("wt-keeper", "keeper-br");

    // Plan first: cull is listed as planned, nothing deleted.
    const plan = sweepWorktrees({ repoDir: fx.repo, againstRef: "main", minAgeDays: 0, branches: true, cwd: keeper });
    assert.ok(plan.branchesDeleted.every((b) => b.planned === true));
    assert.ok(g(fx.repo, "branch", "--list", "cull-merged").includes("cull-merged"));

    const report = sweepWorktrees({
      repoDir: fx.repo,
      againstRef: "main",
      minAgeDays: 0,
      apply: true,
      branches: true,
      cwd: keeper,
    });

    assert.ok(report.swept.some((s) => s.name === "wt-cull"));
    assert.ok(report.branchesDeleted.some((b) => b.name === "cull-merged"), "freed merged branch culled");
    assert.ok(!report.branchesDeleted.some((b) => b.name === "main"), "main protected");
    assert.ok(!report.branchesDeleted.some((b) => b.name === "keeper-br"), "checked-out branch protected");
    assert.ok(g(fx.repo, "branch", "--list", "keeper-br").includes("keeper-br"));
    assert.ok(!g(fx.repo, "branch", "--list", "cull-merged").includes("cull-merged"));

    g(fx.repo, "worktree", "remove", "--force", keeper);
    g(fx.repo, "branch", "-D", "keeper-br");
  });

  it("defaults are the disclosed ones", () => {
    assert.equal(WORKTREE_SWEEP_DEFAULTS.minAgeDays, 7);
    assert.equal(WORKTREE_SWEEP_DEFAULTS.minBehind, 1);
    assert.equal(WORKTREE_SWEEP_DEFAULTS.apply, false);
    assert.equal(WORKTREE_SWEEP_DEFAULTS.keepDirty, true);
    assert.equal(WORKTREE_SWEEP_DEFAULTS.branches, false);
  });

  it("win32: removal survives long node_modules-style paths (F-148 hazard 2)", () => {
    if (process.platform !== "win32") return; // the hazard is a Windows path-length artifact
    const wt = fx.addWorktree("wt-longpath", "longpath-br");
    let deep = join(wt, "node_modules");
    for (let i = 0; i < 14; i += 1) deep = join(deep, `nested-directory-segment-${String(i).padStart(2, "0")}-padding-padding`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "leaf.txt"), "deep\n");
    assert.ok(deep.length > 260, `fixture path is long (${deep.length})`);

    // node_modules is untracked -> dirty; quarantine control set, but the
    // node_modules subtree is skipped by design (copies stay light).
    const report = sweepWorktrees({
      repoDir: fx.repo,
      againstRef: "main",
      minAgeDays: 0,
      apply: true,
      quarantineAndSweep: true,
      quarantineRoot: join(base, "quarantine-long"),
    });

    assert.ok(report.swept.some((s) => s.name === "wt-longpath"), "long-path worktree swept");
    assert.ok(!existsSync(wt), "directory fully gone despite >260-char contents");
    g(fx.repo, "branch", "-D", "longpath-br");
  });
});
