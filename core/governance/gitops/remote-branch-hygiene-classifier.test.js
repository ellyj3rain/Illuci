import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REMOTE_BRANCH_HYGIENE_STATUS,
  REMOTE_BRANCH_DISPOSITIONS,
  classifyRemoteBranchHygiene,
  classifyRemoteBranchSet,
} from "./remote-branch-hygiene-classifier.js";

test("merged PR branch with tree equivalence is a safe-delete candidate", () => {
  const r = classifyRemoteBranchHygiene({
    branchName: "mallowfluff-empty-bloat-cleanup",
    defaultBranch: "main",
    headSha: "79fc6ef270efacb7c4641f955d0f7d6056ab3646",
    isTreeEquivalentToDefault: true,
    associatedPullRequests: [{
      number: 56,
      state: "closed",
      mergedAt: "2026-06-26T05:34:35Z",
      headRefName: "mallowfluff-empty-bloat-cleanup",
      headSha: "79fc6ef270efacb7c4641f955d0f7d6056ab3646",
    }],
  });
  assert.equal(r.disposition, REMOTE_BRANCH_DISPOSITIONS.SAFE_DELETE);
  assert.equal(r.deletable, true);
  assert.equal(r.code, "remote-branch-safe-delete");
  assert.equal(r.riskBand, "watch");
  assert.ok(r.signals.some((signal) => signal.code === "stale-merged-pr-branch"));
});

test("open PR head branches are retained", () => {
  const r = classifyRemoteBranchHygiene({
    branchName: "feature/live-pr",
    associatedPullRequests: [{
      number: 60,
      state: "open",
      headRefName: "feature/live-pr",
    }],
  });
  assert.equal(r.disposition, REMOTE_BRANCH_DISPOSITIONS.RETAIN);
  assert.equal(r.deletable, false);
  assert.equal(r.allowed, true);
  assert.equal(r.signals[0].code, "open-pr-head-branch");
});

test("default and protected branches are never cleanup candidates", () => {
  const main = classifyRemoteBranchHygiene({ branchName: "main", defaultBranch: "main" });
  assert.equal(main.disposition, REMOTE_BRANCH_DISPOSITIONS.RETAIN);
  assert.equal(main.deletable, false);
  assert.equal(main.signals[0].code, "default-branch-retained");

  const protectedBranch = classifyRemoteBranchHygiene({ branchName: "release", protected: true });
  assert.equal(protectedBranch.disposition, REMOTE_BRANCH_DISPOSITIONS.RETAIN);
  assert.equal(protectedBranch.signals[0].code, "protected-branch-retained");
});

test("merged PR branch without equivalence proof routes to operator", () => {
  const r = classifyRemoteBranchHygiene({
    branchName: "feature/squashed-but-unverified",
    associatedPullRequests: [{
      number: 61,
      state: "closed",
      mergedAt: "2026-06-26T05:34:35Z",
      headRefName: "feature/squashed-but-unverified",
    }],
  });
  assert.equal(r.disposition, REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.deletable, false);
  assert.ok(r.audit.blockingSignals.includes("merged-pr-branch-without-equivalence"));
});

test("closed unmerged and unassociated branches are operator-routed", () => {
  const closed = classifyRemoteBranchHygiene({
    branchName: "feature/abandoned",
    associatedPullRequests: [{
      number: 49,
      state: "closed",
      headRefName: "feature/abandoned",
    }],
  });
  assert.equal(closed.disposition, REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW);
  assert.ok(closed.audit.blockingSignals.includes("closed-unmerged-pr-branch"));

  const orphan = classifyRemoteBranchHygiene({ branchName: "feature/no-pr" });
  assert.equal(orphan.disposition, REMOTE_BRANCH_DISPOSITIONS.OPERATOR_REVIEW);
  assert.ok(orphan.audit.blockingSignals.includes("unassociated-remote-branch"));
});

test("branch set associates PRs by headRefName and summarizes dispositions", () => {
  const r = classifyRemoteBranchSet({
    defaultBranch: "main",
    branches: [
      { name: "main" },
      { name: "merged", isPatchEquivalentToDefault: true },
      { name: "orphan" },
    ],
    pullRequests: [
      { number: 10, state: "closed", mergedAt: "now", headRefName: "merged" },
    ],
  });
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.status, REMOTE_BRANCH_HYGIENE_STATUS.OPERATOR_REVIEW);
  assert.equal(r.summary.upToDate, false);
  assert.equal(r.summary.retain, 1);
  assert.equal(r.summary.safeDelete, 1);
  assert.equal(r.summary.operatorReview, 1);
});

test("branch set reports up-to-date status when only retained branches remain", () => {
  const r = classifyRemoteBranchSet({
    defaultBranch: "main",
    branches: [
      { name: "main" },
      { name: "live-pr" },
    ],
    pullRequests: [
      { number: 11, state: "open", headRefName: "live-pr" },
    ],
  });
  assert.equal(r.summary.status, REMOTE_BRANCH_HYGIENE_STATUS.UP_TO_DATE);
  assert.equal(r.summary.upToDate, true);
  assert.match(r.summary.notification, /up to date/);
  assert.equal(r.summary.safeDelete, 0);
  assert.equal(r.summary.operatorReview, 0);
});

test("branch set reports cleanup-available status for safe-delete branches", () => {
  const r = classifyRemoteBranchSet({
    defaultBranch: "main",
    branches: [
      { name: "main" },
      { name: "merged", isPatchEquivalentToDefault: true },
    ],
    pullRequests: [
      { number: 10, state: "closed", mergedAt: "now", headRefName: "merged" },
    ],
  });
  assert.equal(r.summary.status, REMOTE_BRANCH_HYGIENE_STATUS.CLEANUP_AVAILABLE);
  assert.equal(r.summary.upToDate, false);
  assert.match(r.summary.notification, /safe-delete candidates/);
});
