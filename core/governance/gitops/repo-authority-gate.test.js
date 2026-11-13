import { test } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPO_AUTHORITY_OBLIGATION,
  checkRepoAuthority,
  deriveRepoAuthorityContext,
} from "./repo-authority-gate.js";
import { WORKTREE_CONTEXT_DISPOSITIONS } from "./worktree-context-classifier.js";
import { check as branchVerifyCheck, PREDICATE as BRANCH_VERIFY_PREDICATE } from "../compiled/floor/std-12.repo-authority.branch-verify.js";

// --- temp-repo scaffolding (only for the checkRepoAuthority behavior half) ---
// A real on-disk git repo so arm() writes to <temp>/core/governance/compiler/audit/overrides.jsonl
// instead of the real repo's ledger. realpathSync mirrors the probe's safeRealpath so the
// dispatched root/worktree compare equal to the probed values on Windows temp paths.
function makeTempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "repo-authority-gate-")));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "work", ".");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, branch: "work" };
}

// (A) PURE deriveRepoAuthorityContext unit tests — fabricated facts, no repo, no disk.

test("deriveRepoAuthorityContext emits canonical_roots so the std-12 branch-verify atom is un-starved", () => {
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon", shadowRepos: [] },
  });
  assert.deepEqual(ctx.canonical_roots, ["/canon"]);
  assert.equal(ctx.working_root, "/canon");
  assert.equal(ctx.active_branch, "feat");
});

test("deriveRepoAuthorityContext leaves active_branch null when HEAD is detached", () => {
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: null, worktreePath: "/canon", shadowRepos: [] },
  });
  assert.equal(ctx.active_branch, null);
  assert.deepEqual(ctx.canonical_roots, ["/canon"]);
});

test("deriveRepoAuthorityContext emits an empty fragment when the actual context is not a git repo", () => {
  const ctx = deriveRepoAuthorityContext({ actual: { isGitRepo: false } });
  assert.deepEqual(Object.keys(ctx), []);
});

test("deriveRepoAuthorityContext omits dispatched_lineage and dispatched_branch when no lineage is supplied", () => {
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon", shadowRepos: [] },
  });
  assert.equal("dispatched_lineage" in ctx, false);
  assert.equal("dispatched_branch" in ctx, false);
  assert.equal("intended_worktree" in ctx, false);
});

test("deriveRepoAuthorityContext adds dispatched_lineage and dispatched_branch when a branch lineage is present", () => {
  const dispatched = { canonicalRoot: "/canon", branch: "feat" };
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon", shadowRepos: [] },
    dispatched,
  });
  assert.deepEqual(ctx.dispatched_lineage, dispatched);
  assert.equal(ctx.dispatched_branch, "feat");
  assert.equal("intended_worktree" in ctx, false);
});

test("deriveRepoAuthorityContext adds intended_worktree only when the lineage constrains a worktree", () => {
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon/w", shadowRepos: [] },
    dispatched: { canonicalRoot: "/canon", branch: "feat", worktreePath: "/canon/w" },
  });
  assert.equal(ctx.intended_worktree, "/canon/w");
});

// (A') Compiled std-12 atom firing — deriveRepoAuthorityContext supplies its facts.
// GZDS_OVERRIDE must stay unset so a mismatch stays a hard block rather than an audited pass.

test("the compiled std-12 branch-verify atom compares active_branch against dispatched_branch", () => {
  assert.equal(BRANCH_VERIFY_PREDICATE, "active_branch == dispatched_branch");
});

test("derived context makes the compiled branch-verify atom pass when active and dispatched branches match", () => {
  delete process.env.GZDS_OVERRIDE;
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon", shadowRepos: [] },
    dispatched: { canonicalRoot: "/canon", branch: "feat" },
  });
  const r = branchVerifyCheck(ctx);
  assert.equal(r.ok, true);
});

test("derived context makes the compiled branch-verify atom fail when active and dispatched branches differ", () => {
  delete process.env.GZDS_OVERRIDE;
  const ctx = deriveRepoAuthorityContext({
    actual: { isGitRepo: true, repoRoot: "/canon", currentBranch: "feat", worktreePath: "/canon", shadowRepos: [] },
    dispatched: { canonicalRoot: "/canon", branch: "other" },
  });
  const r = branchVerifyCheck(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, "violation");
});

// (B) checkRepoAuthority behavior against real temp repos.

test("correct-identity dirty worktree is allowed at trigger pre-edit because dirty is advisory, never a split-brain", () => {
  delete process.env.GZDS_OVERRIDE;
  const repo = makeTempRepo();
  try {
    writeFileSync(join(repo.dir, "dirt.txt"), "uncommitted");
    const r = checkRepoAuthority({
      cwd: repo.dir,
      dispatchedLineage: { root: repo.dir, branch: repo.branch },
      trigger: "pre-edit",
    });
    assert.equal(r.allowed, true);
    assert.equal(r.ok, true);
    assert.equal(r.code, "satisfied");
    // The classifier still saw the dirt; it is a non-blocking advisory signal.
    assert.equal(r.blockingSignals.length, 0);
    assert.ok(r.verdict.signals.some((s) => s.code === "dirty-worktree"));
    assert.equal(r.verdict.audit.blockingSignals.length, 0);
    assert.match(r.reason, /context authorized \(pre-edit\)/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("correct-identity dirty worktree is also allowed at trigger session-init because dirty never blocks", () => {
  delete process.env.GZDS_OVERRIDE;
  const repo = makeTempRepo();
  try {
    writeFileSync(join(repo.dir, "dirt.txt"), "uncommitted");
    const r = checkRepoAuthority({
      cwd: repo.dir,
      dispatchedLineage: { root: repo.dir, branch: repo.branch },
      trigger: "session-init",
    });
    assert.equal(r.allowed, true);
    assert.equal(r.ok, true);
    assert.equal(r.code, "satisfied");
    assert.equal(r.blockingSignals.length, 0);
    // The dirt is reported as an advisory signal but never enters the block set.
    assert.ok(r.verdict.signals.some((s) => s.code === "dirty-worktree"));
    assert.equal(r.verdict.audit.blockingSignals.length, 0);
    assert.match(r.reason, /context authorized \(session-init\)/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("wrong-branch lineage is a split-brain block at trigger pre-edit — divergence blocks at every trigger", () => {
  delete process.env.GZDS_OVERRIDE;
  const repo = makeTempRepo();
  try {
    const r = checkRepoAuthority({
      cwd: repo.dir,
      dispatchedLineage: { root: repo.dir, branch: "not-the-current-branch" },
      trigger: "pre-edit",
    });
    assert.equal(r.allowed, false);
    assert.equal(r.ok, false);
    assert.equal(r.code, "violation");
    assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED);
    assert.equal(r.verdict.riskBand, "block");
    assert.ok(r.blockingSignals.some((s) => s.code === "branch-mismatch"));
    assert.ok(r.verdict.audit.blockingSignals.includes("branch-mismatch"));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("no dispatched lineage is allowed — with nothing to diverge from there is no split-brain", () => {
  delete process.env.GZDS_OVERRIDE;
  const repo = makeTempRepo();
  try {
    const r = checkRepoAuthority({ cwd: repo.dir, dispatchedLineage: null, trigger: "pre-edit" });
    assert.equal(r.allowed, true);
    assert.equal(r.ok, true);
    assert.equal(r.code, "satisfied");
    assert.equal(r.blockingSignals.length, 0);
    // The absent lineage is surfaced as a non-blocking advisory signal.
    assert.ok(r.verdict.signals.some((s) => s.code === "no-dispatched-lineage"));
    assert.equal(r.verdict.audit.blockingSignals.length, 0);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("matching lineage on a clean worktree authorizes at trigger pre-edit", () => {
  delete process.env.GZDS_OVERRIDE;
  const repo = makeTempRepo();
  try {
    const r = checkRepoAuthority({
      cwd: repo.dir,
      dispatchedLineage: { root: repo.dir, branch: repo.branch },
      trigger: "pre-edit",
    });
    assert.equal(r.allowed, true);
    assert.equal(r.code, "satisfied");
    assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.AUTHORIZED);
    assert.equal(r.blockingSignals.length, 0);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("wrong-branch with a substantive GZDS_OVERRIDE converts the block to an audited pass and appends to the temp repo ledger", () => {
  const repo = makeTempRepo();
  process.env.GZDS_OVERRIDE = "operator ratified branch override";
  try {
    const r = checkRepoAuthority({
      cwd: repo.dir,
      dispatchedLineage: { root: repo.dir, branch: "not-the-current-branch" },
      trigger: "session-init",
    });
    assert.equal(r.allowed, true);
    assert.equal(r.ok, true);
    assert.equal(r.overridden, true);
    assert.equal(r.code, "overridden");
    assert.match(r.reason, /overridden: operator ratified branch override/);
    // The override must be audited to <temp>/core/governance/compiler/audit/overrides.jsonl.
    const ledgerPath = join(repo.dir, "core", "governance", "compiler", "audit", "overrides.jsonl");
    const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
    assert.equal(ledgerLines.length, 1);
    const record = JSON.parse(ledgerLines[0]);
    assert.equal(record.obligation, REPO_AUTHORITY_OBLIGATION);
    assert.equal(record.override_reason, "operator ratified branch override");
  } finally {
    delete process.env.GZDS_OVERRIDE;
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
