import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectSandboxHygiene,
  pruneSandboxHygiene,
  SANDBOX_BRANCH_PREFIX,
  SANDBOX_DIR_NAME,
} from "./hygiene.js";

function tempCommittedRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  execFileSync("git", ["-C", dir, "init"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  execFileSync("git", ["-C", dir, "config", "user.email", "illuci@example.invalid"], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "config", "user.name", "illuci fixture"], { encoding: "utf8" });
  writeFileSync(join(dir, "VERSION"), "0.1.0\n", "utf8");
  execFileSync("git", ["-C", dir, "add", "VERSION"], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, "commit", "-m", "[A0] fixture"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return dir;
}

test("sandbox hygiene reports stale directories and retained branches", () => {
  const dir = tempCommittedRepo("illuci-sandbox-hygiene-");
  try {
    mkdirSync(join(dir, SANDBOX_DIR_NAME, "stale-seat"), { recursive: true });
    execFileSync("git", ["-C", dir, "branch", `${SANDBOX_BRANCH_PREFIX}merged-fixture`], { encoding: "utf8" });

    const hygiene = inspectSandboxHygiene(dir);
    assert.equal(hygiene.schema, "illuci.sandbox.hygiene/1");
    assert.equal(hygiene.counts.staleDirectories, 1);
    assert.equal(hygiene.counts.retainedBranches, 1);
    assert.ok(hygiene.findings.some((finding) => finding.code === "sandbox-directory-stale"));
    assert.ok(hygiene.findings.some((finding) => finding.code === "sandbox-branch-retained"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox hygiene prune removes stale directories and merged retained branches", () => {
  const dir = tempCommittedRepo("illuci-sandbox-prune-");
  try {
    const staleDir = join(dir, SANDBOX_DIR_NAME, "stale-seat");
    mkdirSync(staleDir, { recursive: true });
    const branch = `${SANDBOX_BRANCH_PREFIX}merged-fixture`;
    execFileSync("git", ["-C", dir, "branch", branch], { encoding: "utf8" });

    const pruned = pruneSandboxHygiene(dir, { removeStaleDirectories: true, deleteMergedBranches: true });
    assert.equal(pruned.schema, "illuci.sandbox.prune/1");
    assert.equal(pruned.ok, true);
    assert.equal(existsSync(staleDir), false);
    assert.deepEqual(pruned.deletedBranches, [branch]);
    assert.equal(pruned.after.counts.staleDirectories, 0);
    assert.equal(pruned.after.retainedBranches.includes(branch), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox hygiene keeps registered worktrees out of stale-directory findings", () => {
  const dir = tempCommittedRepo("illuci-sandbox-registered-");
  const worktree = join(dir, SANDBOX_DIR_NAME, "active-seat");
  const branch = `${SANDBOX_BRANCH_PREFIX}active-fixture`;
  try {
    mkdirSync(join(dir, SANDBOX_DIR_NAME), { recursive: true });
    execFileSync("git", ["-C", dir, "worktree", "add", "-b", branch, worktree, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const hygiene = inspectSandboxHygiene(dir);
    assert.equal(hygiene.counts.worktrees, 1);
    assert.equal(hygiene.counts.staleDirectories, 0);
    assert.ok(hygiene.findings.some((finding) => finding.code === "sandbox-worktree-registered"));
  } finally {
    try { execFileSync("git", ["-C", dir, "worktree", "remove", worktree, "--force"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    try { execFileSync("git", ["-C", dir, "branch", "-D", branch], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
