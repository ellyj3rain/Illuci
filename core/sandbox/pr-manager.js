/**
 * illuci — PR Manager for Sandboxed Execution
 *
 * After a write-mode phase completes, each agent's sandbox becomes a PR.
 * Review/QA phases receive the PRs, not raw text. The reviewer sees diffs.
 * QA runs tests against each branch.
 *
 * This is how real dev teams work: branches, PRs, code review, governed merges.
 * Not a chat loop that produces text. A development pipeline that produces
 * reviewable, mergeable code.
 *
 * Attribution: all foundational concepts operator-originated.
 *
 * @module core/sandbox/pr-manager
 */

import { getSandbox, getSandboxDiff, commitSandbox, cleanupSandbox } from "./workspace.js";
import { emit } from "../events/emitter.js";
import { appendEvent } from "./git.js";
import { execSync } from "child_process";

/** @type {Map<string, PRInfo>} prId → PR state */
const prRegistry = new Map();

let prCounter = 0;

/**
 * @typedef {Object} PRInfo
 * @property {string} prId
 * @property {string} seatId
 * @property {string} modelId
 * @property {string} branch
 * @property {string} description
 * @property {string} diff
 * @property {string[]} filesChanged
 * @property {string} status - "open" | "merged" | "rejected"
 * @property {string} createdAt
 * @property {string|null} resolvedAt
 * @property {string|null} resolvedBy
 * @property {string|null} rejectReason
 */

/**
 * Create a PR from a sandbox. Commits any pending changes and captures the diff.
 *
 * @param {string} seatId - The seat whose sandbox becomes a PR
 * @param {string} modelId - The model that produced the changes
 * @param {string} branch - The sandbox branch name
 * @param {string} description - PR description
 * @returns {{ prId: string, diff: string, filesChanged: string[] }}
 */
export function createPR(seatId, modelId, branch, description) {
  if (!seatId) throw new Error("seatId required");

  const sandbox = getSandbox(seatId);
  if (!sandbox) throw new Error(`No sandbox found for seat: ${seatId}`);

  // Commit any pending changes
  commitSandbox(seatId, description.substring(0, 72));

  // Get the diff
  const { diff, filesChanged } = getSandboxDiff(seatId);

  const prId = `pr-${++prCounter}-${seatId}-${Date.now().toString(36)}`;

  const pr = {
    prId,
    seatId,
    modelId,
    branch: branch || sandbox.branch,
    description,
    diff,
    filesChanged,
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    rejectReason: null,
  };

  prRegistry.set(prId, pr);

  emit({
    type: "pr_created",
    payload: {
      prId,
      seatId,
      modelId,
      branch: pr.branch,
      filesChanged,
      description,
    },
  });

  // Log PR to VCS ledger
  try {
    appendEvent("default", {
      type: "pr_opened",
      agent: modelId,
      branch: pr.branch,
      target: sandbox.baseBranch || "main",
      title: description,
      diff_summary: `${filesChanged.length} files, ${diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length} additions`,
    });
  } catch {}

  return { prId, diff, filesChanged };
}

/**
 * Get a PR by ID.
 * @param {string} prId
 * @returns {PRInfo|null}
 */
export function getPR(prId) {
  return prRegistry.get(prId) || null;
}

/**
 * List all PRs, optionally filtered by status.
 * @param {Object} [filter]
 * @param {string} [filter.status]
 * @returns {PRInfo[]}
 */
export function listPRs(filter = {}) {
  const results = [];
  for (const pr of prRegistry.values()) {
    if (filter.status && pr.status !== filter.status) continue;
    results.push(pr);
  }
  return results;
}

/**
 * Merge a PR back to the base branch. Governance-gated.
 *
 * @param {string} prId
 * @param {Object} [options]
 * @param {string} [options.mergedBy] - Who authorized the merge
 * @returns {{ merged: boolean, reason: string }}
 */
export function mergePR(prId, options = {}) {
  const pr = prRegistry.get(prId);
  if (!pr) return { merged: false, reason: `PR not found: ${prId}` };
  if (pr.status !== "open") return { merged: false, reason: `PR already ${pr.status}` };

  const sandbox = getSandbox(pr.seatId);
  if (!sandbox) return { merged: false, reason: "Sandbox no longer available" };

  try {
    // Get the repo root from the sandbox
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: sandbox.workdir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();

    // Merge the sandbox branch into the base branch
    execSync(`git merge --no-ff "${pr.branch}" -m "Merge ${pr.prId}: ${pr.description.substring(0, 50)}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });

    pr.status = "merged";
    pr.resolvedAt = new Date().toISOString();
    pr.resolvedBy = options.mergedBy || "governance";

    // Clean up the sandbox
    cleanupSandbox(pr.seatId, { deleteBranch: true });

    emit({
      type: "pr_merged",
      payload: {
        prId,
        seatId: pr.seatId,
        modelId: pr.modelId,
        branch: pr.branch,
        mergedBy: pr.resolvedBy,
      },
    });

    emit({
      type: "sandbox_branch_merged",
      payload: {
        prId,
        seatId: pr.seatId,
        modelId: pr.modelId,
        branch: pr.branch,
        mergedBy: pr.resolvedBy,
      },
    });

    // Log merge to VCS ledger
    try {
      const mergeHash = execSync("git rev-parse HEAD", {
        cwd: repoRoot, encoding: "utf-8", stdio: "pipe",
      }).trim();
      appendEvent("default", {
        type: "merge",
        pr: pr.branch,
        merged_by: pr.resolvedBy,
        hash: mergeHash,
      });
    } catch {}

    return { merged: true, reason: "PR merged successfully" };
  } catch (err) {
    return { merged: false, reason: `Merge failed: ${err.message}` };
  }
}

/**
 * Reject a PR — close without merging, log provenance.
 *
 * @param {string} prId
 * @param {string} reason - Why the PR was rejected
 * @param {Object} [options]
 * @param {string} [options.rejectedBy]
 * @returns {{ rejected: boolean, reason: string }}
 */
export function rejectPR(prId, reason, options = {}) {
  const pr = prRegistry.get(prId);
  if (!pr) return { rejected: false, reason: `PR not found: ${prId}` };
  if (pr.status !== "open") return { rejected: false, reason: `PR already ${pr.status}` };

  pr.status = "rejected";
  pr.resolvedAt = new Date().toISOString();
  pr.resolvedBy = options.rejectedBy || "governance";
  pr.rejectReason = reason;

  // Clean up the sandbox but keep the branch for audit
  cleanupSandbox(pr.seatId, { deleteBranch: false });

  emit({
    type: "pr_closed",
    payload: {
      prId,
      seatId: pr.seatId,
      modelId: pr.modelId,
      branch: pr.branch,
      reason,
      status: "rejected",
      rejectedBy: pr.resolvedBy,
    },
  });

  // Log rejection to VCS ledger
  try {
    appendEvent("default", {
      type: "rejection",
      agent: pr.modelId,
      seat: pr.seatId,
      pr: pr.branch,
      reason,
    });
  } catch {}

  return { rejected: true, reason: `PR rejected: ${reason}` };
}

/**
 * Format PRs for review phases — produces a structured summary
 * that reviewers/QA can consume instead of raw text.
 *
 * @param {string[]} prIds
 * @returns {string}
 */
export function formatPRsForReview(prIds) {
  const sections = [];

  for (const prId of prIds) {
    const pr = prRegistry.get(prId);
    if (!pr) continue;

    sections.push([
      `## PR: ${pr.prId}`,
      `**Branch:** ${pr.branch}`,
      `**Files Changed:** ${pr.filesChanged.join(", ") || "none"}`,
      `**Description:** ${pr.description}`,
      "",
      "### Diff",
      "```diff",
      pr.diff || "(no changes)",
      "```",
    ].join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

export default {
  createPR, getPR, listPRs,
  mergePR, rejectPR, formatPRsForReview,
};
