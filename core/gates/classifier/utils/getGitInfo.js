/**
 * illuci — Action Classifier · getGitInfo
 *
 * Resolve a path's git / worktree root.
 *
 * THE WORKTREE PIN: this is the heuristic that catches the exact failure that
 * corrupted a prior run — an agent trusting its shell cwd over the real git
 * topology and writing into the WRONG worktree. A linked worktree's `.git` is a
 * FILE (a gitdir pointer), not a directory, so a naive walk-up `.git`-directory
 * scan resolves to the MAIN checkout and silently mis-attributes the action.
 * We therefore ask git itself: `git rev-parse --show-toplevel`, run WITH the
 * target's own directory as cwd, which returns that path's actual worktree root.
 *
 * Mirrors sandbox/workspace.js getRepoRoot (the same `--show-toplevel` query),
 * adding: resolved-dir caching, Windows case-normalization, and null-on-failure
 * so the caller treats an unknown root safely (fail-closed at the classifier).
 *
 * @module core/gates/classifier/utils/getGitInfo
 */

import { execFileSync } from "child_process";
import { statSync } from "fs";
import { resolve, dirname } from "path";
import { gitCacheMax } from "../config.js";

/**
 * Resolved-dir → worktree-root cache. Insertion-ordered (Map), evict-oldest
 * when over the configured ceiling. Cache key is the normalized directory the
 * git query runs from; value is the normalized worktree root (or null).
 *
 * @type {Map<string, string|null>}
 */
const gitRootCache = new Map();

/** Exposed for hermetic tests — clears the resolution cache. */
export function _clearGitInfoCache() {
  gitRootCache.clear();
}

/**
 * Windows is case-insensitive on paths; normalize so two spellings of the same
 * directory compare equal. On POSIX, case is significant — leave it untouched.
 * Also unifies separators so a back-slash and forward-slash spelling match.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePathForCompare(p) {
  if (typeof p !== "string") return "";
  const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Resolve the directory a git query should run from, for a given target path.
 * For a file (or a not-yet-existing path) we use its parent dir; for an
 * existing directory we use it directly. Resolution never throws — a path that
 * cannot be stat'd is treated as a file and its parent dir is used.
 *
 * @param {string} targetPath
 * @returns {string} absolute directory
 */
function queryDirFor(targetPath) {
  const abs = resolve(targetPath);
  try {
    if (statSync(abs).isDirectory()) return abs;
  } catch {
    // doesn't exist yet (e.g. a file_write target) — query from its parent
  }
  return dirname(abs);
}

/**
 * Get the git/worktree root that OWNS a target path.
 *
 * @param {string} targetPath — file or directory path (absolute or relative)
 * @returns {{ worktreeRoot: string|null, normalizedRoot: string|null, queryDir: string }}
 *   worktreeRoot — the raw `git rev-parse --show-toplevel` output, or null on
 *   any git failure (not a repo, git absent, etc.).
 *   normalizedRoot — case/separator-normalized form for comparison, or null.
 *   queryDir — the absolute directory the query ran from (for audit).
 */
export function getGitInfo(targetPath) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return { worktreeRoot: null, normalizedRoot: null, queryDir: "" };
  }

  const queryDir = queryDirFor(targetPath);
  const cacheKey = normalizePathForCompare(queryDir);

  if (gitRootCache.has(cacheKey)) {
    const cached = gitRootCache.get(cacheKey);
    return {
      worktreeRoot: cached,
      normalizedRoot: cached == null ? null : normalizePathForCompare(cached),
      queryDir,
    };
  }

  let worktreeRoot = null;
  try {
    worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: queryDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!worktreeRoot) worktreeRoot = null;
  } catch {
    // Not a git repo, git unavailable, or the dir doesn't exist — unknown root.
    worktreeRoot = null;
  }

  // Insert with evict-oldest when over the ceiling.
  const max = gitCacheMax();
  if (gitRootCache.size >= max) {
    const oldest = gitRootCache.keys().next().value;
    if (oldest !== undefined) gitRootCache.delete(oldest);
  }
  gitRootCache.set(cacheKey, worktreeRoot);

  return {
    worktreeRoot,
    normalizedRoot: worktreeRoot == null ? null : normalizePathForCompare(worktreeRoot),
    queryDir,
  };
}

export default { getGitInfo, normalizePathForCompare, _clearGitInfoCache };
