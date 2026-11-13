import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendPrClassificationTrace,
  buildPrClassificationRecord,
  parseNumstat,
  prClassificationTracePath,
  ratificationFromLabels,
} from "./pr-classification.js";

test("parseNumstat reads git numstat output into classifier facts", () => {
  assert.deepEqual(parseNumstat("10\t2\tcore/run.js\n-\t-\tdesign/export.docx\n"), [
    { path: "core/run.js", additions: 10, deletions: 2 },
    { path: "design/export.docx", additions: 0, deletions: 0 },
  ]);
});

test("ratificationFromLabels maps PR labels to explicit operator signals", () => {
  const r = ratificationFromLabels([
    "illuci:ratify-large-diff",
    "pr-shape:ratify-test-gap",
    "unrelated",
  ]);
  assert.equal(r.largeDiff, true);
  assert.equal(r.surfaceSpan, false);
  assert.equal(r.missingCompanions, false);
  assert.equal(r.testGap, true);
});

test("buildPrClassificationRecord carries shape readiness strategy and automation outcome", () => {
  const record = buildPrClassificationRecord({
    prNumber: 61,
    title: "[A8] Bind agent identity and work permits",
    labels: ["illuci:ratify-large-diff", "illuci:ratify-surface-span"],
    changedFiles: [
      { path: "core/governance/gitops/pr-classification.js", additions: 120, deletions: 0 },
      { path: "core/governance/gitops/pr-classification.test.js", additions: 80, deletions: 0 },
      { path: "BATCH_LOG.md", additions: 10, deletions: 0 },
      { path: "DECISION_REGISTRY.md", additions: 10, deletions: 0 },
    ],
    mergeStateStatus: "CLEAN",
    repositoryAllowsSquash: true,
  }, { timestamp: "2026-06-26T11:11:00.000Z" });

  assert.equal(record.schema, "illuci.gitops.pr-classification/1");
  assert.equal(record.subject.prNumber, 61);
  assert.equal(record.inputs.ratifications.largeDiff, true);
  assert.equal(record.verdicts.prShape.classifier, "illuci.gitops.pr-shape");
  assert.equal(record.verdicts.mergeReadiness.classifier, "illuci.gitops.merge-readiness");
  assert.equal(record.verdicts.mergeStrategy.strategy, "squash");
  assert.equal(record.automation.eligible, true);
  assert.equal(record.automation.strategy, "squash");
  assert.equal(record.outcome.selectedStrategy, "squash");
});

test("draft PRs are classified but not auto-merge eligible", () => {
  const record = buildPrClassificationRecord({
    isDraftPr: true,
    changedFiles: [
      { path: "README.md", additions: 1, deletions: 0 },
    ],
  });
  assert.equal(record.verdicts.mergeReadiness.allowed, false);
  assert.deepEqual(record.automation.blockedBy, ["merge-strategy", "draft-pr"]);
  assert.equal(record.automation.eligible, false);
});

test("terminal merged PRs classify as observed no-op before stale merge blockers", () => {
  const record = buildPrClassificationRecord({
    prNumber: 100,
    title: "[A15.4.7] Observe merge-in-progress terminal races",
    alreadyMerged: true,
    changedFiles: [
      { path: "core/governance/gitops/pr-automation.js", additions: 7, deletions: 3 },
      { path: "core/governance/gitops/pr-automation.test.js", additions: 44, deletions: 0 },
    ],
    mergeStateStatus: "UNKNOWN",
    pendingCheckCount: 0,
    failingCheckCount: 0,
    repositoryAllowsSquash: true,
  });
  assert.equal(record.verdicts.mergeReadiness.code, "terminal-observed-merged");
  assert.equal(record.verdicts.mergeReadiness.allowed, true);
  assert.deepEqual(record.verdicts.mergeReadiness.audit.blockingSignals, []);
  assert.equal(record.verdicts.mergeStrategy.strategy, "observed-merged");
  assert.equal(record.verdicts.mergeStrategy.allowed, true);
  assert.equal(record.verdicts.mergeStrategy.dimensions.idempotence.class, "idempotent");
  assert.equal(record.verdicts.mergeStrategy.dimensions.idempotence.retryPosture, "safe-retry");
  assert.deepEqual(record.verdicts.mergeStrategy.audit.blockingSignals, []);
  assert.equal(record.automation.eligible, false);
  assert.deepEqual(record.automation.blockedBy, []);
  assert.equal(record.outcome.allowed, true);
  assert.equal(record.outcome.selectedStrategy, "observed-merged");
});

test("coherent governed automation slices remain automation-eligible without span labels", () => {
  const record = buildPrClassificationRecord({
    prNumber: 63,
    title: "[A10] Add governed GitOps auto-merge actuator",
    labels: [],
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
    mergeStateStatus: "CLEAN",
    repositoryAllowsSquash: true,
  }, { timestamp: "2026-06-26T14:22:00.000Z" });

  assert.equal(record.inputs.ratifications.surfaceSpan, false);
  assert.equal(record.verdicts.prShape.allowed, true);
  assert.equal(record.verdicts.prShape.requiresOperator, false);
  assert.equal(record.verdicts.prShape.dimensions.coherence.kind, "governed-automation-slice");
  assert.equal(record.verdicts.mergeStrategy.strategy, "squash");
  assert.equal(record.automation.eligible, true);
});

test("appendPrClassificationTrace writes one JSONL record under the gitops data lane", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-classification-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    const record = buildPrClassificationRecord({
      id: "prc-test",
      changedFiles: ["README.md"],
    }, { timestamp: "2026-06-26T11:12:00.000Z" });
    const result = appendPrClassificationTrace(record);
    assert.equal(result.displayPath, ".illuci/data/gitops/pr-classifications/records.jsonl");
    assert.equal(result.path, prClassificationTracePath());
    assert.equal(existsSync(result.path), true);
    const lines = readFileSync(result.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, "prc-test");
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
