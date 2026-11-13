// Worktree lifecycle sweep (DR-208; F-148) — operator-ratified 2026-07-16.
//
// Every agent surface that touches a governed repo spawns git worktrees
// (the Claude harness, Codex Desktop, JetBrains Air, bare CLI) and none of
// them owns a lifecycle: sessions end, worktrees persist, and each stale
// checkout is split-brain bait — agents wake in one and trust a repo state
// hundreds of commits behind the authoritative head. The 2026-07-16 manual
// sweep of the illuci repo (22 registered worktrees -> 6, 128 branches -> 79)
// surfaced three hazard classes that make naive cleanup DANGEROUS (F-148):
//
//   1. REPARSE POINTS: session worktrees carried junctions into unrelated
//      real projects (epic-lehmann\gzs -> the operator's GZS-WebDev checkout;
//      a worktree's node_modules -> a SIBLING worktree's node_modules). A
//      recursive delete that follows links eats the target. Links are
//      unlinked LINK-ONLY before any removal, never traversed.
//   2. WINDOWS LONG PATHS: `git worktree remove` de-registers the worktree
//      but fails part-way through deleting node_modules trees, leaving
//      orphan rubble on disk. Removal verifies the directory is GONE and
//      escalates: git -> fs.rm -> (win32) robocopy empty-mirror.
//   3. NO OWNER: orphan shells and long-merged branches accumulate with no
//      lifecycle owner. The sweep prunes registrations and (opt-in) culls
//      branches fully merged into the authoritative head — `-d` only, never
//      force; unmerged commits are never deleted.
//
// Sibling of the DR-200 lane-sandbox sweep (core/bridges/cli-sandbox.js):
// same posture — plan by default, apply is explicit, errors are collected
// and never thrown, and nothing the sweep did not classify is touched.
//
// PRESERVE-THE-DELIVERABLE ([A116]/DR-203): a dirty worktree is KEPT by
// default. With the explicit quarantine control, its dirty/untracked files
// are copied to a manifest-carrying quarantine directory BEFORE removal —
// archival, never silent destruction.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const WORKTREE_SWEEP_SCHEMA = "illuci.governance.worktree-sweep/1";

/** Disclosed defaults (DR-208; the defaults-registry `worktree-sweep` row). */
export const WORKTREE_SWEEP_DEFAULTS = Object.freeze({
  minAgeDays: 7,
  minBehind: 1,
  apply: false,
  keepDirty: true,
  branches: false,
  reparseScanDepth: 2,
});

/** Refs tried, in order, when no --against is given. */
export const WORKTREE_SWEEP_AGAINST_CANDIDATES = Object.freeze([
  "zero/main",
  "origin/main",
  "main",
]);

function runGit(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "").trim() || `git ${args.join(" ")} exited ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.stdout;
}

function tryGit(args, cwd) {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}

/** Case-insensitive on win32 — worktree paths compare as the filesystem does. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Parse `git worktree list --porcelain` into entries. The first entry is the
 * main worktree (git documents this ordering).
 * @param {string} repoDir
 * @returns {{path: string, head: string|null, branch: string|null, detached: boolean, locked: boolean, prunable: boolean}[]}
 */
export function listRegisteredWorktrees(repoDir) {
  const out = runGit(["worktree", "list", "--porcelain"], repoDir);
  const entries = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, detached: false, locked: false, prunable: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  return entries;
}

/**
 * Resolve the authoritative ref the sweep classifies against.
 * @param {string} repoDir
 * @param {string} [explicit]
 * @returns {string|null} a verified committish, or null when none resolves
 */
export function resolveAgainstRef(repoDir, explicit) {
  const candidates = explicit ? [explicit] : WORKTREE_SWEEP_AGAINST_CANDIDATES;
  for (const ref of candidates) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoDir) != null) return ref;
  }
  return null;
}

/**
 * Reparse points (junctions / symlinks) under a worktree, shallow scan.
 * Node reports Windows junctions as symbolic links via lstat, so one check
 * covers both platforms. The scan never descends INTO a link, never descends
 * into node_modules or .git (their own entries are still lstat-checked at
 * their level — the F-148 node_modules junction sat at depth 1).
 * @param {string} root
 * @param {number} maxDepth
 * @returns {{path: string, target: string|null}[]}
 */
export function findReparsePoints(root, maxDepth = WORKTREE_SWEEP_DEFAULTS.reparseScanDepth) {
  const found = [];
  const walk = (dir, depth) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = null;
        try {
          target = readlinkSync(p);
        } catch {
          /* target unreadable — still a link, still unlink-only */
        }
        found.push({ path: p, target });
        continue;
      }
      if (st.isDirectory() && name !== "node_modules" && depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * Remove a reparse point LINK-ONLY. rmdir on a directory junction/symlink
 * removes the link and never touches the target; unlink covers file links.
 * @param {string} p
 * @returns {boolean}
 */
export function unlinkReparsePoint(p) {
  try {
    rmdirSync(p);
    return true;
  } catch {
    /* not a dir link — try file link */
  }
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyFilterSkipHeavy(src) {
  const name = basename(src);
  return name !== "node_modules" && name !== ".git";
}

/**
 * Quarantine a worktree's dirty + untracked files (preserve-the-deliverable,
 * [A116]): copy each porcelain-listed path that still exists into
 * quarantineRoot/<worktree-name>/, skipping node_modules/.git subtrees, and
 * write a MANIFEST.txt recording worktree, HEAD, branch, and the porcelain
 * listing. Copies only — the worktree itself is untouched here.
 * @param {{path: string, head: string|null, branch: string|null}} entry
 * @param {string} quarantineRoot
 * @returns {{copied: number, skipped: number, manifestPath: string}}
 */
export function quarantineWorktree(entry, quarantineRoot) {
  const wt = entry.path;
  const dest = join(quarantineRoot, basename(wt));
  mkdirSync(dest, { recursive: true });

  const zOut = runGit(["status", "--porcelain=v1", "-z"], wt);
  const tokens = zOut.split("\0").filter((t) => t.length > 0);
  const rels = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const xy = token.slice(0, 2);
    const rel = token.slice(3);
    rels.push({ xy, rel });
    // Rename/copy entries carry the ORIG path as the next NUL token.
    if (xy.includes("R") || xy.includes("C")) i += 1;
    i += 1;
  }

  let copied = 0;
  let skipped = 0;
  for (const { rel } of rels) {
    const src = join(wt, rel);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue; // deleted-status entries have nothing to copy
    }
    const name = basename(rel.replace(/[\\/]+$/, ""));
    if (name === "node_modules" || name === ".git") {
      skipped += 1;
      continue;
    }
    const dst = join(dest, rel);
    try {
      if (st.isDirectory()) {
        cpSync(src, dst, { recursive: true, force: true, filter: copyFilterSkipHeavy });
      } else if (st.isSymbolicLink()) {
        skipped += 1; // never copy through a link
        continue;
      } else {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      }
      copied += 1;
    } catch {
      skipped += 1;
    }
  }

  const manifestPath = join(dest, "MANIFEST.txt");
  const porcelainText = tryGit(["status", "--porcelain"], wt) ?? "";
  writeFileSync(
    manifestPath,
    [
      `worktree: ${wt}`,
      `HEAD: ${entry.head ?? "?"}  branch: ${entry.branch ?? "(detached)"}`,
      `quarantined: ${new Date().toISOString()}`,
      "",
      porcelainText.trimEnd(),
      "",
    ].join("\n"),
  );
  return { copied, skipped, manifestPath };
}

/**
 * Delete a de-registered worktree directory, verifying it is actually gone
 * (F-148 hazard 2). Escalation: fs.rm -> (win32) robocopy empty-mirror ->
 * final verification. Returns the method that emptied it, or null.
 * @param {string} dir
 * @returns {string|null}
 */
function removeDirectoryVerified(dir) {
  if (!existsSync(dir)) return "git";
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* fall through to the long-path fallback */
  }
  if (!existsSync(dir)) return "fs.rm";
  if (process.platform === "win32") {
    let empty = null;
    try {
      empty = mkdtempSync(join(tmpdir(), "illuci-wt-sweep-empty-"));
      const res = spawnSync(
        "robocopy",
        [empty, dir, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"],
        { encoding: "utf8", windowsHide: true },
      );
      // robocopy: exit codes 0-7 are success classes.
      if (typeof res.status === "number" && res.status <= 7) {
        try {
          rmdirSync(dir);
        } catch {
          /* verified below */
        }
      }
    } finally {
      if (empty) rmSync(empty, { recursive: true, force: true });
    }
  }
  return existsSync(dir) ? null : "robocopy";
}

function normalizePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Sweep the registered git worktrees of a governed repo.
 *
 * SAFETY (absolute): the main worktree, the invoking worktree, locked
 * worktrees, and any worktree carrying commits not reachable from the
 * authoritative ref are NEVER swept, under any flag combination. Dirty
 * worktrees are kept unless the explicit quarantine control is set, and are
 * quarantined (copies + manifest) before removal. Reparse points inside a
 * target are unlinked link-only before deletion. Plan mode (the default)
 * computes verdicts and deletes nothing.
 *
 * @param {object} [options]
 * @param {string}  [options.repoDir=process.cwd()] — any checkout of the repo
 * @param {string}  [options.againstRef] — authoritative ref (default: zero/main -> origin/main -> main)
 * @param {number}  [options.minAgeDays=7] — min age (max of HEAD commit time and dir mtime)
 * @param {number}  [options.minBehind=1] — min commits behind the ref
 * @param {boolean} [options.apply=false] — execute; default is report/plan
 * @param {boolean} [options.quarantineAndSweep=false] — quarantine dirty targets, then sweep them
 * @param {string}  [options.quarantineRoot] — default <repo parent>/worktree-quarantine-<yyyymmdd>
 * @param {boolean} [options.branches=false] — also cull local branches fully merged into the ref (`-d` only)
 * @param {string}  [options.cwd=process.cwd()] — the invoking location (its worktree is protected)
 * @returns {object} report (schema illuci.governance.worktree-sweep/1)
 */
export function sweepWorktrees(options = {}) {
  const apply = options.apply === true;
  const quarantineAndSweep = options.quarantineAndSweep === true;
  const branches = options.branches === true;
  const minAgeDays = normalizePositive(options.minAgeDays, WORKTREE_SWEEP_DEFAULTS.minAgeDays);
  const minBehind = normalizePositive(options.minBehind, WORKTREE_SWEEP_DEFAULTS.minBehind);
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const repoDir = typeof options.repoDir === "string" ? options.repoDir : cwd;

  const report = {
    schema: WORKTREE_SWEEP_SCHEMA,
    repoDir,
    againstRef: null,
    mode: apply ? "apply" : "plan",
    defaults: { ...WORKTREE_SWEEP_DEFAULTS },
    entries: [],
    swept: [],
    quarantined: [],
    reparseUnlinked: [],
    branchesDeleted: [],
    branchesRefused: [],
    errors: [],
  };

  let worktrees;
  try {
    worktrees = listRegisteredWorktrees(repoDir);
  } catch (err) {
    report.errors.push({ name: "(repo)", message: err instanceof Error ? err.message : String(err) });
    return report;
  }
  if (worktrees.length === 0) {
    report.errors.push({ name: "(repo)", message: "no registered worktrees found" });
    return report;
  }

  const againstRef = resolveAgainstRef(repoDir, options.againstRef);
  if (!againstRef) {
    report.errors.push({
      name: "(against)",
      message: `no authoritative ref resolves (tried: ${options.againstRef ?? WORKTREE_SWEEP_AGAINST_CANDIDATES.join(", ")})`,
    });
    return report;
  }
  report.againstRef = againstRef;

  const mainWorktree = worktrees[0].path;
  const invokingTop = tryGit(["rev-parse", "--show-toplevel"], cwd)?.trim() ?? null;
  const now = Date.now();

  for (const entry of worktrees) {
    const record = {
      path: entry.path,
      name: basename(entry.path),
      branch: entry.branch,
      head: entry.head ? entry.head.slice(0, 8) : null,
      detached: entry.detached,
      locked: entry.locked,
      verdict: "keep",
      reasons: [],
      dirtyCount: null,
      ahead: null,
      behind: null,
      ageDays: null,
      reparse: [],
    };
    report.entries.push(record);

    if (entry.prunable || !existsSync(entry.path)) {
      record.verdict = "prunable";
      record.reasons.push("directory missing — left to `git worktree prune`");
      continue;
    }
    if (samePath(entry.path, mainWorktree)) {
      record.reasons.push("main worktree");
      continue;
    }
    if (invokingTop && samePath(entry.path, invokingTop)) {
      record.reasons.push("invoking worktree");
      continue;
    }
    if (entry.locked) {
      record.reasons.push("locked (another tool owns it)");
      continue;
    }

    const counts = tryGit(["rev-list", "--left-right", "--count", `${entry.head}...${againstRef}`], repoDir);
    if (counts == null) {
      record.reasons.push("ahead/behind unresolvable");
      report.errors.push({ name: record.name, message: `rev-list failed for ${entry.head}...${againstRef}` });
      continue;
    }
    const [aheadStr, behindStr] = counts.trim().split(/\s+/);
    record.ahead = Number(aheadStr);
    record.behind = Number(behindStr);
    if (!Number.isFinite(record.ahead) || !Number.isFinite(record.behind)) {
      record.reasons.push("ahead/behind unresolvable");
      continue;
    }
    if (record.ahead > 0) {
      record.reasons.push(`unmerged commits (ahead ${record.ahead}) — never swept`);
      continue;
    }
    if (record.behind < minBehind) {
      record.reasons.push(`behind ${record.behind} < minBehind ${minBehind}`);
      continue;
    }

    const headCt = Number((tryGit(["log", "-1", "--format=%ct"], entry.path) ?? "0").trim()) * 1000;
    let dirMtime = 0;
    try {
      dirMtime = statSync(entry.path).mtimeMs;
    } catch {
      /* age stays commit-based */
    }
    record.ageDays = Math.floor((now - Math.max(headCt, dirMtime)) / (24 * 60 * 60 * 1000));
    if (record.ageDays < minAgeDays) {
      record.reasons.push(`fresh (age ${record.ageDays}d < minAgeDays ${minAgeDays})`);
      continue;
    }

    const dirtyOut = tryGit(["status", "--porcelain"], entry.path);
    record.dirtyCount = dirtyOut == null ? null : dirtyOut.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    if (record.dirtyCount == null) {
      record.reasons.push("status unresolvable");
      continue;
    }
    if (record.dirtyCount > 0 && !quarantineAndSweep) {
      record.reasons.push(`dirty (${record.dirtyCount} files; keepDirty — pass the quarantine control to sweep)`);
      continue;
    }

    record.reparse = findReparsePoints(entry.path);
    record.verdict = record.dirtyCount > 0 ? "quarantine-sweep" : "sweep";
    record.reasons.push(
      `${entry.detached ? "detached" : "merged"} at ancestor of ${againstRef}`,
      `behind ${record.behind}`,
      `age ${record.ageDays}d`,
      record.dirtyCount > 0 ? `dirty ${record.dirtyCount} -> quarantine` : "clean",
    );

    if (!apply) continue;

    try {
      if (record.dirtyCount > 0) {
        const quarantineRoot =
          typeof options.quarantineRoot === "string" && options.quarantineRoot.length > 0
            ? options.quarantineRoot
            : join(resolve(mainWorktree, ".."), `worktree-quarantine-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
        const q = quarantineWorktree(entry, quarantineRoot);
        report.quarantined.push({ name: record.name, ...q });
      }
      for (const link of record.reparse) {
        if (unlinkReparsePoint(link.path)) {
          report.reparseUnlinked.push({ name: record.name, path: link.path, target: link.target });
        } else {
          report.errors.push({ name: record.name, message: `reparse point not unlinkable: ${link.path}` });
        }
      }
      tryGit(["worktree", "remove", "--force", entry.path], repoDir);
      const method = removeDirectoryVerified(entry.path);
      if (method == null) {
        report.errors.push({ name: record.name, message: "directory still present after all removal fallbacks" });
        record.verdict = "error";
      } else {
        report.swept.push({ name: record.name, path: entry.path, method });
      }
    } catch (err) {
      record.verdict = "error";
      report.errors.push({ name: record.name, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (apply) {
    tryGit(["worktree", "prune"], repoDir);
  }

  if (branches) {
    const mergedOut = tryGit(["branch", "--merged", againstRef, "--format=%(refname:short)"], repoDir) ?? "";
    const protectedNames = new Set(["main", "master"]);
    for (const wt of listRegisteredWorktreesSafe(repoDir)) {
      if (wt.branch) protectedNames.add(wt.branch);
    }
    for (const name of mergedOut.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)) {
      if (protectedNames.has(name)) continue;
      if (!apply) {
        report.branchesDeleted.push({ name, planned: true });
        continue;
      }
      if (tryGit(["branch", "-d", name], repoDir) != null) {
        report.branchesDeleted.push({ name });
      } else {
        report.branchesRefused.push({ name });
      }
    }
  }

  return report;
}

function listRegisteredWorktreesSafe(repoDir) {
  try {
    return listRegisteredWorktrees(repoDir);
  } catch {
    return [];
  }
}

export default {
  WORKTREE_SWEEP_SCHEMA,
  WORKTREE_SWEEP_DEFAULTS,
  WORKTREE_SWEEP_AGAINST_CANDIDATES,
  listRegisteredWorktrees,
  resolveAgainstRef,
  findReparsePoints,
  unlinkReparsePoint,
  quarantineWorktree,
  sweepWorktrees,
};
