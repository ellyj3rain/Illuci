/**
 * illuci — Sandboxed Concurrent Execution Workspace
 *
 * When a topology enters a parallel write-mode phase, the runner creates
 * a git branch or worktree per seat. Each agent writes concurrently in
 * its own isolated sandbox. No conflicts. No stepping on each other.
 *
 * This is how real dev teams work: multiple developers write concurrently
 * on feature branches, open PRs, review each other's diffs, and merge
 * through governance.
 *
 * Attribution: all foundational concepts operator-originated.
 *
 * @module core/sandbox/workspace
 */

import { execSync, execFileSync } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { appendEvent } from "./git.js";
import { emit } from "../events/emitter.js";
import { SANDBOX_BRANCH_PREFIX, SANDBOX_DIR_NAME } from "./hygiene.js";

/** @type {Map<string, SandboxInfo>} seatId → sandbox state */
const activeSandboxes = new Map();

/**
 * @typedef {Object} SandboxInfo
 * @property {string} seatId
 * @property {string} modelId
 * @property {string} baseBranch
 * @property {string} branch - The sandbox branch name
 * @property {string} workdir - Absolute path to the worktree directory
 * @property {string} repoRoot - Absolute path to the owning repository
 * @property {string} createdAt
 * @property {string} status - "active" | "merged" | "rejected" | "cleaned"
 */

/**
 * Get the repo root by running git rev-parse.
 * @returns {string}
 */
function getRepoRoot(fromDir) {
  // When a baseDir is given (e.g. an OTL consumer passing the operator's
  // workspaceRoot), resolve the repo from THERE, not from the host process cwd.
  // That is the split-brain fix: the worktree is carved from the workspace the
  // agent actually operates on, so its work is visible and mergeable there.
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
    ...(fromDir ? { cwd: fromDir } : {}),
  }).trim();
}

function summarizeDiff(diff) {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }

  return { additions, deletions };
}

/**
 * Create an isolated sandbox (git worktree + branch) for a seat.
 *
 * @param {string} seatId - The topology seat creating the sandbox
 * @param {string} modelId - The model assigned to this seat
 * @param {string} [baseBranch] - The branch to base the sandbox on
 * @param {string} [baseDir] - Resolve the repo root from here (the operator's
 *   workspaceRoot) instead of the host process cwd. Omit for the in-repo runner
 *   callers (back-compat). This is the consumer-side split-brain fix.
 * @returns {{ workdir: string, branch: string }}
 */
export function createSandbox(seatId, modelId, baseBranch, baseDir) {
  if (!seatId) throw new Error("seatId required");
  if (!modelId) throw new Error("modelId required");

  const repoRoot = getRepoRoot(baseDir);
  const timestamp = Date.now().toString(36);
  const safeSeat = seatId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const branch = `${SANDBOX_BRANCH_PREFIX}${safeSeat}-${timestamp}`;
  const workdir = resolve(repoRoot, SANDBOX_DIR_NAME, `${safeSeat}-${timestamp}`);

  // Ensure the sandbox directory parent exists
  mkdirSync(resolve(repoRoot, SANDBOX_DIR_NAME), { recursive: true });

  // Create the worktree with a new branch from baseBranch
  const base = baseBranch || "HEAD";
  if (!/^[a-zA-Z0-9_\-./]+$/.test(base)) {
    throw new Error(`Invalid baseBranch: ${base}`);
  }
  const addWorktree = () => execFileSync('git', ['worktree', 'add', '-b', branch, workdir, base], {
    cwd: repoRoot, encoding: "utf-8", stdio: "pipe",
  });
  // Prune stale worktree registrations first — accumulated .illuci-sandboxes entries
  // from prior runs otherwise make `git worktree add` fail ("cannot create submodule
  // directory" / "Could not reset index"). Best-effort; never fatal on its own.
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: "pipe" }); } catch {}
  try {
    addWorktree();
  } catch (err) {
    // One self-heal retry after a harder prune, then surface the real failure so the
    // caller can HARD-HALT rather than silently degrade to the unsandboxed workspace.
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: "pipe" });
      addWorktree();
    } catch (err2) {
      throw new Error(`Failed to create sandbox worktree: ${err2.stderr || err2.message}`);
    }
  }

  const info = {
    seatId,
    modelId,
    baseBranch: baseBranch || "HEAD",
    branch,
    workdir,
    repoRoot,
    createdAt: new Date().toISOString(),
    status: "active",
  };

  activeSandboxes.set(seatId, info);

  // Log branch creation to VCS ledger (best-effort — don't block sandbox creation)
  try {
    appendEvent(info.pipelineId || "default", {
      type: "branch_created",
      agent: modelId,
      seat: seatId,
      branch,
    });
  } catch {}

  emit({
    type: "sandbox_branch_created",
    payload: {
      seatId,
      modelId,
      branch,
      baseBranch: info.baseBranch,
    },
  });

  return { workdir, branch };
}

/**
 * Get the sandbox info for a seat.
 * @param {string} seatId
 * @returns {SandboxInfo|null}
 */
export function getSandbox(seatId) {
  return activeSandboxes.get(seatId) || null;
}

/**
 * List all active sandboxes.
 * @returns {SandboxInfo[]}
 */
export function listSandboxes() {
  return [...activeSandboxes.values()];
}

/**
 * Get the diff for a sandbox (changes relative to base branch).
 *
 * @param {string} seatId
 * @returns {{ diff: string, filesChanged: string[] }}
 */
export function getSandboxDiff(seatId) {
  const info = activeSandboxes.get(seatId);
  if (!info) throw new Error(`No sandbox for seat: ${seatId}`);

  try {
    const diff = execSync(
      `git diff ${info.baseBranch}...${info.branch}`,
      { cwd: info.workdir, encoding: "utf-8", stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
    );

    const filesChanged = execSync(
      `git diff --name-only ${info.baseBranch}...${info.branch}`,
      { cwd: info.workdir, encoding: "utf-8", stdio: "pipe" }
    ).trim().split("\n").filter(Boolean);

    return { diff, filesChanged };
  } catch (err) {
    return { diff: "", filesChanged: [] };
  }
}

/**
 * Commit all changes in a sandbox.
 *
 * @param {string} seatId
 * @param {string} message
 * @returns {{ committed: boolean, hash: string|null }}
 */
export function commitSandbox(seatId, message) {
  const info = activeSandboxes.get(seatId);
  if (!info) throw new Error(`No sandbox for seat: ${seatId}`);

  try {
    execSync("git add -A", { cwd: info.workdir, stdio: "pipe" });

    const status = execSync("git status --porcelain", { cwd: info.workdir, encoding: "utf-8", stdio: "pipe" }).trim();
    if (!status) return { committed: false, hash: null };

    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: info.workdir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const hash = execSync("git rev-parse HEAD", {
      cwd: info.workdir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    const diff = execSync(
      `git diff ${info.baseBranch}...${info.branch}`,
      { cwd: info.workdir, encoding: "utf-8", stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
    );
    const filesChanged = execSync(
      `git diff --name-only ${info.baseBranch}...${info.branch}`,
      { cwd: info.workdir, encoding: "utf-8", stdio: "pipe" }
    ).trim().split("\n").filter(Boolean);
    const commitCount = parseInt(execSync(
      `git rev-list --count ${info.baseBranch}..${info.branch}`,
      { cwd: info.workdir, encoding: "utf-8", stdio: "pipe" }
    ).trim(), 10) || 1;
    const { additions, deletions } = summarizeDiff(diff);

    // Log commit to VCS ledger
    try {
      const changedSinceLastCommit = execSync("git diff --name-only HEAD~1", {
        cwd: info.workdir, encoding: "utf-8", stdio: "pipe",
      }).trim().split("\n").filter(Boolean);

      appendEvent(info.pipelineId || "default", {
        type: "commit",
        agent: info.modelId,
        branch: info.branch,
        message,
        files: changedSinceLastCommit,
        hash,
      });
    } catch {}

    emit({
      type: "sandbox_branch_updated",
      payload: {
        seatId,
        modelId: info.modelId,
        branch: info.branch,
        hash,
        commitCount,
        filesChanged,
        additions,
        deletions,
      },
    });

    return { committed: true, hash };
  } catch (err) {
    return { committed: false, hash: null };
  }
}

/**
 * Clean up a sandbox — remove the worktree and optionally delete the branch.
 *
 * @param {string} seatId
 * @param {Object} [options]
 * @param {boolean} [options.deleteBranch=false] - Also delete the sandbox branch
 * @returns {{ cleaned: boolean }}
 */
export function cleanupSandbox(seatId, options = {}) {
  const info = activeSandboxes.get(seatId);
  if (!info) return { cleaned: false };

  const repoRoot = info.repoRoot || getRepoRoot(info.workdir);

  try {
    // Remove worktree
    execFileSync("git", ["worktree", "remove", info.workdir, "--force"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // If worktree remove fails, try manual cleanup
    if (existsSync(info.workdir)) {
      try { rmSync(info.workdir, { recursive: true, force: true }); } catch {}
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" });
    } catch {}
  }

  // Optionally delete the branch
  if (options.deleteBranch) {
    try {
      execFileSync("git", ["branch", "-D", info.branch], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {}

    emit({
      type: "sandbox_branch_deleted",
      payload: {
        seatId,
        modelId: info.modelId,
        branch: info.branch,
      },
    });
  }

  info.status = "cleaned";
  activeSandboxes.delete(seatId);

  return { cleaned: true };
}

/**
 * Clean up all sandboxes.
 */
export function cleanupAllSandboxes() {
  for (const seatId of [...activeSandboxes.keys()]) {
    cleanupSandbox(seatId, { deleteBranch: true });
  }
}

export default {
  createSandbox, getSandbox, listSandboxes,
  getSandboxDiff, commitSandbox,
  cleanupSandbox, cleanupAllSandboxes,
};
