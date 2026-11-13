/**
 * illuci — Git Workflow Automation
 *
 * Automates the PR review cycle.
 * `illuci pr` creates a PR and optionally runs a dev-team review
 * against the diff.
 */

import { execSync } from "child_process";
import { logDecision } from "../decisions/logger.js";

/**
 * Get the current branch name.
 */
export function currentBranch(cwd) {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", windowsHide: true }).trim();
}

/**
 * Get the diff between current branch and base.
 */
export function branchDiff(cwd, base = "main") {
  try {
    return execSync(`git diff ${base}...HEAD`, { cwd, encoding: "utf-8", windowsHide: true });
  } catch {
    return execSync("git diff HEAD~1", { cwd, encoding: "utf-8", windowsHide: true });
  }
}

/**
 * Get recent commit messages on this branch.
 */
export function branchCommits(cwd, base = "main") {
  try {
    return execSync(`git log ${base}..HEAD --oneline`, { cwd, encoding: "utf-8", windowsHide: true }).trim();
  } catch {
    return execSync("git log -5 --oneline", { cwd, encoding: "utf-8", windowsHide: true }).trim();
  }
}

/**
 * Create a PR via gh CLI.
 */
export function createPR(cwd, title, body) {
  // Push current branch
  const branch = currentBranch(cwd);
  try {
    execSync(`git push -u origin ${branch}`, { cwd, windowsHide: true, stdio: "pipe" });
  } catch {}

  const result = execSync(
    `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
    { cwd, encoding: "utf-8", windowsHide: true }
  );

  return result.trim(); // PR URL
}

/**
 * Run a dev-team review on the current branch diff.
 */
export async function cdcReview(cwd, diff) {
  const { runTopology } = await import("../topologies/runner.js");

  const prompt = `Review this code diff for quality, security, and correctness. Identify any issues.\n\n\`\`\`diff\n${diff.substring(0, 15000)}\n\`\`\``;

  const trace = await runTopology("dev-team", {}, prompt, {
    humanStatus: "operator-initiated",
    context: "Automated PR review via illuci pr --review",
  });

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [{ model: "system", seat: "git-workflow" }],
    context: `Dev-team review on branch ${currentBranch(cwd)}`,
    type: "pr-review",
    decision: `Dev-team review completed: ${Object.keys(trace.phases).length} phases`,
    inputs: { branch: currentBranch(cwd) },
    metadata: { phaseCount: Object.keys(trace.phases).length },
  });

  return trace;
}

export default { currentBranch, branchDiff, branchCommits, createPR, cdcReview };
