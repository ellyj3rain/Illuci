// illuci/core/governance/gitops/pr-classification.js
//
// Source-owned PR governance trace builder. It packages PR shape, merge
// readiness, and merge strategy classifier output into one replayable record.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { runtimeDataPath } from "../../data/paths.js";
import { MERGE_STRATEGIES, classifyMergeReadiness, classifyMergeStrategy, classifyPrShape } from "./merge-strategy-classifier.js";
// [A24.2] The role-aware tier layer (PR-shape v1 + tier doctrine, DR-115) rides
// the same record additively: verdicts.prShapeTier + outcome.tier.
import { classifyPrShapeTiers } from "./pr-shape-tiers.js";

export const PR_CLASSIFICATION_SCHEMA = "illuci.gitops.pr-classification/1";
export const PR_CLASSIFICATION_RECORDS_RELPATH = ".illuci/data/gitops/pr-classifications/records.jsonl";

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function int(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function bool(value) {
  return value === true;
}

function normalizeChangedFile(entry) {
  if (typeof entry === "string") return { path: normalizePath(entry), additions: 0, deletions: 0 };
  if (!entry || typeof entry !== "object") return null;
  const path = normalizePath(entry.path || entry.filename || entry.name);
  if (!path) return null;
  return {
    path,
    additions: int(entry.additions ?? entry.addedLines, 0),
    deletions: int(entry.deletions ?? entry.removedLines, 0),
  };
}

export function normalizeChangedFiles(changedFiles = []) {
  return Array.isArray(changedFiles)
    ? changedFiles.map(normalizeChangedFile).filter((entry) => entry && entry.path)
    : [];
}

export function parseNumstat(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
      const path = normalizePath(pathParts.join("\t"));
      return {
        path,
        additions: additionsRaw === "-" ? 0 : Number(additionsRaw) || 0,
        deletions: deletionsRaw === "-" ? 0 : Number(deletionsRaw) || 0,
      };
    })
    .filter((file) => file.path);
}

export function normalizeLabels(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => typeof label === "string" && label.trim())
    .map((label) => label.trim().toLowerCase())
    .sort();
}

export function labelsFromGitHubEvent(event = {}) {
  const labels = event?.pull_request?.labels || event?.issue?.labels || event?.labels || [];
  return normalizeLabels(labels);
}

export function ratificationFromLabels(labels = []) {
  const set = new Set(normalizeLabels(labels));
  const has = (...names) => names.some((name) => set.has(name));
  return {
    largeDiff: has("illuci:ratify-large-diff", "pr-shape:ratify-large-diff"),
    surfaceSpan: has("illuci:ratify-surface-span", "pr-shape:ratify-surface-span"),
    missingCompanions: has("illuci:ratify-missing-companions", "pr-shape:ratify-missing-companions"),
    testGap: has("illuci:ratify-test-gap", "pr-shape:ratify-test-gap"),
  };
}

function explicitRatification(input, key) {
  const value = input[`operatorRatified${key}`];
  return value === true;
}

function buildClassifierFacts(input, labels, labelRatification, changedFiles) {
  return {
    ...input,
    subject: input.subject || (input.prNumber ? `PR #${input.prNumber}` : "pull-request"),
    changedFiles,
    labels,
    operatorRatifiedLargeDiff: explicitRatification(input, "LargeDiff") || labelRatification.largeDiff,
    operatorRatifiedSurfaceSpan: explicitRatification(input, "SurfaceSpan") || labelRatification.surfaceSpan,
    operatorRatifiedMissingCompanions: explicitRatification(input, "MissingCompanions") || labelRatification.missingCompanions,
    operatorRatifiedTestGap: explicitRatification(input, "TestGap") || labelRatification.testGap,
  };
}

function requiredActionFor(record) {
  const blocking = [
    ...record.verdicts.mergeStrategy.signals,
    ...record.verdicts.mergeReadiness.signals,
    ...record.verdicts.prShape.signals,
  ].find((signal) => signal.severity === "block" || signal.severity === "operator");
  if (blocking?.next) return blocking.next;
  return record.verdicts.mergeStrategy.next || record.verdicts.mergeReadiness.next || record.verdicts.prShape.next;
}

function autoMergeEligibility({ facts, mergeStrategy }) {
  const strategy = mergeStrategy.strategy || null;
  const terminalObserved = strategy === MERGE_STRATEGIES.OBSERVED_MERGED;
  const strategyAllowed = mergeStrategy.allowed && !mergeStrategy.requiresOperator && strategy && strategy !== "operator-decision" && !terminalObserved;
  const eligible = Boolean(strategyAllowed && !facts.isDraftPr && int(facts.failingCheckCount, 0) === 0);
  const blockedBy = [];
  if (!strategyAllowed && !terminalObserved) blockedBy.push("merge-strategy");
  if (facts.isDraftPr) blockedBy.push("draft-pr");
  if (int(facts.failingCheckCount, 0) > 0) blockedBy.push("failing-checks");
  return {
    eligible,
    strategy: eligible ? strategy : null,
    blockedBy,
  };
}

export function buildPrClassificationRecord(input = {}, options = {}) {
  const timestamp = options.timestamp || input.timestamp || new Date().toISOString();
  const labels = normalizeLabels(input.labels);
  const labelRatification = ratificationFromLabels(labels);
  const changedFiles = normalizeChangedFiles(input.changedFiles || []);
  const facts = buildClassifierFacts(input, labels, labelRatification, changedFiles);
  const prShape = classifyPrShape(facts);
  const prShapeTier = classifyPrShapeTiers({ ...facts, closure: input.closure, governanceManifests: input.governanceManifests });
  const mergeReadiness = classifyMergeReadiness(facts);
  const mergeStrategy = classifyMergeStrategy(facts);
  const record = {
    schema: PR_CLASSIFICATION_SCHEMA,
    id: input.id || `prc-${Date.parse(timestamp) || Date.now()}-${randomUUID().slice(0, 8)}`,
    timestamp,
    source: input.source || "illuci.gitops.pr-classification",
    subject: {
      kind: "pull-request",
      prNumber: input.prNumber ? int(input.prNumber) : null,
      title: input.title || null,
      url: input.url || null,
      repository: input.repository || null,
      baseRef: input.baseRef || input.baseRefName || null,
      headRef: input.headRef || input.headRefName || null,
      baseSha: input.baseSha || null,
      headSha: input.headSha || null,
    },
    inputs: {
      changedFiles,
      labels,
      ratifications: {
        largeDiff: facts.operatorRatifiedLargeDiff,
        surfaceSpan: facts.operatorRatifiedSurfaceSpan,
        missingCompanions: facts.operatorRatifiedMissingCompanions,
        testGap: facts.operatorRatifiedTestGap,
      },
      mergeStateStatus: input.mergeStateStatus || null,
      requestedStrategy: input.requestedStrategy || null,
      isDraftPr: bool(input.isDraftPr),
      pendingCheckCount: int(input.pendingCheckCount, 0),
      failingCheckCount: int(input.failingCheckCount, 0),
      reviewUnitCount: int(input.reviewUnitCount, 1),
      batchCount: int(input.batchCount, 1),
      localBranchAheadOfRemote: int(input.localBranchAheadOfRemote, 0),
      hasUnpushedLocalCommits: bool(input.hasUnpushedLocalCommits),
    },
    verdicts: {
      prShape,
      prShapeTier,
      mergeReadiness,
      mergeStrategy,
    },
    automation: autoMergeEligibility({ facts, mergeStrategy }),
    outcome: {
      allowed: mergeStrategy.allowed,
      requiresOperator: mergeStrategy.requiresOperator,
      riskBand: mergeStrategy.riskBand,
      selectedStrategy: mergeStrategy.allowed ? mergeStrategy.strategy : null,
      tier: prShapeTier.dimensions.tier,
      next: requiredActionFor({ verdicts: { prShape, mergeReadiness, mergeStrategy } }),
    },
  };
  return record;
}

export function prClassificationTracePath() {
  return runtimeDataPath("gitops", join("pr-classifications", "records.jsonl"));
}

export function appendPrClassificationTrace(record) {
  const path = prClassificationTracePath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return {
    ok: true,
    path,
    displayPath: PR_CLASSIFICATION_RECORDS_RELPATH,
    recordId: record.id,
  };
}

export default {
  PR_CLASSIFICATION_SCHEMA,
  PR_CLASSIFICATION_RECORDS_RELPATH,
  appendPrClassificationTrace,
  buildPrClassificationRecord,
  labelsFromGitHubEvent,
  normalizeChangedFiles,
  normalizeLabels,
  parseNumstat,
  prClassificationTracePath,
  ratificationFromLabels,
};
