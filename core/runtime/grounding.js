// core/runtime/grounding.js
//
// [A33] Runtime grounding — WHERE a illuci runtime is grounded, and whether that
// grounding is legitimate. Closes the split-brain the self-fingerprint guard
// (core/mcp/runtime-guard.js) cannot see: that guard detects the serving root
// CHANGING under a live process, but a process launched from the WRONG root —
// e.g. an MCP launcher hardcoding a dead ephemeral worktree — is perfectly
// "fresh" relative to itself, forever. Grounding is the missing dimension:
// which root, what kind of root, and does it match what the launcher declared.
//
// Law (operator-ratified, the deployed-service reframe): a served illuci runtime
// must never be grounded in an ephemeral worktree, and a launcher/root
// mismatch FAILS CLOSED — a respawn cannot fix a wrong root, so unlike the
// stale guard this check is never disabled by the supervisor.
//
// Data hygiene: grounding facts are PATH-BEARING and live only in illuci-owned
// surfaces (identity's grounding block on local transports, the doctor, env).
// They are never written into a workspace/witness target (Mousecat stays a
// witness; its bridge contract carries no private illuci state).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUNDING_SCHEMA = "illuci.runtime.grounding/1";

// The launcher-declared expectation channel. Set alongside the root by the
// launcher generator so the declaration and the root travel together and any
// later drift between them trips the fail-closed check.
export const EXPECTED_ROOT_ENV = "ILLUCI_EXPECTED_SOURCE_ROOT";
// Deliberate dev override for serving from a linked worktree. Audited in the
// grounding facts whenever it is load-bearing.
export const ALLOW_EPHEMERAL_ENV = "ILLUCI_ALLOW_EPHEMERAL_GROUNDING";

export class GroundingError extends Error {
  constructor(verdict) {
    super(
      `ILLUCI_GROUNDING_${verdict.status.toUpperCase().replaceAll("-", "_")}: ${verdict.reason} ` +
        "A served illuci runtime refuses to start from an illegitimate root (fail closed); " +
        "regenerate the launcher against the intended root (scripts/write-mcp-launcher.mjs).",
    );
    this.name = "GroundingError";
    this.code = "ILLUCI_GROUNDING_REFUSED";
    this.jsonRpcCode = -32076;
    this.verdict = verdict;
  }
}

/** Normalize a filesystem path for comparison: forward slashes, no trailing
 *  slash, case-folded (Windows drive letters and case-insensitive FS). */
export function normalizeRootPath(p) {
  if (!p) return null;
  let s = String(p).replaceAll("\\", "/").trim();
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
}

/**
 * PURE: classify what KIND of root this is from pre-gathered facts.
 *   deployed         — a build-stamped install (no working tree needed)
 *   primary-checkout — the repo's main working tree (gitDir === gitCommonDir)
 *   linked-worktree  — a `git worktree add` checkout (ephemeral by convention;
 *                      .claude/worktrees/* session trees are this kind)
 *   non-git          — neither stamped nor a git tree
 */
export function classifyWorktreeKind({ hasBuildStamp = false, gitDir = null, gitCommonDir = null } = {}) {
  if (hasBuildStamp) return "deployed";
  if (!gitDir) return "non-git";
  if (gitCommonDir && normalizeRootPath(gitDir) !== normalizeRootPath(gitCommonDir)) return "linked-worktree";
  return "primary-checkout";
}

/**
 * PURE: the grounding verdict.
 *
 * @param {{
 *   actualRoot: string,
 *   expectedRoot?: string|null,   // launcher-declared (EXPECTED_ROOT_ENV); null = undeclared
 *   worktreeKind: string,         // classifyWorktreeKind output
 *   serving?: boolean,            // true when this process SERVES (MCP/runtime service); ephemeral rule applies only then
 *   allowEphemeral?: boolean,     // deliberate dev override (ALLOW_EPHEMERAL_ENV)
 * }} facts
 * @returns {{ status: string, failClosed: boolean, reason: string, overridden?: boolean }}
 */
export function classifyGrounding({ actualRoot, expectedRoot = null, worktreeKind, serving = false, allowEphemeral = false } = {}) {
  const actual = normalizeRootPath(actualRoot);
  const expected = normalizeRootPath(expectedRoot);

  if (expected && actual !== expected) {
    return {
      status: "mismatch",
      failClosed: true,
      reason: `launcher declared root ${expectedRoot} but the process is grounded in ${actualRoot} — launcher/root split-brain.`,
    };
  }

  if (serving && worktreeKind === "linked-worktree") {
    if (allowEphemeral) {
      return {
        status: "ephemeral-overridden",
        failClosed: false,
        overridden: true,
        reason: `serving from a linked (ephemeral) worktree under an explicit ${ALLOW_EPHEMERAL_ENV} override — dev only.`,
      };
    }
    return {
      status: "ephemeral",
      failClosed: true,
      reason: "a served runtime must not be grounded in an ephemeral linked worktree — the session that created it dies, the server keeps serving its corpse.",
    };
  }

  return {
    status: "grounded",
    failClosed: false,
    reason:
      worktreeKind === "deployed"
        ? "grounded in a build-stamped deployed install."
        : expected
          ? `grounded in the launcher-declared root (${worktreeKind}).`
          : `grounded (${worktreeKind}); no launcher declaration to verify against.`,
  };
}

/**
 * PURE: the session-side doctor comparison — the ACTIVE agent worktree vs the
 * identity a (possibly stale-rooted) MCP server reported. This is the check no
 * self-polling server can do for itself.
 */
export function compareSessionGrounding({ activeRoot, servedRoot } = {}) {
  const active = normalizeRootPath(activeRoot);
  const served = normalizeRootPath(servedRoot);
  if (!served) {
    return { match: false, status: "unreported", reason: "the served runtime did not report a source root — pre-[A33] server or grounding withheld." };
  }
  if (active === served) {
    return { match: true, status: "aligned", reason: "the MCP runtime is grounded in the active session worktree." };
  }
  return {
    match: false,
    status: "split-brain",
    reason: `active session worktree is ${activeRoot} but the MCP runtime serves from ${servedRoot} — the launcher points elsewhere.`,
  };
}

// ── the impure edge: gather facts about a real root ───────────────────────────

const THIS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function gitFact(root, args) {
  try {
    return (
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        windowsHide: true,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Gather path-bearing grounding facts for a root (default: the root THIS code runs from). */
export function resolveGroundingFacts({ root = THIS_ROOT, env = process.env, serving = false } = {}) {
  const hasBuildStamp = Boolean((env.ILLUCI_BUILD_REV || "").trim()) || existsSync(resolve(root, ".illuci-build-rev"));
  const gitDir = gitFact(root, ["rev-parse", "--absolute-git-dir"]);
  const gitCommonDir = gitDir ? gitFact(root, ["rev-parse", "--git-common-dir"]) : null;
  const worktreeKind = classifyWorktreeKind({
    hasBuildStamp,
    gitDir,
    gitCommonDir: gitCommonDir ? resolve(root, gitCommonDir) : null,
  });
  const facts = {
    schema: GROUNDING_SCHEMA,
    sourceRoot: root,
    branch: gitFact(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: gitFact(root, ["rev-parse", "HEAD"]),
    version: (() => {
      try {
        return readFileSync(resolve(root, "VERSION"), "utf8").trim() || null;
      } catch {
        return null;
      }
    })(),
    launcherPath: process.argv[1] || null,
    pid: process.pid,
    worktreeKind,
    expectedRoot: (env[EXPECTED_ROOT_ENV] || "").trim() || null,
    serving,
  };
  const verdict = classifyGrounding({
    actualRoot: facts.sourceRoot,
    expectedRoot: facts.expectedRoot,
    worktreeKind,
    serving,
    allowEphemeral: env[ALLOW_EPHEMERAL_ENV] === "1",
  });
  return { ...facts, grounding: verdict };
}

/** Is this process's ENTRY a real serve entry (the launcher path: server.js or
 *  supervisor.js as main), as opposed to an in-process embedding (tests,
 *  verify scripts, http-transport composition)? The ephemeral rule binds only
 *  to serve entries; the launcher/root MISMATCH rule is env-driven and binds
 *  everywhere the expectation is declared. */
export function isServeEntry(argv1 = process.argv[1]) {
  const entry = normalizeRootPath(argv1 || "");
  return entry ? entry.endsWith("/core/mcp/server.js") || entry.endsWith("/core/mcp/supervisor.js") : false;
}

/** FAIL CLOSED for serving processes: throw before a single tool is served
 *  when the grounding verdict demands it. Never supervisor-disabled. */
export function assertServeGrounding({ root, env, serving = isServeEntry() } = {}) {
  const facts = resolveGroundingFacts({ ...(root ? { root } : {}), ...(env ? { env } : {}), serving });
  if (facts.grounding.failClosed) throw new GroundingError(facts.grounding);
  return facts;
}

export default {
  GROUNDING_SCHEMA,
  EXPECTED_ROOT_ENV,
  ALLOW_EPHEMERAL_ENV,
  GroundingError,
  normalizeRootPath,
  classifyWorktreeKind,
  classifyGrounding,
  compareSessionGrounding,
  resolveGroundingFacts,
  isServeEntry,
  assertServeGrounding,
};
