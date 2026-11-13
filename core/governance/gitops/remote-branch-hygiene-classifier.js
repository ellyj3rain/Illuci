// illuci/core/governance/gitops/remote-branch-hygiene-classifier.js
//
// Pure classifier for remote branch cleanup posture. This deliberately does not
// call git or GitHub. Host scripts provide branch facts, PR facts, and
// equivalence evidence; this module decides whether a remote branch is retained,
// a safe-delete candidate, or operator-routed.

import { SEVERITIES, bool, list, makeGovernedVerdict, makeSignal, norm } from "../classifiers/governed-verdict.js";

export const REMOTE_BRANCH_DISPOSITIONS = Object.freeze({
  RETAIN: "retain",
  SAFE_DELETE: "safe-delete",
  OPERATOR_REVIEW: "operator-review",
});

export const REMOTE_BRANCH_HYGIENE_STATUS = Object.freeze({
  UP_TO_DATE: "up-to-date",
  CLEANUP_AVAILABLE: "cleanup-available",
  OPERATOR_REVIEW: "operator-review",
});

const DEFAULT_PROTECTED_BRANCH_NAMES = new Set(["main", "master", "develop", "trunk"]);

function cleanBranchName(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "");
}

function normalizeSha(value) {
  const sha = String(value || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
}

export function normalizePullRequest(input = {}) {
  const mergedAt = input.mergedAt || input.merged_at || null;
  const state = norm(input.state || (mergedAt ? "merged" : ""));
  const head = input.head && typeof input.head === "object" ? input.head : {};
  const base = input.base && typeof input.base === "object" ? input.base : {};
  return {
    number: Number(input.number) || null,
    title: String(input.title || ""),
    url: String(input.url || input.html_url || ""),
    state,
    isDraft: bool(input.isDraft ?? input.draft),
    mergedAt: mergedAt ? String(mergedAt) : null,
    headRefName: cleanBranchName(input.headRefName || input.head_ref || head.ref),
    headSha: normalizeSha(input.headSha || input.head_sha || head.sha),
    baseRefName: cleanBranchName(input.baseRefName || input.base_ref || base.ref),
  };
}

function branchMatchesPull(branchName, pr) {
  return cleanBranchName(pr.headRefName) === cleanBranchName(branchName);
}

function pullRequestSort(a, b) {
  return (Number(b.number) || 0) - (Number(a.number) || 0);
}

function isMerged(pr) {
  return Boolean(pr.mergedAt) || pr.state === "merged";
}

function isOpen(pr) {
  return pr.state === "open";
}

function isClosedUnmerged(pr) {
  return pr.state === "closed" && !isMerged(pr);
}

function equivalenceEvidence(input) {
  const evidence = [];
  if (bool(input.isAncestorOfDefault)) evidence.push("ancestor-of-default");
  if (bool(input.isTreeEquivalentToDefault)) evidence.push("tree-equivalent-to-default");
  if (bool(input.isPatchEquivalentToDefault)) evidence.push("patch-equivalent-to-default");
  return evidence;
}

function result({ branchName, disposition, code, evidence, signals, input, prs, extra = {} }) {
  const verdict = makeGovernedVerdict({
    classifier: "illuci.gitops.remote-branch-hygiene",
    subject: branchName || "remote-branch",
    decision: disposition,
    strategy: disposition,
    allowed: disposition !== REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW,
    code,
    evidence,
    next: disposition === REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE ? "delete-remote-branch-after-explicit-ratification" : null,
    signals,
    dimensions: {
      branchName,
      defaultBranch: cleanBranchName(input.defaultBranch || "main"),
      protected: bool(input.protected),
      isDefaultBranch: bool(input.isDefaultBranch),
      associatedPullRequests: prs.map((pr) => ({
        number: pr.number,
        state: pr.state,
        mergedAt: pr.mergedAt,
        headSha: pr.headSha,
        url: pr.url,
      })),
      equivalenceEvidence: equivalenceEvidence(input),
      headSha: normalizeSha(input.headSha),
      ...extra,
    },
  });

  return {
    ...verdict,
    disposition,
    cleanupAction: disposition === REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE ? "delete-remote-branch" : "retain",
    deletable: disposition === REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE && verdict.allowed,
  };
}

export function classifyRemoteBranchHygiene(input = {}) {
  const branchName = cleanBranchName(input.branchName || input.name);
  const defaultBranch = cleanBranchName(input.defaultBranch || "main");
  const protectedByName = DEFAULT_PROTECTED_BRANCH_NAMES.has(branchName);
  const protectedBranch = bool(input.protected) || protectedByName;
  const isDefaultBranch = bool(input.isDefaultBranch) || branchName === defaultBranch;
  const headSha = normalizeSha(input.headSha);
  const prs = list(input.associatedPullRequests || input.pullRequests)
    .map(normalizePullRequest)
    .filter((pr) => !pr.headRefName || branchMatchesPull(branchName, pr))
    .sort(pullRequestSort);

  const signals = [];

  if (!branchName) {
    signals.push(makeSignal({
      code: "remote-branch-name-missing",
      severity: SEVERITIES.BLOCK,
      dimension: "branch-identity",
      evidence: "remote branch record has no branch name",
      next: "repair-branch-snapshot",
    }));
    return result({
      branchName,
      disposition: REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW,
      code: "remote-branch-invalid",
      evidence: "remote branch record is missing a name",
      signals,
      input,
      prs,
    });
  }

  if (isDefaultBranch || protectedBranch) {
    signals.push(makeSignal({
      code: isDefaultBranch ? "default-branch-retained" : "protected-branch-retained",
      severity: SEVERITIES.INFO,
      dimension: "branch-protection",
      evidence: isDefaultBranch
        ? `${branchName} is the default branch`
        : `${branchName} is protected or reserved`,
      next: "retain-branch",
    }));
    return result({
      branchName,
      disposition: REMOTE_BRANCH_DISPOSITIONS.RETAIN,
      code: "remote-branch-retained",
      evidence: "default and protected branches are not cleanup candidates",
      signals,
      input: { ...input, protected: protectedBranch, isDefaultBranch },
      prs,
    });
  }

  const openPulls = prs.filter(isOpen);
  if (openPulls.length > 0) {
    signals.push(makeSignal({
      code: "open-pr-head-branch",
      severity: SEVERITIES.INFO,
      dimension: "review-state",
      evidence: `${branchName} is still the head branch for ${openPulls.length} open pull request(s)`,
      next: "retain-until-pr-closes",
      data: { pullRequests: openPulls.map((pr) => pr.number).filter(Boolean) },
    }));
    return result({
      branchName,
      disposition: REMOTE_BRANCH_DISPOSITIONS.RETAIN,
      code: "remote-branch-retained",
      evidence: "open pull-request head branches remain live review surfaces",
      signals,
      input,
      prs,
    });
  }

  const mergedPulls = prs.filter(isMerged);
  const closedUnmergedPulls = prs.filter(isClosedUnmerged);
  const latestMerged = mergedPulls[0] || null;
  const evidenceKinds = equivalenceEvidence(input);
  const headMatchesMergedPr =
    !headSha ||
    !latestMerged ||
    !latestMerged.headSha ||
    headSha === latestMerged.headSha;

  if (mergedPulls.length > 0 && evidenceKinds.length > 0 && headMatchesMergedPr) {
    signals.push(makeSignal({
      code: "stale-merged-pr-branch",
      severity: SEVERITIES.WATCH,
      dimension: "remote-branch-hygiene",
      evidence: `${branchName} is a merged PR head branch and is ${evidenceKinds.join(", ")}`,
      next: "delete-remote-branch-after-explicit-ratification",
      data: {
        pullRequests: mergedPulls.map((pr) => pr.number).filter(Boolean),
        evidenceKinds,
      },
    }));
    return result({
      branchName,
      disposition: REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE,
      code: "remote-branch-safe-delete",
      evidence: "merged PR branch has default-branch equivalence evidence",
      signals,
      input,
      prs,
      extra: { latestMergedPullRequest: latestMerged?.number || null },
    });
  }

  if (mergedPulls.length > 0) {
    signals.push(makeSignal({
      code: headMatchesMergedPr ? "merged-pr-branch-without-equivalence" : "post-merge-branch-moved",
      severity: SEVERITIES.OPERATOR,
      dimension: "remote-branch-hygiene",
      evidence: headMatchesMergedPr
        ? `${branchName} has merged PR history but no ancestry, tree, or patch equivalence evidence`
        : `${branchName} head differs from the latest merged PR head`,
      next: headMatchesMergedPr ? "verify-branch-equivalence-before-delete" : "inspect-post-merge-branch-commits",
      data: {
        pullRequests: mergedPulls.map((pr) => pr.number).filter(Boolean),
        branchHeadSha: headSha,
        latestMergedHeadSha: latestMerged?.headSha || null,
      },
    }));
    return result({
      branchName,
      disposition: REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW,
      code: "remote-branch-operator-review",
      evidence: "merged PR branch needs equivalence proof before cleanup",
      signals,
      input,
      prs,
    });
  }

  if (closedUnmergedPulls.length > 0) {
    signals.push(makeSignal({
      code: "closed-unmerged-pr-branch",
      severity: SEVERITIES.OPERATOR,
      dimension: "remote-branch-hygiene",
      evidence: `${branchName} is tied to closed unmerged pull request history`,
      next: "operator-decide-retain-or-delete-abandoned-branch",
      data: { pullRequests: closedUnmergedPulls.map((pr) => pr.number).filter(Boolean) },
    }));
  } else {
    signals.push(makeSignal({
      code: "unassociated-remote-branch",
      severity: SEVERITIES.OPERATOR,
      dimension: "remote-branch-hygiene",
      evidence: `${branchName} has no associated pull request facts`,
      next: "operator-classify-branch-owner-and-purpose",
    }));
  }

  return result({
    branchName,
    disposition: REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW,
    code: "remote-branch-operator-review",
    evidence: "remote branch is not a safe automatic cleanup candidate",
    signals,
    input,
    prs,
  });
}

export function classifyRemoteBranchSet(input = {}) {
  const defaultBranch = cleanBranchName(input.defaultBranch || "main");
  const pullRequests = list(input.pullRequests).map(normalizePullRequest);
  const verdicts = list(input.branches).map((branch) => {
    const branchName = cleanBranchName(branch.branchName || branch.name);
    const associatedPullRequests = pullRequests.filter((pr) => branchMatchesPull(branchName, pr));
    return classifyRemoteBranchHygiene({
      ...branch,
      branchName,
      defaultBranch,
      associatedPullRequests,
    });
  });

  const safeDelete = verdicts.filter((v) => v.disposition === REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE).length;
  const retain = verdicts.filter((v) => v.disposition === REMOTE_BRANCH_DISPOSITIONS.RETAIN).length;
  const operatorReview = verdicts.filter((v) => v.disposition === REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW).length;
  const blocking = verdicts.filter((v) => v.audit.blockingSignals.length > 0).length;
  const status = operatorReview > 0
    ? REMOTE_BRANCH_HYGIENE_STATUS.OPERATOR_REVIEW
    : safeDelete > 0
      ? REMOTE_BRANCH_HYGIENE_STATUS.CLEANUP_AVAILABLE
      : REMOTE_BRANCH_HYGIENE_STATUS.UP_TO_DATE;

  const summary = {
    total: verdicts.length,
    status,
    upToDate: status === REMOTE_BRANCH_HYGIENE_STATUS.UP_TO_DATE,
    notification: status === REMOTE_BRANCH_HYGIENE_STATUS.UP_TO_DATE
      ? "Remote branch hygiene is up to date."
      : status === REMOTE_BRANCH_HYGIENE_STATUS.CLEANUP_AVAILABLE
        ? `${safeDelete} stale merged remote branch(es) are safe-delete candidates.`
        : `${operatorReview} remote branch(es) require operator review.`,
    safeDelete,
    retain,
    operatorReview,
    blocking,
  };

  return {
    schema: "illuci.gitops.remote-branch-hygiene-set/1",
    defaultBranch,
    summary,
    verdicts,
  };
}

export default {
  REMOTE_BRANCH_DISPOSITIONS,
  REMOTE_BRANCH_HYGIENE_STATUS,
  classifyRemoteBranchHygiene,
  classifyRemoteBranchSet,
  normalizePullRequest,
};
