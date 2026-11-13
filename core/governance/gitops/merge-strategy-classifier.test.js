import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IDEMPOTENCE_CLASSES,
  MERGE_STRATEGIES,
  classifyGitopsIdempotence,
  classifyMergeReadiness,
  classifyMergeStrategy,
  classifyPrShape,
} from "./merge-strategy-classifier.js";

test("small governed source PR with tests and records has clear PR shape", () => {
  const r = classifyPrShape({
    changedFiles: [
      { path: "core/governance/gitops/merge-strategy-classifier.js", additions: 80, deletions: 10 },
      { path: "core/governance/gitops/merge-strategy-classifier.test.js", additions: 40, deletions: 0 },
      { path: "BATCH_LOG.md", additions: 10, deletions: 0 },
      { path: "DECISION_REGISTRY.md", additions: 10, deletions: 0 },
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.code, "pr-shape-clear");
  assert.equal(r.riskBand, "clear");
  assert.deepEqual(r.dimensions.surfaceClasses, ["governance-doc", "governance-source", "test"]);
});

test("generated or local output blocks PR shape", () => {
  const r = classifyPrShape({
    changedFiles: [
      { path: "design/export/GOVERNANCE.docx", additions: 0, deletions: 0 },
    ],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.riskBand, "block");
  assert.ok(r.audit.blockingSignals.includes("generated-or-local-output"));
});

test("large review diff is caution before the operator ceiling", () => {
  const r = classifyPrShape({
    changedFiles: [
      { path: "core/dispatch/run.js", additions: 360, deletions: 360 },
      { path: "core/dispatch/run.test.js", additions: 20, deletions: 0 },
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.riskBand, "caution");
  assert.ok(r.signals.some((signal) => signal.code === "diff-size-budget-exceeded"));
});

test("oversized diff routes to operator unless ratified", () => {
  const r = classifyPrShape({
    changedFileCount: 30,
    totalChangedLines: 1900,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.ok(r.audit.blockingSignals.includes("diff-size-operator-review"));

  const ratified = classifyPrShape({
    changedFileCount: 30,
    totalChangedLines: 1900,
    operatorRatifiedLargeDiff: true,
  });
  assert.equal(ratified.requiresOperator, false);
  assert.ok(!ratified.signals.some((signal) => signal.code === "diff-size-operator-review"));
});

test("wide surface span routes to operator", () => {
  const r = classifyPrShape({
    changedFiles: [
      "cli/illuci.mjs",
      "core/dispatch/run.js",
      "scripts/lint-source.mjs",
      ".github/workflows/ci-verify.yml",
      "package.json",
      "design/notes.md",
    ],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.ok(r.audit.blockingSignals.includes("surface-span-operator-review"));
});

test("coherent governed automation slices do not require surface-span ratification", () => {
  const r = classifyPrShape({
    changedFiles: [
      { path: ".github/workflows/pr-auto-merge.yml", additions: 98, deletions: 0 },
      { path: ".github/scripts/request-pr-auto-merge.mjs", additions: 147, deletions: 0 },
      { path: ".github/scripts/request-pr-auto-merge.test.mjs", additions: 56, deletions: 0 },
      { path: "cli/illuci.mjs", additions: 57, deletions: 5 },
      { path: "core/governance/gitops/pr-automation.js", additions: 684, deletions: 0 },
      { path: "core/governance/gitops/pr-automation.test.js", additions: 240, deletions: 0 },
      { path: "package.json", additions: 2, deletions: 2 },
      { path: "README.md", additions: 7, deletions: 5 },
      { path: "BATCH_LOG.md", additions: 25, deletions: 0 },
      { path: "DECISION_REGISTRY.md", additions: 10, deletions: 0 },
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.dimensions.coherence.kind, "governed-automation-slice");
  assert.equal(r.dimensions.coherence.surfaceSpanAccepted, true);
  assert.ok(r.signals.some((signal) => signal.code === "coherent-surface-span"));
  assert.ok(!r.audit.blockingSignals.includes("surface-span-operator-review"));
});

test("coherent governed runtime contract slices do not require surface-span ratification", () => {
  const r = classifyPrShape({
    changedFiles: [
      { path: "BATCH_LOG.md", additions: 31, deletions: 2 },
      { path: "COMPONENTS.md", additions: 4, deletions: 3 },
      { path: "DECISION_REGISTRY.md", additions: 12, deletions: 2 },
      { path: "FINDINGS.md", additions: 10, deletions: 2 },
      { path: "GOVERNANCE.md", additions: 7, deletions: 5 },
      { path: "MEMORY.md", additions: 4, deletions: 3 },
      { path: "ROADMAP.md", additions: 4, deletions: 3 },
      { path: "SESSION_STATE.md", additions: 7, deletions: 6 },
      { path: "VERSION", additions: 1, deletions: 1 },
      { path: "cli/illuci.mjs", additions: 9, deletions: 6 },
      { path: "core/governance/classifiers/cognitive-classifier.js", additions: 289, deletions: 0 },
      { path: "core/governance/classifiers/cognitive-classifier.test.js", additions: 89, deletions: 0 },
      { path: "core/topologies/frame.js", additions: 3, deletions: 0 },
      { path: "core/topologies/runner.js", additions: 179, deletions: 30 },
      { path: "core/topologies/runner.cognitive-classifier.test.js", additions: 103, deletions: 0 },
      { path: "package-lock.json", additions: 2, deletions: 2 },
      { path: "package.json", additions: 1, deletions: 1 },
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.riskBand, "caution");
  assert.equal(r.dimensions.coherence.kind, "governed-runtime-contract-slice");
  assert.equal(r.dimensions.coherence.surfaceSpanAccepted, true);
  assert.ok(r.signals.some((signal) => signal.code === "diff-size-budget-exceeded"));
  assert.ok(r.signals.some((signal) => signal.code === "coherent-surface-span"));
  assert.ok(!r.audit.blockingSignals.includes("surface-span-operator-review"));
});

test("governed outcome corpus slices do not require batch decision test or large diff ratification", () => {
  const r = classifyPrShape({
    changedFiles: [
      {
        path: "core/governance/gitops/corpus/pr-outcomes/outcomes/pr-00088.json",
        additions: 2100,
        deletions: 0,
      },
      {
        path: "core/governance/gitops/corpus/pr-outcomes/observations/pr-00088/probs-1782542332142-9f2c2e17.json",
        additions: 900,
        deletions: 0,
      },
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresOperator, false);
  assert.equal(r.dimensions.coherence.kind, "governed-outcome-corpus-slice");
  assert.equal(r.dimensions.coherence.corpusSubject, "pr-00088");
  assert.equal(r.dimensions.idempotence.class, IDEMPOTENCE_CLASSES.APPEND_ONLY);
  assert.equal(r.dimensions.idempotence.convergenceTarget, "subject-record");
  assert.equal(r.dimensions.idempotence.duplicatePolicy, "suppress");
  assert.deepEqual(r.dimensions.surfaceClasses, ["governance-corpus"]);
  assert.ok(r.signals.some((signal) => signal.code === "coherent-review-size"));
  assert.ok(!r.signals.some((signal) => signal.code === "diff-size-operator-review"));
  assert.ok(!r.signals.some((signal) => signal.code === "governance-change-missing-batch-record"));
  assert.ok(!r.signals.some((signal) => signal.code === "governance-change-missing-decision-record"));
  assert.ok(!r.signals.some((signal) => signal.code === "source-change-missing-tests"));
});

test("mixed outcome corpus and governance source remains ordinary governance shape", () => {
  const r = classifyPrShape({
    changedFiles: [
      "core/governance/gitops/corpus/pr-outcomes/outcomes/pr-00088.json",
      "core/governance/gitops/merge-strategy-classifier.js",
    ],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.notEqual(r.dimensions.coherence.kind, "governed-outcome-corpus-slice");
  assert.ok(r.audit.blockingSignals.includes("governance-change-missing-batch-record"));
  assert.ok(r.audit.blockingSignals.includes("governance-change-missing-decision-record"));
});

test("governance contract changes require batch and decision companions", () => {
  const r = classifyPrShape({
    changedFiles: [
      "core/governance/gitops/merge-strategy-classifier.js",
      "core/governance/gitops/merge-strategy-classifier.test.js",
    ],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.ok(r.audit.blockingSignals.includes("governance-change-missing-batch-record"));
  assert.ok(r.audit.blockingSignals.includes("governance-change-missing-decision-record"));
});

test("source changes without tests are caution signals", () => {
  const r = classifyPrShape({
    changedFiles: [
      "core/dispatch/run.js",
      "BATCH_LOG.md",
    ],
  });
  assert.equal(r.allowed, true);
  assert.equal(r.riskBand, "caution");
  assert.ok(r.signals.some((signal) => signal.code === "source-change-missing-tests"));
});

test("ordinary one-unit PR defaults to squash", () => {
  const r = classifyMergeStrategy({ commitCount: 3, reviewUnitCount: 1, batchCount: 1 });
  assert.equal(r.strategy, MERGE_STRATEGIES.SQUASH);
  assert.equal(r.allowed, true);
  assert.equal(r.code, "default-squash");
  assert.equal(r.schema, "illuci.governance.classifier-verdict/1");
  assert.equal(r.riskBand, "clear");
  assert.deepEqual(r.signals, []);
  assert.equal(r.dimensions.reviewShape.reviewUnitCount, 1);
  assert.equal(r.dimensions.idempotence.class, IDEMPOTENCE_CLASSES.CONVERGENT);
  assert.equal(r.dimensions.idempotence.retryPosture, "refetch-before-retry");
  assert.equal(r.dimensions.idempotence.convergenceTarget, "terminal-state");
  assert.equal(r.dimensions.idempotence.duplicatePolicy, "suppress-after-terminal");
});

test("terminal merged PRs carry idempotent no-op posture", () => {
  const r = classifyMergeStrategy({
    alreadyMerged: true,
    mergeStateStatus: "UNKNOWN",
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OBSERVED_MERGED);
  assert.equal(r.allowed, true);
  assert.equal(r.dimensions.idempotence.class, IDEMPOTENCE_CLASSES.IDEMPOTENT);
  assert.equal(r.dimensions.idempotence.retryPosture, "safe-retry");
  assert.equal(r.dimensions.idempotence.convergenceTarget, "terminal-state");
  assert.equal(r.dimensions.idempotence.duplicatePolicy, "suppress");
  assert.equal(r.dimensions.idempotence.raceHandling, "terminal-noop");
});

test("unprotected rollback is classified as destructive idempotence posture", () => {
  const r = classifyGitopsIdempotence({
    isRollback: true,
    protectedBase: false,
    branchProtectionRequiresPr: false,
  });
  assert.equal(r.class, IDEMPOTENCE_CLASSES.DESTRUCTIVE);
  assert.equal(r.authority, "operator-required");
  assert.equal(r.retryPosture, "operator-before-retry");
  assert.equal(r.duplicatePolicy, "block");
});

test("aggregate or multi-batch PRs require split or operator ratification", () => {
  const r = classifyMergeStrategy({ reviewUnitCount: 4, batchCount: 4 });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.code, "split-required");
  assert.equal(r.next, "split-pr");
});

test("repository rejection of expected merge method stops instead of improvising", () => {
  const r = classifyMergeStrategy({ requestedStrategy: "merge-commit", githubRejectedExpectedStrategy: true });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "expected-strategy-rejected");
  assert.match(r.evidence, /stop/);
});

test("rebase is denied without explicit ratification and independently reviewed commits", () => {
  const r = classifyMergeStrategy({ requestedStrategy: "rebase", repositoryAllowsRebase: true });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "rebase-needs-ratification");
});

test("rebase is allowed only for ratified commit-series preservation", () => {
  const r = classifyMergeStrategy({
    requestedStrategy: "rebase",
    repositoryAllowsRebase: true,
    operatorRatifiedStrategy: true,
    commitsAreIndependentlyReviewable: true,
    preserveCommitSeries: true,
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.REBASE);
  assert.equal(r.allowed, true);
  assert.equal(r.code, "ratified-rebase");
  assert.equal(r.dimensions.idempotence.authority, "narrow");
  assert.equal(r.dimensions.idempotence.retryPosture, "refetch-before-retry");
});

test("merge commits are denied when the repository disables them", () => {
  const r = classifyMergeStrategy({
    requestedStrategy: "merge-commit",
    repositoryAllowsMergeCommit: false,
    operatorRatifiedStrategy: true,
    preserveCommitSeries: true,
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "merge-commit-disabled");
});

test("protected rollback uses revert PR, not force-push", () => {
  const r = classifyMergeStrategy({ isRollback: true, branchProtectionRequiresPr: true, protectedBase: true });
  assert.equal(r.strategy, MERGE_STRATEGIES.REVERT_PR);
  assert.equal(r.allowed, true);
  assert.equal(r.code, "protected-rollback");
});

test("stacked PRs are an explicit review shape", () => {
  const r = classifyMergeStrategy({ isStackedPr: true });
  assert.equal(r.strategy, MERGE_STRATEGIES.STACKED_PR);
  assert.equal(r.allowed, true);
  assert.equal(r.next, "merge-or-retarget-in-stack-order");
});

test("dirty PRs that touch ledgers stop for operator-ratified resequencing", () => {
  const r = classifyMergeStrategy({
    mergeStateStatus: "DIRTY",
    touchesAppendOnlyLedgers: true,
    ledgerEntryCount: 1,
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresOperator, true);
  assert.equal(r.code, "merge-state-dirty");
  assert.equal(r.next, "operator-ratify-ledger-resequence");
  assert.equal(r.riskBand, "operator");
  assert.ok(r.signals.some((signal) => signal.code === "merge-state-dirty"));
});

test("unpushed local commits are classified as publication hazards, not PR truth", () => {
  const r = classifyMergeStrategy({
    localBranchAheadOfRemote: 2,
    hasUnpushedLocalCommits: true,
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "local-branch-ahead");
  assert.equal(r.next, "decide-push-or-discard-local-commits");
  assert.equal(r.dimensions.publication.localBranchAheadOfRemote, 2);
});

test("base movement after checks blocks stale verification", () => {
  const r = classifyMergeReadiness({
    baseShaAtChecks: "abc",
    currentBaseSha: "def",
  });
  assert.equal(r.allowed, false);
  assert.equal(r.code, "readiness-hazards");
  assert.equal(r.riskBand, "block");
  assert.ok(r.audit.blockingSignals.includes("checks-base-stale"));
});

test("branch update merge commits require strategy ratification before continuing", () => {
  const r = classifyMergeStrategy({
    containsUnpushedMergeCommit: true,
    branchUpdateIntroducesMergeCommit: true,
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "unratified-branch-update-merge");
  assert.equal(r.next, "operator-ratify-update-strategy");
});

test("merge strategy stops when PR shape blocks readiness", () => {
  const r = classifyMergeStrategy({
    changedFiles: [
      "core/governance/gitops/merge-strategy-classifier.js",
      "artifacts/docx/GOVERNANCE.docx",
    ],
  });
  assert.equal(r.strategy, MERGE_STRATEGIES.OPERATOR_DECISION);
  assert.equal(r.allowed, false);
  assert.equal(r.code, "generated-or-local-output");
  assert.equal(r.next, "remove-generated-or-local-output");
  assert.equal(r.dimensions.idempotence.class, IDEMPOTENCE_CLASSES.NON_IDEMPOTENT);
  assert.equal(r.dimensions.idempotence.authority, "pause");
});
