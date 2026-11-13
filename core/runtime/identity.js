// core/runtime/identity.js
//
// [A22.1] Illuci Runtime service — versioned runtime identity.
//
// The authoritative answer to "what runtime am I connected to?" for a remote
// client that has NO local repo checkout. Source revision is resolved
// build-stamp-FIRST (ILLUCI_BUILD_REV / a stamp file baked at deploy time), with a
// live-git fallback for local dev only — a deployed service must not depend on a
// working tree to describe itself.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveGroundingFacts } from "./grounding.js";

export const RUNTIME_ID = "illuci.runtime";
// Bump when the identity/capability contract shape changes (consumed by clients + the doctor).
export const RUNTIME_SCHEMA_VERSION = "illuci.runtime/1";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readTrimmed(path) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function gitFact(args) {
  try {
    return (
      execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the source/build revision without assuming a working tree.
 * Precedence: explicit build stamp (env, then a committed/baked stamp file) → live git (dev) → unknown.
 */
export function resolveSourceRevision() {
  const envRev = (process.env.ILLUCI_BUILD_REV || "").trim();
  if (envRev) return { rev: envRev, from: "build-stamp-env" };

  const stampFile = readTrimmed(join(REPO_ROOT, ".illuci-build-rev"));
  if (stampFile) return { rev: stampFile, from: "build-stamp-file" };

  const head = gitFact(["rev-parse", "HEAD"]);
  if (head) {
    return {
      rev: head,
      branch: gitFact(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: Boolean(gitFact(["status", "--porcelain"])),
      from: "git-worktree",
    };
  }
  return { rev: null, from: "unknown" };
}

/**
 * The versioned runtime identity. Safe to serialize to any remote client — no secrets, no paths.
 *
 * [A33] `{ grounding: true }` appends the PATH-BEARING grounding block (source
 * root, branch, head, launcher path, pid, worktree kind, stale/fresh verdict)
 * for LOCAL surfaces only — the stdio MCP boundary and the doctor. Remote/HTTP
 * identity keeps the path-free shape; the grounding block never crosses into a
 * workspace/witness target's contract (Mousecat carries no private illuci state).
 */
export function getRuntimeIdentity({ grounding = false } = {}) {
  const identity = {
    schema: RUNTIME_SCHEMA_VERSION,
    runtimeId: RUNTIME_ID,
    version: readTrimmed(join(REPO_ROOT, "VERSION")),
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    source: resolveSourceRevision(),
  };
  if (grounding) {
    identity.grounding = resolveGroundingFacts({ root: REPO_ROOT });
  }
  return identity;
}

export default { RUNTIME_ID, RUNTIME_SCHEMA_VERSION, resolveSourceRevision, getRuntimeIdentity };
