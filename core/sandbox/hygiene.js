import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SANDBOX_DIR_NAME = ".illuci-sandboxes";
export const SANDBOX_BRANCH_PREFIX = "illuci/sandbox/";
export const SANDBOX_HYGIENE_SCHEMA = "illuci.sandbox.hygiene/1";
export const SANDBOX_PRUNE_SCHEMA = "illuci.sandbox.prune/1";

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function runGit(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function parseWorktrees(raw) {
  if (!raw) return [];
  const worktrees = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value, head: null, branch: null, bare: false, detached: false };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "detached") {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function listSandboxBranches(repoRoot) {
  const raw = runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${SANDBOX_BRANCH_PREFIX}`]);
  return (raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => name.startsWith(SANDBOX_BRANCH_PREFIX));
}

function listMergedBranches(repoRoot) {
  const raw = runGit(repoRoot, ["branch", "--merged", "HEAD", "--format=%(refname:short)"]);
  return new Set((raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !/^([a-zA-Z]:)?[\\/]/.test(rel);
}

function listSandboxDirectories(repoRoot, registeredPaths) {
  const sandboxRoot = join(repoRoot, SANDBOX_DIR_NAME);
  if (!existsSync(sandboxRoot)) return [];
  return readdirSync(sandboxRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(sandboxRoot, entry.name);
      return {
        name: entry.name,
        path,
        registered: registeredPaths.has(resolve(path)),
        hasGitPointer: existsSync(join(path, ".git")),
      };
    });
}

function hygieneFinding(severity, code, message, path = null, extra = {}) {
  return { severity, code, message, path, ...extra };
}

export function inspectSandboxHygiene(repoRoot) {
  const root = resolve(repoRoot || process.cwd());
  const sandboxRoot = join(root, SANDBOX_DIR_NAME);
  const rawWorktrees = runGit(root, ["worktree", "list", "--porcelain"]);
  const gitAvailable = rawWorktrees !== null;
  const worktrees = parseWorktrees(rawWorktrees);
  const sandboxWorktrees = worktrees
    .filter((entry) => entry.branch?.startsWith(SANDBOX_BRANCH_PREFIX) || resolve(entry.path).startsWith(resolve(sandboxRoot)))
    .map((entry) => ({ ...entry, path: resolve(entry.path) }));
  const registeredPaths = new Set(sandboxWorktrees.map((entry) => resolve(entry.path)));
  const branches = gitAvailable ? listSandboxBranches(root) : [];
  const branchSet = new Set(branches);
  const worktreeBranchSet = new Set(sandboxWorktrees.map((entry) => entry.branch).filter(Boolean));
  const directories = listSandboxDirectories(root, registeredPaths);
  const staleDirectories = directories.filter((entry) => !entry.registered);
  const retainedBranches = branches.filter((name) => !worktreeBranchSet.has(name));
  const findings = [];

  if (!gitAvailable) {
    findings.push(hygieneFinding("info", "sandbox-git-unavailable", "git worktree metadata is unavailable for sandbox hygiene", root));
  }
  for (const entry of sandboxWorktrees) {
    findings.push(hygieneFinding("info", "sandbox-worktree-registered", `registered sandbox worktree: ${entry.branch || entry.path}`, entry.path, {
      branch: entry.branch || null,
    }));
  }
  for (const entry of staleDirectories) {
    findings.push(hygieneFinding("warning", "sandbox-directory-stale", `stale sandbox directory is not registered as a git worktree: ${entry.name}`, entry.path));
  }
  for (const branch of retainedBranches) {
    findings.push(hygieneFinding("info", "sandbox-branch-retained", `sandbox branch exists without a registered sandbox worktree: ${branch}`, null, { branch }));
  }

  return {
    schema: SANDBOX_HYGIENE_SCHEMA,
    repoRoot: root,
    sandboxRoot,
    sandboxDir: SANDBOX_DIR_NAME,
    branchPrefix: SANDBOX_BRANCH_PREFIX,
    gitAvailable,
    worktrees: sandboxWorktrees,
    branches: [...branchSet].sort(),
    directories,
    staleDirectories,
    retainedBranches,
    findings,
    counts: {
      worktrees: sandboxWorktrees.length,
      branches: branchSet.size,
      directories: directories.length,
      staleDirectories: staleDirectories.length,
      retainedBranches: retainedBranches.length,
    },
  };
}

export function pruneSandboxHygiene(repoRoot, options = {}) {
  const root = resolve(repoRoot || process.cwd());
  const before = inspectSandboxHygiene(root);
  const pruned = [];
  const removedDirectories = [];
  const deletedBranches = [];
  const skippedBranches = [];
  const errors = [];

  const prune = runGit(root, ["worktree", "prune"]);
  if (prune !== null) pruned.push("git-worktree-prune");

  if (options.removeStaleDirectories === true) {
    for (const entry of before.staleDirectories) {
      if (!isInside(before.sandboxRoot, entry.path)) {
        errors.push({ path: entry.path, message: "refused to remove path outside sandbox root" });
        continue;
      }
      try {
        rmSync(entry.path, { recursive: true, force: true });
        removedDirectories.push(entry.path);
      } catch (err) {
        errors.push({ path: entry.path, message: err.message });
      }
    }
  }

  if (options.deleteMergedBranches === true) {
    const afterDirectoryCleanup = inspectSandboxHygiene(root);
    const merged = listMergedBranches(root);
    for (const branch of afterDirectoryCleanup.retainedBranches) {
      if (!merged.has(branch)) {
        skippedBranches.push({ branch, reason: "not-merged" });
        continue;
      }
      const out = runGit(root, ["branch", "-d", branch]);
      if (out === null) skippedBranches.push({ branch, reason: "delete-failed" });
      else deletedBranches.push(branch);
    }
  }

  return {
    schema: SANDBOX_PRUNE_SCHEMA,
    repoRoot: root,
    ok: errors.length === 0,
    pruned,
    removedDirectories,
    deletedBranches,
    skippedBranches,
    errors,
    before,
    after: inspectSandboxHygiene(root),
  };
}

export default {
  SANDBOX_BRANCH_PREFIX,
  SANDBOX_DIR_NAME,
  inspectSandboxHygiene,
  pruneSandboxHygiene,
};
