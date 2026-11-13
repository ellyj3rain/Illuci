import { test } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REPO_CONTEXT_FACTS_SCHEMA,
  gatherRepoContextFacts,
} from "./repo-context-probe.js";

// --- hermetic-by-temp-repo helpers ----------------------------------------
// The probe is impure: it shells out to real git. Every test builds its own
// throwaway git repo under os.tmpdir() and removes it afterward, so nothing
// depends on the repo this test file lives in.

function git(dir, args) {
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function makeTempDir() {
  // realpathSync so paths match the probe's own safeRealpath normalization
  // (macOS/Windows temp dirs are symlinked/short-name aliased otherwise).
  return realpathSync(mkdtempSync(join(tmpdir(), "illuci-repo-probe-")));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Initialize a repo on an explicit branch with local identity so commits work
// regardless of the host's global git config, then land one commit.
function initRepoWithCommit(dir, branch) {
  git(dir, ["init", "-b", branch]);
  git(dir, ["config", "user.email", "probe@example.test"]);
  git(dir, ["config", "user.name", "Probe Test"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "-m", "seed commit"]);
}

// --- (1) clean single-commit repo, matching dispatchedLineage --------------

test("a clean single-commit repo on a known branch with a matching lineage reports root and branch matches with a clean tree", () => {
  const dir = makeTempDir();
  try {
    initRepoWithCommit(dir, "work-branch");
    const r = gatherRepoContextFacts({
      cwd: dir,
      dispatchedLineage: { root: dir, branch: "work-branch" },
    });

    assert.equal(r.schema, "illuci.gitops.repo-context-facts/1");
    assert.equal(r.schema, REPO_CONTEXT_FACTS_SCHEMA);
    assert.equal(r.actual.isGitRepo, true);
    assert.equal(r.actual.currentBranch, "work-branch");
    assert.equal(r.actual.isDetached, false);
    assert.equal(r.actual.dirty, false);
    assert.equal(r.actual.dirtyCount, 0);
    assert.equal(r.matches.root, true);
    assert.equal(r.matches.branch, true);
    assert.equal(r.probeMeta.gitAvailable, true);
    assert.deepEqual(r.probeMeta.errors, []);
  } finally {
    cleanup(dir);
  }
});

// --- (2) dirty repo (untracked file) ---------------------------------------

test("a repo with an untracked file reports a dirty working tree with untracked flag set", () => {
  const dir = makeTempDir();
  try {
    initRepoWithCommit(dir, "work-branch");
    writeFileSync(join(dir, "scratch.txt"), "uncommitted\n");
    const r = gatherRepoContextFacts({ cwd: dir });

    assert.equal(r.actual.dirty, true);
    assert.ok(r.actual.dirtyCount >= 1);
    assert.equal(r.actual.hasUntracked, true);
  } finally {
    cleanup(dir);
  }
});

// --- (3) wrong-branch dispatchedLineage ------------------------------------

test("a dispatchedLineage naming a different branch reports a branch mismatch", () => {
  const dir = makeTempDir();
  try {
    initRepoWithCommit(dir, "work-branch");
    const r = gatherRepoContextFacts({
      cwd: dir,
      dispatchedLineage: { root: dir, branch: "some-other-branch" },
    });

    assert.equal(r.matches.branch, false);
    assert.equal(r.matches.root, true);
  } finally {
    cleanup(dir);
  }
});

// --- (4a) non-git dir with a lineage supplied ------------------------------

test("a non-git directory with a supplied lineage reports no git repo, a not-a-git-repo error, and explicit false matches", () => {
  const dir = makeTempDir();
  try {
    const r = gatherRepoContextFacts({
      cwd: dir,
      dispatchedLineage: { root: dir, branch: "work-branch" },
    });

    assert.equal(r.actual.isGitRepo, false);
    assert.equal(r.actual.repoRoot, null);
    assert.equal(r.probeMeta.gitAvailable, false);
    assert.ok(r.probeMeta.errors.includes("not-a-git-repo"));
    assert.equal(r.matches.root, false);
    assert.equal(r.matches.branch, false);
    assert.equal(r.matches.worktree, false);
    assert.equal(r.matches.remote, false);
  } finally {
    cleanup(dir);
  }
});

// --- (4b) non-git dir with no lineage --------------------------------------

test("a non-git directory with no lineage reports a not-a-git-repo error and null matches", () => {
  const dir = makeTempDir();
  try {
    const r = gatherRepoContextFacts({ cwd: dir });

    assert.equal(r.actual.isGitRepo, false);
    assert.ok(r.probeMeta.errors.includes("not-a-git-repo"));
    assert.equal(r.matches.root, null);
    assert.equal(r.matches.branch, null);
    assert.equal(r.matches.worktree, null);
    assert.equal(r.matches.remote, null);
  } finally {
    cleanup(dir);
  }
});

// --- (5) detached HEAD -----------------------------------------------------

test("a repo checked out at a detached HEAD reports isDetached with a null current branch", () => {
  const dir = makeTempDir();
  try {
    initRepoWithCommit(dir, "work-branch");
    const headSha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    git(dir, ["checkout", "--detach", headSha]);
    const r = gatherRepoContextFacts({ cwd: dir });

    assert.equal(r.actual.isDetached, true);
    assert.equal(r.actual.currentBranch, null);
    assert.equal(r.actual.isGitRepo, true);
  } finally {
    cleanup(dir);
  }
});

// --- (6) linked worktree ---------------------------------------------------

test("a repo entered through a linked worktree reports isLinkedWorktree with a two-entry branch worktree map", () => {
  const mainDir = makeTempDir();
  let linkedParent = null;
  try {
    initRepoWithCommit(mainDir, "work-branch");
    // Place the linked worktree outside mainDir so cleanup is independent and
    // the temp roots do not nest.
    linkedParent = makeTempDir();
    const linkedDir = join(linkedParent, "linked");
    git(mainDir, ["worktree", "add", "-b", "linked-branch", linkedDir]);

    const r = gatherRepoContextFacts({ cwd: linkedDir });

    assert.equal(r.actual.isLinkedWorktree, true);
    assert.equal(r.actual.currentBranch, "linked-branch");
    assert.equal(Object.keys(r.branchWorktreeMap).length, 2);
    assert.ok(Object.prototype.hasOwnProperty.call(r.branchWorktreeMap, "work-branch"));
    assert.ok(Object.prototype.hasOwnProperty.call(r.branchWorktreeMap, "linked-branch"));
  } finally {
    cleanup(mainDir);
    if (linkedParent) cleanup(linkedParent);
  }
});
