// #67 honesty fix — a non-zero git exit must surface as a FAILURE, never a silent
// success. Before the fix, spawnGit resolved regardless of exit code, so toolGitCommit
// returned { committed: true } and toolGitPush returned { pushed: true } even when the
// underlying git command failed — a false "committed/pushed" signal the agent acts on.
// Hermetic: a real git binary against a throwaway temp repo, no network, no gating.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { spawnGit } from "./tools.js";

const TEMP_ROOTS = [];

function makeTempRepo() {
  const root = mkdtempSync(join(tmpdir(), "illuci-githonest-"));
  TEMP_ROOTS.push(root);
  execFileSync("git", ["init"], { cwd: root });
  // Configure identity so a commit fails specifically for "nothing to commit",
  // not for a missing author — either way it exits non-zero, but this keeps the
  // failure scenario the exact #67 one (a mutating op that did nothing but would
  // have reported committed:true).
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "illuci-test"], { cwd: root });
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length) {
    const root = TEMP_ROOTS.pop();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("spawnGit honest exit (#67)", () => {
  it("REJECTS a failed mutating git command instead of resolving a false success", async () => {
    const repo = makeTempRepo();
    // Nothing is staged, so `git commit` exits non-zero and produces no commit.
    // The pre-fix behavior resolved here, letting toolGitCommit return committed:true.
    await expect(spawnGit(["commit", "-m", "nothing here"], { workspaceRoot: repo })).rejects.toMatchObject({
      exitCode: expect.any(Number),
    });
    // And the exit code carried by the rejection is genuinely non-zero.
    let caught = null;
    try {
      await spawnGit(["commit", "-m", "still nothing"], { workspaceRoot: repo });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.exitCode).not.toBe(0);
    expect(caught.message).toMatch(/git commit failed/i);
  });

  it("RESOLVES a successful git command with exitCode 0 (success path intact)", async () => {
    const repo = makeTempRepo();
    const res = await spawnGit(["status", "--porcelain"], { workspaceRoot: repo });
    expect(res.exitCode).toBe(0);
    expect(typeof res.stdout).toBe("string");
  });

  it("honors allowNonZeroExit for a caller that legitimately reads the exit code", async () => {
    const repo = makeTempRepo();
    // A ref that does not exist: git rev-parse --verify exits non-zero. With the opt-out,
    // spawnGit resolves and hands the exit code back rather than rejecting.
    const res = await spawnGit(["rev-parse", "--verify", "refs/heads/does-not-exist"], {
      workspaceRoot: repo,
      allowNonZeroExit: true,
    });
    expect(res.exitCode).not.toBe(0);
  });
});
