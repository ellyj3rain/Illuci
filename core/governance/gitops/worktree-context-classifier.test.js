import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORKTREE_CONTEXT_DISPOSITIONS,
  classifyWorktreeContext,
} from "./worktree-context-classifier.js";

// A canonical clean fact object where actual context exactly matches the
// dispatched lineage. Individual tests spread over this and override the one
// field under test so the distinguishing signal is isolated.
function cleanFacts(overrides = {}) {
  const base = {
    cwd: "/repo/wt/feature",
    actual: {
      isGitRepo: true,
      repoRoot: "/repo",
      currentBranch: "feature/x",
      isDetached: false,
      worktreePath: "/repo/wt/feature",
      worktrees: [{ path: "/repo/wt/feature", branch: "feature/x", isCurrent: true }],
      dirty: false,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      upstream: "origin/feature/x",
      remotes: { origin: "git@host:repo.git" },
      stashCount: 0,
    },
    dispatched: {
      canonicalRoot: "/repo",
      branch: "feature/x",
      worktreePath: "/repo/wt/feature",
      remote: "origin",
    },
    matches: { root: true, branch: true, worktree: true, remote: true },
    branchWorktreeMap: { "feature/x": ["/repo/wt/feature"] },
  };
  return {
    ...base,
    ...overrides,
    actual: { ...base.actual, ...(overrides.actual || {}) },
    dispatched:
      overrides.dispatched === null
        ? null
        : { ...base.dispatched, ...(overrides.dispatched || {}) },
    matches: { ...base.matches, ...(overrides.matches || {}) },
    branchWorktreeMap: overrides.branchWorktreeMap || base.branchWorktreeMap,
  };
}

test("clean actual context matching dispatched lineage is authorized and allowed", () => {
  const r = classifyWorktreeContext(cleanFacts());
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.AUTHORIZED);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-authorized");
  assert.equal(r.next, "proceed");
  assert.equal(r.riskBand, "clear");
  assert.equal(r.signals.length, 0);
  assert.match(r.evidence, /matches dispatched lineage/);
});

test("actual repo root differing from dispatched canonical root is blocked", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { repoRoot: "/other-repo" },
    matches: { root: false },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-blocked");
  assert.equal(r.riskBand, "block");
  assert.ok(r.signals.some((s) => s.code === "repo-root-mismatch"));
  assert.ok(r.audit.blockingSignals.includes("repo-root-mismatch"));
});

test("active branch differing from dispatched branch is blocked", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { currentBranch: "feature/y" },
    matches: { branch: false },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-blocked");
  assert.equal(r.riskBand, "block");
  assert.ok(r.signals.some((s) => s.code === "branch-mismatch"));
  assert.ok(r.audit.blockingSignals.includes("branch-mismatch"));
});

test("active worktree path differing from dispatched worktree is blocked", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { worktreePath: "/repo/wt/other" },
    matches: { worktree: false },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-blocked");
  assert.equal(r.riskBand, "block");
  assert.ok(r.signals.some((s) => s.code === "worktree-mismatch"));
  assert.ok(r.audit.blockingSignals.includes("worktree-mismatch"));
});

test("a nested shadow repo below the canonical root is a split-brain block", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { shadowRepos: ["/repo/wt/feature/vendor/.git"] },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-blocked");
  assert.equal(r.riskBand, "block");
  assert.ok(r.signals.some((s) => s.code === "shadow-repo-detected"));
  assert.ok(r.audit.blockingSignals.includes("shadow-repo-detected"));
});

test("absent dispatched lineage is advisory, not blocking — nothing to diverge from", () => {
  const r = classifyWorktreeContext(cleanFacts({ dispatched: null }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.ok(r.signals.some((s) => s.code === "no-dispatched-lineage"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("cwd outside any git working tree is advisory, not blocking — nothing to verify", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { isGitRepo: false },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.ok(r.signals.some((s) => s.code === "not-a-git-repo"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("dirty worktree with clean identity is a non-blocking advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { dirty: true, dirtyCount: 3 },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "caution");
  assert.ok(r.signals.some((s) => s.code === "dirty-worktree"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("detached HEAD with clean identity is a non-blocking advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { isDetached: true },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((s) => s.code === "detached-head"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("local branch behind upstream with clean identity is a non-blocking advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { behind: 2 },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((s) => s.code === "worktree-behind"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("local branch ahead of upstream with clean identity is a non-blocking state advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { ahead: 4 },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((s) => s.code === "worktree-ahead"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("dispatched remote not configured is a non-blocking advisory, not operator review", () => {
  const r = classifyWorktreeContext(cleanFacts({
    matches: { remote: false },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((s) => s.code === "remote-mismatch"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("same branch checked out in multiple worktrees is a watch-level advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    branchWorktreeMap: { "feature/x": ["/repo/wt/feature", "/repo/wt/dup"] },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((s) => s.code === "multiple-worktrees-same-branch"));
  assert.equal(r.audit.blockingSignals.length, 0);
});

test("stash present with clean identity is a non-blocking info advisory", () => {
  const r = classifyWorktreeContext(cleanFacts({
    actual: { stashCount: 2 },
  }));
  assert.equal(r.decision, WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.code, "worktree-context-advisory");
  assert.equal(r.riskBand, "clear");
  assert.ok(r.signals.some((s) => s.code === "stash-present"));
  assert.equal(r.audit.blockingSignals.length, 0);
});
