// illuci/core/governance/gitops/repo-context-probe.js
//
// Impure host-side probe for the Std 12 repo-authority atom. This is the ONLY
// piece of the worktree/filesystem context-enforcement mechanism that touches
// git or the filesystem. It gathers facts and returns them; it makes no
// decisions, emits no verdicts, and mutates nothing (read-only git, no network
// fetch). The pure worktree-context-classifier consumes the fact object this
// produces. Exec + porcelain-parse patterns mirror core/sandbox/hygiene.js and
// core/governance/target.js.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const REPO_CONTEXT_FACTS_SCHEMA = "illuci.gitops.repo-context-facts/1";

function runGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function safeRealpath(targetPath) {
  if (!targetPath) return null;
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function firstLine(raw) {
  return raw == null ? null : String(raw).split(/\r?\n/)[0].trim() || null;
}

// Porcelain parser for `git worktree list --porcelain` (mirrors hygiene.js).
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
    } else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (current && key === "bare") current.bare = true;
    else if (current && key === "detached") current.detached = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function parseRemotes(raw) {
  const remotes = {};
  if (!raw) return remotes;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) remotes[m[1]] = m[2];
  }
  return remotes;
}

// `rev-list --left-right --count @{upstream}...HEAD` -> "<behind>\t<ahead>".
function parseAheadBehind(raw) {
  if (!raw) return { ahead: 0, behind: 0 };
  const [behind, ahead] = raw.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { ahead: ahead || 0, behind: behind || 0 };
}

function normalizeDispatched(dispatchedLineage, cwd) {
  if (!dispatchedLineage || typeof dispatchedLineage !== "object") return null;
  const root = dispatchedLineage.root || dispatchedLineage.canonicalRoot || null;
  const wt = dispatchedLineage.worktreePath || dispatchedLineage.worktree || null;
  return {
    canonicalRoot: root ? safeRealpath(resolve(cwd, root)) : null,
    branch: dispatchedLineage.branch ? String(dispatchedLineage.branch).replace(/^refs\/heads\//, "") : null,
    worktreePath: wt ? safeRealpath(resolve(cwd, wt)) : null,
    remote: dispatchedLineage.remote ? String(dispatchedLineage.remote) : null,
  };
}

function emptyMatches() {
  return { root: null, branch: null, worktree: null, remote: null };
}

/**
 * Gather read-only git/filesystem facts about the current repository context
 * versus the dispatched lineage. Never throws; partial failures land in
 * probeMeta.errors. No mutations, no network.
 *
 * @param {{cwd?: string, dispatchedLineage?: {root?:string, branch?:string, worktreePath?:string, remote?:string}|null}} [options]
 * @returns {object} a illuci.gitops.repo-context-facts/1 fact object
 */
export function gatherRepoContextFacts(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const errors = [];
  const dispatched = normalizeDispatched(options.dispatchedLineage, cwd);

  const topRaw = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const isGitRepo = topRaw != null;
  const repoRoot = isGitRepo ? safeRealpath(firstLine(topRaw)) : null;

  if (!isGitRepo) {
    errors.push("not-a-git-repo");
    return {
      schema: REPO_CONTEXT_FACTS_SCHEMA,
      cwd,
      actual: {
        isGitRepo: false, repoRoot: null, currentBranch: null, headSha: null,
        isDetached: false, worktreePath: null, isLinkedWorktree: false,
        worktrees: [], dirty: false, dirtyCount: 0, hasUntracked: false,
        ahead: 0, behind: 0, upstream: null, remotes: {}, stashCount: 0,
      },
      dispatched,
      // With no repo, a supplied lineage cannot be satisfied -> explicit false, not null.
      matches: dispatched ? { root: false, branch: false, worktree: false, remote: false } : emptyMatches(),
      branchWorktreeMap: {},
      probeMeta: { gitAvailable: false, errors },
    };
  }

  const abbrev = firstLine(runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const isDetached = abbrev === "HEAD" || abbrev == null;
  const currentBranch = isDetached ? null : abbrev;
  const headSha = firstLine(runGit(cwd, ["rev-parse", "HEAD"]));

  const worktrees = parseWorktrees(runGit(cwd, ["worktree", "list", "--porcelain"])).map((w) => {
    const path = safeRealpath(w.path);
    return {
      path,
      branch: w.branch,
      head: w.head,
      isDetached: w.detached,
      bare: w.bare,
      isCurrent: path === repoRoot,
    };
  });
  const currentWt = worktrees.find((w) => w.isCurrent) || null;
  const worktreePath = currentWt ? currentWt.path : repoRoot;
  const mainWt = worktrees.find((w) => !w.bare) || null;
  const isLinkedWorktree = Boolean(mainWt && worktreePath && mainWt.path !== worktreePath);

  const statusLines = (runGit(cwd, ["status", "--porcelain"]) || "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const dirty = statusLines.length > 0;
  const hasUntracked = statusLines.some((l) => l.startsWith("??"));

  const upstream = firstLine(runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
  const { ahead, behind } = upstream
    ? parseAheadBehind(runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]))
    : { ahead: 0, behind: 0 };

  const remotes = parseRemotes(runGit(cwd, ["remote", "-v"]));
  const stashCount = (runGit(cwd, ["stash", "list"]) || "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0).length;

  const branchWorktreeMap = {};
  for (const w of worktrees) {
    if (!w.branch) continue;
    (branchWorktreeMap[w.branch] ||= []).push(w.path);
  }

  const matches = dispatched
    ? {
        root: dispatched.canonicalRoot == null ? null : dispatched.canonicalRoot === repoRoot,
        branch: dispatched.branch == null ? null : dispatched.branch === currentBranch,
        worktree: dispatched.worktreePath == null ? null : dispatched.worktreePath === worktreePath,
        remote: dispatched.remote == null ? null : Object.keys(remotes).includes(dispatched.remote),
      }
    : emptyMatches();

  return {
    schema: REPO_CONTEXT_FACTS_SCHEMA,
    cwd,
    actual: {
      isGitRepo: true, repoRoot, currentBranch, headSha, isDetached,
      worktreePath, isLinkedWorktree, worktrees,
      dirty, dirtyCount: statusLines.length, hasUntracked,
      ahead, behind, upstream, remotes, stashCount,
    },
    dispatched,
    matches,
    branchWorktreeMap,
    probeMeta: { gitAvailable: true, errors },
  };
}

export default { REPO_CONTEXT_FACTS_SCHEMA, gatherRepoContextFacts };
