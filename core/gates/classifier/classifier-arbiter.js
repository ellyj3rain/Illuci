/**
 * illuci — Action Classifier · Arbiter
 *
 * classifyAction(featureCtx) is the permission-judgment engine. Two tiers, in
 * order. It runs ONLY on an evaluation.decision === "gate" action (the
 * out-of-scope path) and NEVER overrides an explicit approved/denied — that
 * sequencing is enforced at the call site (gate-controller).
 *
 * TIER 0 — categorical permission veto.
 *   If the tool is NOT in PERMISSION_ACTIONS[permissionLevel] — the set this
 *   permission LEVEL may EVER perform — deny. This is the hard ceiling: "a
 *   read-verify level may never file_write", distinct from evaluate()'s
 *   per-context allowedActions (which is the operator's narrower in-task scope).
 *   A categorical veto is unconditional and cannot be widened by context.
 *
 * TIER 1 — deterministic relational heuristics (target < 1ms, no I/O beyond the
 *   already-resolved git info passed in featureCtx).
 *   (a) GIT-WORKTREE-MISMATCH: the target path's owning worktree (getGitInfo,
 *       resolved in the feature extractor) differs from the seat's intended
 *       worktree root. This is THE check that catches the wrong-worktree write.
 *   (b) WORKSPACE CONTAINMENT: a path-bearing action whose target does not
 *       resolve under the workspace/sandbox root.
 *   (c) DANGEROUS-COMMAND patterns for shell_exec.
 *   Otherwise → "undecided" (fall through to the existing operator transport).
 *
 * Degrade-safe: this function does no throwing I/O. The feature extractor did
 * the resolving (and threw on misconfig, caught by the caller → deny). Here,
 * an unknown git root is treated SAFELY: unknown ≠ proven-equal, so a path
 * that escapes containment with no known worktree still trips containment, but
 * the worktree-MISMATCH rule fires only on a PROVEN mismatch (both roots known
 * and unequal) to avoid denying legitimate not-yet-a-repo targets spuriously.
 *
 * @module core/gates/classifier/classifier-arbiter
 */

import { resolve } from "path";
import { PERMISSION_ACTIONS } from "../approval-context.js";
import { normalizePathForCompare } from "./utils/getGitInfo.js";
import { DENIAL_CODES } from "../../roles/denial-codes.js";

/**
 * Dangerous shell command patterns. This is a TIER-1 deny layer that is
 * deliberately NARROW: the heavy hard-deny surface (rm -rf /, format, disk
 * destruction, fork bombs) lives in bridges/tools.js checkHardInvariants and
 * runs BEFORE the gate. These patterns catch destructive shapes that reach the
 * gate's out-of-scope path so they are denied rather than prompted.
 */
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf?\b/i,                      // recursive force remove
  /\brmdir\b/i,                          // directory removal
  /\bdel\s+\/[sq]\b/i,                   // windows recursive/quiet delete
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+--force|push\s+-f)\b/i, // history/tree destruction
  /\bgit\s+checkout\s+--\s+\./i,         // discard-all working tree
  /\b(?:format|diskpart|fdisk|mkfs)\b/i, // disk destruction (belt-and-braces)
  /\b(?:shutdown|reboot|halt|poweroff)\b/i, // host control
  /:\(\)\s*\{.*\}\s*;/,                  // fork bomb signature
  />\s*\/dev\/sd[a-z]/i,                 // raw-device write
];

/**
 * Does a target path resolve under a given root?
 * Pure string comparison on normalized absolute paths — no filesystem reads.
 *
 * @param {string} targetPath
 * @param {string} root
 * @returns {boolean}
 */
function isContainedUnder(targetPath, root) {
  if (!targetPath || !root) return false;
  const t = normalizePathForCompare(resolve(root, targetPath));
  const r = normalizePathForCompare(resolve(root));
  return t === r || t.startsWith(r + "/");
}

/**
 * Judge an action.
 *
 * @param {import("./feature-extractor.js").FeatureContext} featureCtx
 * @returns {Promise<{ decision: "allow"|"deny"|"undecided", reason: string, tier: number, auditData: object }>}
 */
export async function classifyAction(featureCtx) {
  const tool = featureCtx?.tool;
  const permissionLevel = featureCtx?.permissionLevel;

  const auditBase = {
    tool,
    permissionLevel,
    targetPath: featureCtx?.targetPath || null,
    seatId: featureCtx?.seatId || null,
    seatWorktreeRoot: featureCtx?.seatWorktreeRoot || null,
    targetWorktreeRoot: featureCtx?.targetGit?.worktreeRoot || null,
    workspaceRoot: featureCtx?.workspaceRoot || null,
  };

  // ─── TIER 0 — CATEGORICAL PERMISSION VETO ───
  const categorical = PERMISSION_ACTIONS[permissionLevel];
  if (!Array.isArray(categorical)) {
    // Unknown permission level — no categorical set to judge against. Fail
    // closed: a level we cannot characterize may not act on a gated tool.
    return {
      decision: "deny",
      tier: 0,
      reason: `Unknown permission level '${permissionLevel}' — no categorical action set; denied.`,
      code: DENIAL_CODES.PERMISSION_DENIED,
      auditData: { ...auditBase, rule: "tier0-unknown-level" },
    };
  }
  if (!categorical.includes(tool)) {
    return {
      decision: "deny",
      tier: 0,
      reason: `Permission level '${permissionLevel}' may never perform '${tool}' (categorical veto).`,
      code: DENIAL_CODES.PERMISSION_DENIED,
      auditData: { ...auditBase, rule: "tier0-categorical-veto", categorical },
    };
  }

  // ─── TIER 1 — DETERMINISTIC RELATIONAL HEURISTICS ───

  // (c) Dangerous shell command shapes that reached the out-of-scope path.
  if (tool === "shell_exec" && typeof featureCtx.command === "string") {
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(featureCtx.command)) {
        return {
          decision: "deny",
          tier: 1,
          reason: `Dangerous shell command pattern (${pattern.source}) — denied.`,
          code: DENIAL_CODES.PERMISSION_DENIED,
          auditData: { ...auditBase, rule: "tier1-dangerous-command", command: featureCtx.command.slice(0, 120) },
        };
      }
    }
  }

  // The remaining TIER-1 checks are path-relational. A tool with no target path
  // (e.g. shell_exec without a path, git_commit) has nothing to contain or
  // attribute — leave it undecided so the operator transport judges it.
  const targetPath = featureCtx.targetPath;
  if (targetPath) {
    // (a) GIT-WORKTREE-MISMATCH — the worktree pin.
    // Only fire on a PROVEN mismatch: both the seat's intended worktree root and
    // the target's owning worktree root are known AND unequal. Unknown roots are
    // treated safely (no false deny here; containment below still guards).
    const seatRootNorm = featureCtx.seatWorktreeRoot
      ? normalizePathForCompare(featureCtx.seatWorktreeRoot)
      : null;
    const targetRootNorm = featureCtx.targetGit?.normalizedRoot || null;

    if (seatRootNorm && targetRootNorm && seatRootNorm !== targetRootNorm) {
      // The target's worktree differs from the seat's intended worktree, UNLESS
      // the target still resolves under the seat's worktree (e.g. an in-sandbox
      // path whose owning toplevel git query returned the same tree spelled
      // differently is already equal; this guards a nested-but-contained case).
      if (!isContainedUnder(targetPath, featureCtx.seatWorktreeRoot)) {
        return {
          decision: "deny",
          tier: 1,
          reason:
            `Git worktree mismatch: target '${targetPath}' belongs to worktree ` +
            `'${featureCtx.targetGit.worktreeRoot}', not the seat's worktree ` +
            `'${featureCtx.seatWorktreeRoot}'. Refusing cross-worktree write.`,
          code: DENIAL_CODES.PERMISSION_DENIED,
          auditData: { ...auditBase, rule: "tier1-worktree-mismatch" },
        };
      }
    }

    // (b) WORKSPACE CONTAINMENT — the target must resolve under the seat's
    // worktree (when seated) or the workspace root (otherwise). A path that
    // escapes the contained root is denied. When neither root is known we
    // cannot prove containment; leave it undecided rather than guess.
    const containmentRoot = featureCtx.seatWorktreeRoot || featureCtx.workspaceRoot || null;
    if (containmentRoot) {
      if (!isContainedUnder(targetPath, containmentRoot)) {
        return {
          decision: "deny",
          tier: 1,
          reason: `Target '${targetPath}' resolves outside the workspace root '${containmentRoot}' — denied.`,
          code: DENIAL_CODES.PERMISSION_DENIED,
          auditData: { ...auditBase, rule: "tier1-workspace-containment", containmentRoot },
        };
      }
    }
  }

  // ─── UNDECIDED — fall through to the operator transport ───
  return {
    decision: "undecided",
    tier: 1,
    reason: "No categorical or relational rule fired; deferring to operator.",
    auditData: { ...auditBase, rule: "undecided" },
  };
}

export default { classifyAction };
