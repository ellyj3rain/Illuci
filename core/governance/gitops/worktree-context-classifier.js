// illuci/core/governance/gitops/worktree-context-classifier.js
//
// Pure, deterministic classifier for the Std 12 repo-authority atom. Consumes
// the fact object from repo-context-probe.js (illuci.gitops.repo-context-facts/1)
// and emits a governed verdict. Makes NO git/FS calls and mutates nothing — the
// probe gathers, this decides. Sibling to remote-branch-hygiene-classifier.js
// (both take host facts and emit governed verdicts).
//
// Divergence-only contract (operator ratification of 2026-06-30): the atom
// blocks ONLY on a real, verifiable split-brain — the DIVERGENCE signals:
// repo-root-mismatch, branch-mismatch, worktree-mismatch, shadow-repo-detected
// (actual context != a PRESENT dispatched lineage, or a nested/shadow repo).
// EVERYTHING else is ADVISORY and must NEVER block: you cannot have a split-brain
// when there is nothing to diverge from (no lineage) or nothing to verify
// (non-git). Only the four divergence codes carry S.BLOCK; no signal is
// S.OPERATOR anymore (both BLOCK and OPERATOR hardStop in makeGovernedVerdict).

import { SEVERITIES, bool, int, list, makeGovernedVerdict, makeSignal } from "../classifiers/governed-verdict.js";

export const WORKTREE_CONTEXT_DISPOSITIONS = Object.freeze({
  AUTHORIZED: "authorized",
  BLOCKED: "blocked",
  OPERATOR_REVIEW: "operator-review",
  STATE_ADVISORY: "state-advisory",
});

const S = SEVERITIES;

// The only signals that constitute a real split-brain and therefore block.
const DIVERGENCE_SIGNAL_CODES = new Set([
  "repo-root-mismatch",
  "branch-mismatch",
  "worktree-mismatch",
  "shadow-repo-detected",
]);

/**
 * Classify the current worktree/filesystem context against the dispatched
 * lineage. Pure: facts in, governed verdict out.
 *
 * @param {object} facts a illuci.gitops.repo-context-facts/1 object from the probe
 * @returns {object} a illuci.governance.classifier-verdict/1 governed verdict
 */
export function classifyWorktreeContext(facts = {}) {
  const actual = facts.actual && typeof facts.actual === "object" ? facts.actual : {};
  const dispatched = facts.dispatched && typeof facts.dispatched === "object" ? facts.dispatched : null;
  const matches = facts.matches && typeof facts.matches === "object" ? facts.matches : {};
  const branchWorktreeMap = facts.branchWorktreeMap && typeof facts.branchWorktreeMap === "object" ? facts.branchWorktreeMap : {};
  const worktrees = list(actual.worktrees);
  const signals = [];
  const push = (code, severity, dimension, evidence, next, data) =>
    signals.push(makeSignal({ code, severity, dimension, evidence, next, data }));

  // --- Repository authority (identity) ---
  // Non-git and no-lineage are ADVISORY: there is nothing to verify against, so
  // there is no split-brain to detect. Only actual-vs-present-lineage mismatches
  // (and shadow repos below) are DIVERGENCE and block.
  if (!bool(actual.isGitRepo)) {
    push("not-a-git-repo", S.WATCH, "repo-authority",
      `cwd ${facts.cwd || "?"} is not inside a git working tree`, "dispatch-into-governed-checkout");
  }
  if (!dispatched) {
    push("no-dispatched-lineage", S.WATCH, "repo-authority",
      "no dispatched lineage supplied; actual context cannot be verified", "supply-lineage-at-dispatch");
  } else {
    if (matches.root === false)
      push("repo-root-mismatch", S.BLOCK, "repo-authority",
        `actual repo root ${actual.repoRoot} != dispatched ${dispatched.canonicalRoot}`, "switch-to-canonical-root",
        { actual: actual.repoRoot, dispatched: dispatched.canonicalRoot });
    if (matches.branch === false)
      push("branch-mismatch", S.BLOCK, "repo-authority",
        `active branch ${actual.currentBranch} != dispatched ${dispatched.branch}`, "checkout-dispatched-branch",
        { actual: actual.currentBranch, dispatched: dispatched.branch });
    if (matches.worktree === false)
      push("worktree-mismatch", S.BLOCK, "worktree-integrity",
        `active worktree ${actual.worktreePath} != dispatched ${dispatched.worktreePath}`, "cd-intended-worktree",
        { actual: actual.worktreePath, dispatched: dispatched.worktreePath });
    if (matches.remote === false)
      push("remote-mismatch", S.WATCH, "remote-binding",
        `dispatched remote '${dispatched.remote}' is not configured (have: ${Object.keys(actual.remotes || {}).join(", ") || "none"})`,
        "verify-remote-binding", { dispatched: dispatched.remote, configured: Object.keys(actual.remotes || {}) });
  }

  // Shadow repo — forward-compatible: the probe supplies actual.shadowRepos when it can detect nested .git roots.
  const shadow = list(actual.shadowRepos);
  if (shadow.length > 0)
    push("shadow-repo-detected", S.BLOCK, "repo-authority",
      `nested git repo(s) below the canonical root: ${shadow.join(", ")}`, "remove-or-relocate-shadow-repo", { shadowRepos: shadow });

  // Current worktree not present in the registry (registration drift) — advisory.
  if (bool(actual.isGitRepo) && worktrees.length > 0 && !worktrees.some((w) => w && w.isCurrent))
    push("unregistered-worktree", S.WATCH, "worktree-integrity",
      `current worktree ${actual.worktreePath} is not in the git worktree registry`, "repair-worktree-registration");

  // --- State hygiene — ADVISORY under the divergence-only contract (2026-06-30).
  // A dirty/detached/behind tree is a state to report, not a split-brain to block.
  if (bool(actual.isDetached))
    push("detached-head", S.WATCH, "branch-lineage",
      "HEAD is detached; commits made here are not on any branch", "attach-or-checkout-branch");
  if (bool(actual.dirty))
    push("dirty-worktree", S.CAUTION, "state-hygiene",
      `worktree has ${int(actual.dirtyCount)} uncommitted change(s)`, "commit-stash-or-clean-before-work",
      { dirtyCount: int(actual.dirtyCount), hasUntracked: bool(actual.hasUntracked) });
  if (int(actual.behind) > 0)
    push("worktree-behind", S.WATCH, "state-hygiene",
      `local branch is ${int(actual.behind)} commit(s) behind ${actual.upstream || "upstream"}`, "pull-or-rebase-onto-upstream",
      { behind: int(actual.behind), upstream: actual.upstream || null });
  if (int(actual.ahead) > 0)
    push("worktree-ahead", S.WATCH, "state-hygiene",
      `local branch is ${int(actual.ahead)} commit(s) ahead of ${actual.upstream || "upstream"}`, "push-or-open-pr-when-ready",
      { ahead: int(actual.ahead), upstream: actual.upstream || null });
  if (int(actual.stashCount) > 0)
    push("stash-present", S.INFO, "state-hygiene",
      `${int(actual.stashCount)} stash entr(y/ies) present`, null, { stashCount: int(actual.stashCount) });

  // Same branch checked out in multiple worktrees (sprawl / ambiguity).
  for (const [branch, paths] of Object.entries(branchWorktreeMap)) {
    if (list(paths).length > 1)
      push("multiple-worktrees-same-branch", S.WATCH, "branch-map",
        `branch '${branch}' is checked out in ${list(paths).length} worktrees`, "consolidate-duplicate-worktrees",
        { branch, paths });
  }

  // --- Decision (divergence-only) ---
  // Block iff a real split-brain is present; otherwise everything is advisory
  // (or authorized when no signals fired at all). OPERATOR_REVIEW is now
  // unreachable — kept in the enum for shape compatibility.
  const hasDivergence = signals.some((s) => DIVERGENCE_SIGNAL_CODES.has(s.code));
  const identityClean =
    bool(actual.isGitRepo) && Boolean(dispatched) &&
    matches.root !== false && matches.branch !== false && matches.worktree !== false;

  let decision, code, evidence;
  if (hasDivergence) {
    decision = WORKTREE_CONTEXT_DISPOSITIONS.BLOCKED;
    code = "worktree-context-blocked";
    evidence = "split-brain divergence detected; mutation not authorized";
  } else if (signals.length > 0) {
    decision = WORKTREE_CONTEXT_DISPOSITIONS.STATE_ADVISORY;
    code = "worktree-context-advisory";
    evidence = "no divergence from dispatched lineage; non-blocking advisories present";
  } else {
    decision = WORKTREE_CONTEXT_DISPOSITIONS.AUTHORIZED;
    code = "worktree-context-authorized";
    evidence = identityClean ? "actual context matches dispatched lineage; clean" : "no context signals raised";
  }

  const next =
    signals.find((s) => s.next)?.next ||
    (decision === WORKTREE_CONTEXT_DISPOSITIONS.AUTHORIZED ? "proceed" : null);

  return makeGovernedVerdict({
    classifier: "illuci.gitops.worktree-context",
    subject: dispatched?.branch || actual.currentBranch || facts.cwd || "worktree-context",
    decision,
    strategy: decision,
    allowed: !hasDivergence,
    requiresOperator: false,
    code,
    evidence,
    next,
    dimensions: {
      identity: {
        isGitRepo: bool(actual.isGitRepo),
        rootMatch: matches.root ?? null,
        branchMatch: matches.branch ?? null,
        worktreeMatch: matches.worktree ?? null,
        remoteMatch: matches.remote ?? null,
      },
      state: {
        dirty: bool(actual.dirty),
        detached: bool(actual.isDetached),
        ahead: int(actual.ahead),
        behind: int(actual.behind),
        stashCount: int(actual.stashCount),
      },
      currentBranch: actual.currentBranch || null,
      dispatchedBranch: dispatched?.branch || null,
      worktreeCount: worktrees.length,
    },
    signals,
  });
}

export default { WORKTREE_CONTEXT_DISPOSITIONS, classifyWorktreeContext };
