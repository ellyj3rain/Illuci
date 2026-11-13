// illuci/core/governance/gitops/merge-strategy-classifier.js
//
// Pure GitOps merge-strategy classifier. This is intentionally independent of
// GitHub API state so callers can feed it PR metadata, branch-protection facts,
// ledger facts, local branch state, and operator ratification evidence from any
// host.

import { SEVERITIES, bool, int, list, makeGovernedVerdict, makeSignal, norm } from "../classifiers/governed-verdict.js";

export const MERGE_STRATEGIES = Object.freeze({
  SQUASH: "squash",
  REBASE: "rebase",
  MERGE_COMMIT: "merge-commit",
  REVERT_PR: "revert-pr",
  STACKED_PR: "stacked-pr",
  OBSERVED_MERGED: "observed-merged",
  OPERATOR_DECISION: "operator-decision",
});

export const IDEMPOTENCE_CLASSES = Object.freeze({
  IDEMPOTENT: "idempotent",
  CONVERGENT: "convergent",
  APPEND_ONLY: "append-only",
  NON_IDEMPOTENT: "non-idempotent",
  DESTRUCTIVE: "destructive",
});

export const PR_SHAPE_DEFAULT_BUDGET = Object.freeze({
  maxFiles: 12,
  maxChangedLines: 700,
  operatorFiles: 28,
  operatorChangedLines: 1800,
  maxSurfaceClasses: 5,
});

const ROOT_GOVERNANCE_FILES = new Set([
  "AGENTS.md",
  "ARCHITECTURE.md",
  "BATCH_LOG.md",
  "CLAUDE.md",
  "COMPONENTS.md",
  "CONTEXT.md",
  "CORE.md",
  "DECISION_REGISTRY.md",
  "DOCTRINE.md",
  "FINDINGS.md",
  "GOVERNANCE.md",
  "HIVEMIND.md",
  "ILLUCI.md",
  "README.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
  "VERSION",
]);

const DECISION_REQUIRED_GOVERNANCE_FILES = new Set([
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CLAUDE.md",
  "COMPONENTS.md",
  "CORE.md",
  "DECISION_REGISTRY.md",
  "DOCTRINE.md",
  "GOVERNANCE.md",
  "HIVEMIND.md",
  "ILLUCI.md",
]);

const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json"]);
const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__)\/|[./](?:test|spec)\.(?:[cm]?js|jsx|tsx?|mjs)$/i;
const GENERATED_OUTPUT_RE = /\.(?:docx|pdf|tgz|zip|tar|gz|xlsx|pptx)$/i;
const LOCAL_STATE_PREFIXES = Object.freeze([
  ".illuci/data/",
  ".illuci/ide.local/",
  ".illuci-sandboxes/",
  ".idea/",
  "node_modules/",
  "coverage/",
  "dist/",
  "build/",
  "artifacts/docx/",
]);
const LOCAL_STATE_FILES = new Set([".illuci/bridge.local.json", ".env", "envarapi.env"]);
const PR_OUTCOME_CORPUS_PREFIX = "core/governance/gitops/corpus/pr-outcomes/";
const GOVERNED_AUTOMATION_CLASSES = new Set([
  "ci",
  "cli",
  "docs",
  "governance-doc",
  "governance-source",
  "package",
  "test",
  "tooling",
]);
const GOVERNED_RUNTIME_CONTRACT_CLASSES = new Set([
  "cli",
  "docs",
  "governance-doc",
  "governance-source",
  "package",
  "runtime-source",
  "test",
]);
const PR_COHERENCE_CLASSES = new Set([
  ...GOVERNED_AUTOMATION_CLASSES,
  ...GOVERNED_RUNTIME_CONTRACT_CLASSES,
  "governance-corpus",
]);
const SOURCE_SURFACE_CLASSES = new Set([
  "ci",
  "cli",
  "governance-corpus",
  "governance-source",
  "package",
  "runtime-source",
  "tooling",
]);

function result(strategy, allowed, code, evidence, extra = {}) {
  const verdict = makeGovernedVerdict({
    classifier: "illuci.gitops.merge-strategy",
    subject: extra.subject || "pull-request",
    decision: strategy,
    strategy,
    allowed,
    requiresOperator: extra.requiresOperator,
    code,
    evidence,
    next: extra.next || null,
    confidence: extra.confidence,
    dimensions: extra.dimensions,
    signals: extra.signals,
  });

  // Keep the original public fields stable while carrying the richer verdict.
  return {
    strategy: verdict.strategy,
    allowed: verdict.allowed,
    requiresOperator: verdict.requiresOperator,
    code: verdict.code,
    evidence: verdict.evidence,
    next: verdict.next,
    confidence: verdict.confidence,
    riskBand: verdict.riskBand,
    riskScore: verdict.riskScore,
    dimensions: verdict.dimensions,
    signals: verdict.signals,
    audit: verdict.audit,
    schema: verdict.schema,
    classifier: verdict.classifier,
    subject: verdict.subject,
    decision: verdict.decision,
  };
}

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function baseName(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function startsWithAny(path, prefixes) {
  const normalized = normalizePath(path);
  return prefixes.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix));
}

function changedFileRecord(entry) {
  if (typeof entry === "string") {
    return { path: normalizePath(entry), additions: 0, deletions: 0 };
  }
  if (!entry || typeof entry !== "object") return null;
  const path = normalizePath(entry.path || entry.filename || entry.name);
  if (!path) return null;
  return {
    path,
    additions: int(entry.additions ?? entry.addedLines, 0),
    deletions: int(entry.deletions ?? entry.removedLines, 0),
  };
}

function normalizeChangedFiles(input) {
  return list(input)
    .map(changedFileRecord)
    .filter((entry) => entry && entry.path);
}

function isLocalStatePath(path) {
  const normalized = normalizePath(path);
  return LOCAL_STATE_FILES.has(normalized) || startsWithAny(normalized, LOCAL_STATE_PREFIXES);
}

function isGeneratedOutputPath(path) {
  const normalized = normalizePath(path);
  return GENERATED_OUTPUT_RE.test(normalized) || startsWithAny(normalized, ["artifacts/generated/", ".illuci/runtime/"]);
}

function isTestPath(path) {
  return TEST_PATH_RE.test(normalizePath(path));
}

function outcomeCorpusKey(path) {
  const normalized = normalizePath(path);
  if (!normalized.startsWith(PR_OUTCOME_CORPUS_PREFIX) || !normalized.endsWith(".json")) return null;
  const rest = normalized.slice(PR_OUTCOME_CORPUS_PREFIX.length);
  const match = rest.match(/(?:^|\/)(pr-\d{5})(?:\.json|\/)/);
  return match ? match[1] : null;
}

function isOutcomeCorpusPath(path) {
  return outcomeCorpusKey(path) !== null;
}

// [A24.2] Exported: the pr-shape-tiers role tagger builds its role vocabulary ON
// this surface-class read (extend-never-fork — one owner of path classification).
export function surfaceClassForPath(path) {
  const normalized = normalizePath(path);
  const file = baseName(normalized);
  if (isLocalStatePath(normalized)) return "local-state";
  if (isGeneratedOutputPath(normalized)) return "generated-output";
  if (isTestPath(normalized)) return "test";
  if (normalized.startsWith(".github/")) return "ci";
  if (PACKAGE_FILES.has(normalized)) return "package";
  if (normalized.startsWith("constitutional/")) return "constitutional-mirror";
  if (isOutcomeCorpusPath(normalized)) return "governance-corpus";
  if (normalized.startsWith("core/governance/")) return "governance-source";
  if (ROOT_GOVERNANCE_FILES.has(file) && !normalized.includes("/")) return "governance-doc";
  if (normalized.startsWith("cli/")) return "cli";
  if (normalized.startsWith("core/")) return "runtime-source";
  if (normalized.startsWith("scripts/")) return "tooling";
  if (normalized.startsWith("design/") || normalized.endsWith(".md")) return "docs";
  return "other";
}

function prShapeBudget(input) {
  const overrides = input && typeof input.diffSizeBudget === "object" ? input.diffSizeBudget : {};
  return {
    maxFiles: int(overrides.maxFiles, PR_SHAPE_DEFAULT_BUDGET.maxFiles),
    maxChangedLines: int(overrides.maxChangedLines, PR_SHAPE_DEFAULT_BUDGET.maxChangedLines),
    operatorFiles: int(overrides.operatorFiles, PR_SHAPE_DEFAULT_BUDGET.operatorFiles),
    operatorChangedLines: int(overrides.operatorChangedLines, PR_SHAPE_DEFAULT_BUDGET.operatorChangedLines),
    maxSurfaceClasses: int(overrides.maxSurfaceClasses, PR_SHAPE_DEFAULT_BUDGET.maxSurfaceClasses),
  };
}

function totalLines(input, changedFiles) {
  if (Number.isFinite(Number(input.totalChangedLines))) return Math.max(0, Number(input.totalChangedLines));
  if (changedFiles.length > 0) return changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  return int(input.additions, 0) + int(input.deletions, 0);
}

function filesByClass(changedFiles) {
  const byClass = {};
  for (const file of changedFiles) {
    const surfaceClass = surfaceClassForPath(file.path);
    byClass[surfaceClass] ||= [];
    byClass[surfaceClass].push(file.path);
  }
  return byClass;
}

function hasPath(changedFiles, path) {
  return changedFiles.some((file) => file.path === path);
}

function coherenceProfile({ changedFiles, byClass, surfaceClasses, generatedFiles }) {
  const hasBatchLog = hasPath(changedFiles, "BATCH_LOG.md");
  const hasDecisionRegistry = hasPath(changedFiles, "DECISION_REGISTRY.md");
  const hasTests = surfaceClasses.includes("test");
  const hasGovernanceSource = surfaceClasses.includes("governance-source");
  const hasRuntimeSource = surfaceClasses.includes("runtime-source");
  const corpusKeys = new Set(changedFiles.map((file) => outcomeCorpusKey(file.path)).filter(Boolean));
  const onlyOutcomeCorpus = changedFiles.length > 0 && changedFiles.every((file) => isOutcomeCorpusPath(file.path));
  const allClassesRecognized = surfaceClasses.every((surfaceClass) => GOVERNED_AUTOMATION_CLASSES.has(surfaceClass));
  const allRuntimeContractClassesRecognized = surfaceClasses.every((surfaceClass) =>
    GOVERNED_RUNTIME_CONTRACT_CLASSES.has(surfaceClass),
  );
  const hasGeneratedOrLocal = generatedFiles.length > 0;
  const profile = {
    kind: null,
    coherent: false,
    surfaceSpanAccepted: false,
    reviewBudgetAccepted: false,
    requiredCompanions: {
      batchLog: hasBatchLog,
      decisionRegistry: hasDecisionRegistry,
      tests: hasTests,
    },
    recognizedSurfaceClasses: surfaceClasses.filter((surfaceClass) => PR_COHERENCE_CLASSES.has(surfaceClass)),
    unrecognizedSurfaceClasses: surfaceClasses.filter((surfaceClass) => !PR_COHERENCE_CLASSES.has(surfaceClass)),
  };

  if (onlyOutcomeCorpus && corpusKeys.size === 1 && !hasGeneratedOrLocal) {
    return {
      ...profile,
      kind: "governed-outcome-corpus-slice",
      coherent: true,
      surfaceSpanAccepted: true,
      reviewBudgetAccepted: true,
      corpusSubject: [...corpusKeys][0],
      sourceFiles: {
        "governance-corpus": [...(byClass["governance-corpus"] || [])],
      },
    };
  }

  if (
    hasGovernanceSource &&
    hasRuntimeSource &&
    hasBatchLog &&
    hasDecisionRegistry &&
    hasTests &&
    allRuntimeContractClassesRecognized &&
    !hasGeneratedOrLocal
  ) {
    return {
      ...profile,
      kind: "governed-runtime-contract-slice",
      coherent: true,
      surfaceSpanAccepted: true,
      sourceFiles: Object.fromEntries(
        Object.entries(byClass)
          .filter(([surfaceClass]) => SOURCE_SURFACE_CLASSES.has(surfaceClass))
          .map(([surfaceClass, files]) => [surfaceClass, files]),
      ),
    };
  }

  if (
    hasGovernanceSource &&
    hasBatchLog &&
    hasDecisionRegistry &&
    hasTests &&
    allClassesRecognized &&
    !hasGeneratedOrLocal &&
    ["ci", "cli", "package", "tooling"].some((surfaceClass) => surfaceClasses.includes(surfaceClass))
  ) {
    return {
      ...profile,
      kind: "governed-automation-slice",
      coherent: true,
      surfaceSpanAccepted: true,
      sourceFiles: Object.fromEntries(
        Object.entries(byClass)
          .filter(([surfaceClass]) => SOURCE_SURFACE_CLASSES.has(surfaceClass))
          .map(([surfaceClass, files]) => [surfaceClass, files]),
      ),
    };
  }

  return profile;
}

function idempotenceProfile(input = {}) {
  return {
    class: input.class || IDEMPOTENCE_CLASSES.CONVERGENT,
    retryPosture: input.retryPosture || "refetch-before-retry",
    convergenceTarget: input.convergenceTarget || "terminal-state",
    duplicatePolicy: input.duplicatePolicy || "suppress-after-terminal",
    raceHandling: input.raceHandling || "terminal-noop-after-refetch",
    authority: input.authority || "proceed",
    evidence: input.evidence || "operation converges when callers refetch live state before retry",
  };
}

function prShapeIdempotenceProfile({ changedFiles, generatedFiles, coherence }) {
  if (generatedFiles.length > 0) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.NON_IDEMPOTENT,
      retryPosture: "operator-before-retry",
      convergenceTarget: "source-boundary",
      duplicatePolicy: "block",
      raceHandling: "operator-route",
      authority: "pause",
      evidence: "generated or local runtime output in source shape cannot be retried as source truth",
    });
  }

  if (coherence.kind === "governed-outcome-corpus-slice") {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.APPEND_ONLY,
      retryPosture: "safe-retry",
      convergenceTarget: "subject-record",
      duplicatePolicy: "suppress",
      raceHandling: "compare-and-swap",
      evidence: "single-subject outcome corpus records are append-only source evidence with subject-key duplicate suppression",
    });
  }

  if (changedFiles.length === 0) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.IDEMPOTENT,
      retryPosture: "safe-retry",
      convergenceTarget: "no-source-change",
      duplicatePolicy: "suppress",
      raceHandling: "terminal-noop",
      evidence: "no changed source files were present",
    });
  }

  return idempotenceProfile({
    class: IDEMPOTENCE_CLASSES.CONVERGENT,
    retryPosture: "refetch-before-retry",
    convergenceTarget: "review-unit",
    duplicatePolicy: "update",
    raceHandling: "compare-and-swap",
    evidence: "source review units converge when rebuilt against the current base before retry",
  });
}

export function classifyGitopsIdempotence(input = {}, context = {}) {
  const aggregate = context.aggregate || aggregateSignals(input);
  const prShape = context.prShape || classifyPrShape(input);
  const prShapeIdempotence = prShape.dimensions?.idempotence || idempotenceProfile();
  const requested = norm(input.requestedStrategy);
  const rollback = bool(input.isRollback) || norm(input.purpose) === "rollback";
  const protectedRollback = rollback && (bool(input.branchProtectionRequiresPr) || bool(input.protectedBase));
  const ledgerTouched =
    bool(input.touchesAppendOnlyLedgers) ||
    bool(input.hasMultipleBatchLedgerEntries) ||
    int(input.ledgerEntryCount, 0) > 0;
  const ledgerConflict =
    bool(input.manualConflictResolution) ||
    bool(input.batchOrdinalConflict) ||
    bool(input.batchRenumberingRequired);

  if (bool(input.alreadyMerged)) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.IDEMPOTENT,
      retryPosture: "safe-retry",
      convergenceTarget: "terminal-state",
      duplicatePolicy: "suppress",
      raceHandling: "terminal-noop",
      evidence: "terminal merged state is a repeatable observation, not a merge mutation candidate",
    });
  }

  if (rollback && !protectedRollback) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.DESTRUCTIVE,
      retryPosture: "operator-before-retry",
      convergenceTarget: "ref-state",
      duplicatePolicy: "block",
      raceHandling: "operator-route",
      authority: "operator-required",
      evidence: "rollback outside a protected PR path can require destructive ref movement",
    });
  }

  if (
    prShapeIdempotence.class === IDEMPOTENCE_CLASSES.NON_IDEMPOTENT ||
    prShapeIdempotence.class === IDEMPOTENCE_CLASSES.DESTRUCTIVE ||
    prShapeIdempotence.authority === "pause"
  ) {
    return prShapeIdempotence;
  }

  if (prShapeIdempotence.class === IDEMPOTENCE_CLASSES.APPEND_ONLY) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.APPEND_ONLY,
      retryPosture: "safe-retry",
      convergenceTarget: prShapeIdempotence.convergenceTarget,
      duplicatePolicy: prShapeIdempotence.duplicatePolicy,
      raceHandling: "terminal-noop-after-refetch",
      evidence: prShapeIdempotence.evidence,
    });
  }

  if (ledgerTouched || ledgerConflict) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.APPEND_ONLY,
      retryPosture: ledgerConflict ? "operator-before-retry" : "refetch-before-retry",
      convergenceTarget: "ledger-entry",
      duplicatePolicy: ledgerConflict ? "supersede" : "append",
      raceHandling: "compare-and-swap",
      authority: ledgerConflict ? "operator-required" : "narrow",
      evidence: ledgerConflict
        ? "append-only ledger conflicts require operator-ratified superseding chronology"
        : "append-only ledger edits converge only when retried against the current ledger tip",
    });
  }

  if (aggregate.hasAggregateDiff && !bool(input.operatorRatifiedAggregate)) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.NON_IDEMPOTENT,
      retryPosture: "operator-before-retry",
      convergenceTarget: "review-unit",
      duplicatePolicy: "block",
      raceHandling: "operator-route",
      authority: "operator-required",
      evidence: "aggregate PRs can duplicate or blur review-unit state unless split or ratified",
    });
  }

  if (requested === MERGE_STRATEGIES.REBASE || requested === MERGE_STRATEGIES.MERGE_COMMIT) {
    const ratifiedHistoryShape =
      bool(input.operatorRatifiedStrategy) &&
      bool(input.preserveCommitSeries) &&
      (requested !== MERGE_STRATEGIES.REBASE || bool(input.commitsAreIndependentlyReviewable));
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.CONVERGENT,
      retryPosture: ratifiedHistoryShape ? "refetch-before-retry" : "operator-before-retry",
      convergenceTarget: "history-shape",
      duplicatePolicy: "supersede",
      raceHandling: "operator-route",
      authority: ratifiedHistoryShape ? "narrow" : "operator-required",
      evidence: ratifiedHistoryShape
        ? "operator-ratified history preservation converges around the reviewed commit series"
        : "non-default history preservation changes public history shape and requires explicit ratification",
    });
  }

  if (protectedRollback || bool(input.isStackedPr)) {
    return idempotenceProfile({
      class: IDEMPOTENCE_CLASSES.CONVERGENT,
      retryPosture: "refetch-before-retry",
      convergenceTarget: protectedRollback ? "revert-pr" : "stack-order",
      duplicatePolicy: "suppress-after-terminal",
      raceHandling: "compare-and-swap",
      authority: "narrow",
      evidence: protectedRollback
        ? "protected rollback converges through a revert PR instead of destructive ref movement"
        : "stacked PR handling converges only when base branch and merge order remain explicit",
    });
  }

  return idempotenceProfile();
}

export function classifyPrShape(input = {}) {
  const changedFiles = normalizeChangedFiles(input.changedFiles);
  const budget = prShapeBudget(input);
  const changedFileCount = changedFiles.length || int(input.changedFileCount, 0);
  const totalChangedLines = totalLines(input, changedFiles);
  const byClass = filesByClass(changedFiles);
  const surfaceClasses = Object.keys(byClass).sort();
  const signals = [];
  const hasChangedFileFacts = changedFiles.length > 0 || changedFileCount > 0 || totalChangedLines > 0;
  const hasGovernanceChange =
    surfaceClasses.includes("governance-source") ||
    surfaceClasses.includes("governance-doc") ||
    surfaceClasses.includes("constitutional-mirror");
  const needsDecisionRecord =
    surfaceClasses.includes("governance-source") ||
    changedFiles.some((file) => DECISION_REQUIRED_GOVERNANCE_FILES.has(baseName(file.path)) && !file.path.includes("/"));
  const sourceNeedsTests = surfaceClasses.some((surfaceClass) =>
    ["governance-source", "runtime-source", "cli", "tooling", "ci", "package"].includes(surfaceClass),
  );
  const generatedFiles = [...(byClass["generated-output"] || []), ...(byClass["local-state"] || [])].sort();
  const coherence = coherenceProfile({ changedFiles, byClass, surfaceClasses, generatedFiles });

  if (generatedFiles.length > 0) {
    signals.push(makeSignal({
      code: "generated-or-local-output",
      severity: SEVERITIES.BLOCK,
      dimension: "source-boundary",
      evidence: `${generatedFiles.length} generated or local state file(s) are in the PR shape`,
      next: "remove-generated-or-local-output",
      data: { files: generatedFiles.slice(0, 10) },
    }));
  }

  if (
    hasChangedFileFacts &&
    (changedFileCount > budget.operatorFiles || totalChangedLines > budget.operatorChangedLines) &&
    !bool(input.operatorRatifiedLargeDiff)
  ) {
    if (coherence.reviewBudgetAccepted) {
      signals.push(makeSignal({
        code: "coherent-review-size",
        severity: SEVERITIES.WATCH,
        dimension: "review-shape",
        evidence: `diff shape exceeds operator budget (${changedFileCount} file(s), ${totalChangedLines} changed line(s)), but forms one ${coherence.kind}`,
        next: "review-coherence-profile",
        data: { changedFileCount, totalChangedLines, budget, coherenceKind: coherence.kind },
      }));
    } else {
      signals.push(makeSignal({
        code: "diff-size-operator-review",
        severity: SEVERITIES.OPERATOR,
        dimension: "review-shape",
        evidence: `diff shape exceeds operator budget (${changedFileCount} file(s), ${totalChangedLines} changed line(s))`,
        next: "split-pr-or-ratify-large-diff",
        data: { changedFileCount, totalChangedLines, budget },
      }));
    }
  } else if (hasChangedFileFacts && (changedFileCount > budget.maxFiles || totalChangedLines > budget.maxChangedLines)) {
    signals.push(makeSignal({
      code: "diff-size-budget-exceeded",
      severity: SEVERITIES.CAUTION,
      dimension: "review-shape",
      evidence: `diff shape exceeds review budget (${changedFileCount} file(s), ${totalChangedLines} changed line(s))`,
      next: "consider-pr-split",
      data: { changedFileCount, totalChangedLines, budget },
    }));
  }

  if (
    surfaceClasses.length > budget.maxSurfaceClasses &&
    !bool(input.operatorRatifiedSurfaceSpan)
  ) {
    if (coherence.surfaceSpanAccepted) {
      signals.push(makeSignal({
        code: "coherent-surface-span",
        severity: SEVERITIES.WATCH,
        dimension: "structural-consistency",
        evidence: `PR spans ${surfaceClasses.length} surface class(es), but they form one ${coherence.kind}`,
        next: "review-coherence-profile",
        data: { surfaceClasses, coherenceKind: coherence.kind },
      }));
    } else {
      signals.push(makeSignal({
        code: "surface-span-operator-review",
        severity: SEVERITIES.OPERATOR,
        dimension: "structural-consistency",
        evidence: `PR spans ${surfaceClasses.length} surface class(es): ${surfaceClasses.join(", ")}`,
        next: "split-pr-by-surface-class-or-ratify-span",
        data: { surfaceClasses, coherence },
      }));
    }
  }

  if (hasGovernanceChange && !hasPath(changedFiles, "BATCH_LOG.md") && !bool(input.operatorRatifiedMissingCompanions)) {
    signals.push(makeSignal({
      code: "governance-change-missing-batch-record",
      severity: SEVERITIES.OPERATOR,
      dimension: "structural-consistency",
      evidence: "governance-shape change has no batch-log companion",
      next: "add-batch-log-entry-or-ratify-exception",
    }));
  }

  if (needsDecisionRecord && !hasPath(changedFiles, "DECISION_REGISTRY.md") && !bool(input.operatorRatifiedMissingCompanions)) {
    signals.push(makeSignal({
      code: "governance-change-missing-decision-record",
      severity: SEVERITIES.OPERATOR,
      dimension: "structural-consistency",
      evidence: "governance contract change has no decision-record companion",
      next: "add-decision-record-or-ratify-exception",
    }));
  }

  if (sourceNeedsTests && !surfaceClasses.includes("test") && !bool(input.operatorRatifiedTestGap)) {
    signals.push(makeSignal({
      code: "source-change-missing-tests",
      severity: SEVERITIES.CAUTION,
      dimension: "verification",
      evidence: "source-shaped change has no focused test companion",
      next: "add-focused-tests-or-ratify-test-gap",
    }));
  }

  return makeGovernedVerdict({
    classifier: "illuci.gitops.pr-shape",
    subject: input.subject || "pull-request",
    decision: "pr-shape",
    allowed: true,
    code: signals.length > 0 ? "pr-shape-signals" : "pr-shape-clear",
    evidence: signals.length > 0 ? "PR shape signals were detected" : "PR shape is within source-owned review bounds",
    next: signals.find((signal) => signal.next)?.next || "classify-merge-readiness",
    dimensions: {
      changedFileCount,
      totalChangedLines,
      surfaceClasses,
      filesByClass: byClass,
      budget,
      companions: {
        batchLog: hasPath(changedFiles, "BATCH_LOG.md"),
        decisionRegistry: hasPath(changedFiles, "DECISION_REGISTRY.md"),
        tests: surfaceClasses.includes("test"),
      },
      coherence,
      idempotence: prShapeIdempotenceProfile({ changedFiles, generatedFiles, coherence }),
    },
    signals,
  });
}

function aggregateSignals(input) {
  const reviewUnitCount = int(input.reviewUnitCount, 1);
  const batchCount = int(input.batchCount, 1);
  return {
    reviewUnitCount,
    batchCount,
    hasAggregateDiff:
      bool(input.hasAggregateDiff) ||
      bool(input.hasMultipleBatchLedgerEntries) ||
      reviewUnitCount > 1 ||
      batchCount > 1,
  };
}

function mergeReadinessSignals(input, aggregate) {
  const signals = [...classifyPrShape(input).signals];
  const mergeState = norm(input.mergeStateStatus);
  const behindBaseBy = int(input.behindBaseBy, 0);
  const localAheadBy = int(input.localBranchAheadOfRemote, 0);
  const lowerOpenPrCount = int(input.lowerNumberOpenPrCount, 0);
  const pendingCheckCount = int(input.pendingCheckCount, 0);
  const failingCheckCount = int(input.failingCheckCount, 0);
  const ledgerTouched = bool(input.touchesAppendOnlyLedgers) || bool(input.hasMultipleBatchLedgerEntries) || int(input.ledgerEntryCount, 0) > 0;
  const baseAdvanced =
    bool(input.baseAdvancedSinceChecks) ||
    (input.baseShaAtChecks && input.currentBaseSha && String(input.baseShaAtChecks) !== String(input.currentBaseSha));

  if (bool(input.isDraftPr)) {
    signals.push(makeSignal({
      code: "draft-pr",
      severity: SEVERITIES.BLOCK,
      dimension: "ceremony",
      evidence: "draft pull requests are review staging surfaces, not merge-ready surfaces",
      next: "mark-ready-after-review",
    }));
  }

  if (lowerOpenPrCount > 0) {
    signals.push(makeSignal({
      code: "pr-chronology-blocked",
      severity: SEVERITIES.BLOCK,
      dimension: "chronology",
      evidence: `${lowerOpenPrCount} lower-number open PR(s) target the same base`,
      next: "clear-lower-number-prs",
      data: { lowerOpenPrCount },
    }));
  }

  if (mergeState === "dirty") {
    signals.push(makeSignal({
      code: "merge-state-dirty",
      severity: ledgerTouched ? SEVERITIES.OPERATOR : SEVERITIES.BLOCK,
      dimension: "branch-freshness",
      evidence: ledgerTouched
        ? "PR is dirty against the base and touches append-only ledgers; manual reconciliation changes batch chronology"
        : "PR is dirty against the base branch",
      next: ledgerTouched ? "operator-ratify-ledger-resequence" : "refresh-branch-before-merge",
      data: { mergeStateStatus: input.mergeStateStatus, ledgerTouched },
    }));
  } else if (mergeState === "blocked" || mergeState === "unknown") {
    signals.push(makeSignal({
      code: `merge-state-${mergeState}`,
      severity: SEVERITIES.BLOCK,
      dimension: "branch-freshness",
      evidence: `GitHub merge state is ${mergeState}; do not guess merge readiness`,
      next: "refresh-pr-state",
      data: { mergeStateStatus: input.mergeStateStatus },
    }));
  }

  if (behindBaseBy > 0) {
    signals.push(makeSignal({
      code: ledgerTouched ? "base-behind-with-ledgers" : "base-behind",
      severity: ledgerTouched ? SEVERITIES.OPERATOR : SEVERITIES.CAUTION,
      dimension: "branch-freshness",
      evidence: ledgerTouched
        ? `branch is ${behindBaseBy} commit(s) behind base while append-only ledger edits are in scope`
        : `branch is ${behindBaseBy} commit(s) behind base`,
      next: ledgerTouched ? "operator-ratify-ledger-resequence" : "refresh-branch",
      data: { behindBaseBy, ledgerTouched },
    }));
  }

  if (baseAdvanced) {
    signals.push(makeSignal({
      code: "checks-base-stale",
      severity: SEVERITIES.BLOCK,
      dimension: "verification",
      evidence: "base branch advanced after the check set was produced",
      next: "rerun-checks-on-current-base",
      data: { baseShaAtChecks: input.baseShaAtChecks || null, currentBaseSha: input.currentBaseSha || null },
    }));
  }

  if (pendingCheckCount > 0 || failingCheckCount > 0) {
    signals.push(makeSignal({
      code: failingCheckCount > 0 ? "checks-failing" : "checks-pending",
      severity: failingCheckCount > 0 ? SEVERITIES.BLOCK : SEVERITIES.CAUTION,
      dimension: "verification",
      evidence: failingCheckCount > 0
        ? `${failingCheckCount} required check(s) are failing`
        : `${pendingCheckCount} required check(s) are still pending`,
      next: failingCheckCount > 0 ? "fix-failing-checks" : "wait-for-checks",
      data: { pendingCheckCount, failingCheckCount },
    }));
  }

  if (localAheadBy > 0 || bool(input.hasUnpushedLocalCommits)) {
    signals.push(makeSignal({
      code: "local-branch-ahead",
      severity: SEVERITIES.OPERATOR,
      dimension: "publication",
      evidence: `local branch has ${Math.max(localAheadBy, 1)} unpushed commit(s); do not treat local state as PR state`,
      next: "decide-push-or-discard-local-commits",
      data: { localBranchAheadOfRemote: localAheadBy },
    }));
  }

  if (bool(input.containsUnpushedMergeCommit) || bool(input.branchUpdateIntroducesMergeCommit)) {
    signals.push(makeSignal({
      code: "unratified-branch-update-merge",
      severity: SEVERITIES.OPERATOR,
      dimension: "history-shape",
      evidence: "branch update introduced a merge commit before the update strategy was classified",
      next: "operator-ratify-update-strategy",
    }));
  }

  if (bool(input.manualConflictResolution) && ledgerTouched) {
    signals.push(makeSignal({
      code: "manual-ledger-conflict-resolution",
      severity: SEVERITIES.OPERATOR,
      dimension: "append-only-ledger",
      evidence: "manual conflict resolution touched append-only ledger chronology",
      next: "operator-ratify-ledger-resequence",
    }));
  }

  if (bool(input.batchOrdinalConflict) || bool(input.batchRenumberingRequired)) {
    signals.push(makeSignal({
      code: "batch-ordinal-conflict",
      severity: SEVERITIES.OPERATOR,
      dimension: "append-only-ledger",
      evidence: "batch numbering would change because the base branch advanced",
      next: "operator-ratify-batch-ordinal-plan",
    }));
  }

  if (aggregate.hasAggregateDiff && bool(input.operatorRatifiedAggregate)) {
    signals.push(makeSignal({
      code: "ratified-aggregate",
      severity: SEVERITIES.WATCH,
      dimension: "review-shape",
      evidence: "aggregate signal exists but operator ratified the aggregate review shape",
      next: "preserve-ratification-evidence",
    }));
  }

  return signals;
}

function mergeReadinessDimensions(input, aggregate, prShape) {
  return {
    prShape: prShape.dimensions,
    idempotence: classifyGitopsIdempotence(input, { aggregate, prShape }),
    reviewShape: {
      reviewUnitCount: aggregate.reviewUnitCount,
      batchCount: aggregate.batchCount,
      hasAggregateDiff: aggregate.hasAggregateDiff,
    },
    branchFreshness: {
      mergeStateStatus: input.mergeStateStatus || null,
      behindBaseBy: int(input.behindBaseBy, 0),
      baseAdvancedSinceChecks: bool(input.baseAdvancedSinceChecks),
    },
    ledger: {
      touchesAppendOnlyLedgers: bool(input.touchesAppendOnlyLedgers),
      ledgerEntryCount: int(input.ledgerEntryCount, 0),
      batchOrdinalConflict: bool(input.batchOrdinalConflict) || bool(input.batchRenumberingRequired),
    },
    publication: {
      localBranchAheadOfRemote: int(input.localBranchAheadOfRemote, 0),
      hasUnpushedLocalCommits: bool(input.hasUnpushedLocalCommits),
    },
  };
}

export function classifyMergeReadiness(input = {}) {
  const aggregate = aggregateSignals(input);
  const prShape = classifyPrShape(input);
  const dimensions = mergeReadinessDimensions(input, aggregate, prShape);

  if (bool(input.alreadyMerged)) {
    return makeGovernedVerdict({
      classifier: "illuci.gitops.merge-readiness",
      subject: input.subject || "pull-request",
      decision: "readiness",
      allowed: true,
      code: "terminal-observed-merged",
      evidence: "pull request is already merged; terminal evidence supersedes merge-readiness mutation checks",
      next: "record-terminal-observation",
      dimensions,
      signals: [],
    });
  }

  const signals = mergeReadinessSignals(input, aggregate);

  return makeGovernedVerdict({
    classifier: "illuci.gitops.merge-readiness",
    subject: input.subject || "pull-request",
    decision: "readiness",
    allowed: true,
    code: signals.length > 0 ? "readiness-hazards" : "readiness-clear",
    evidence: signals.length > 0
      ? "merge readiness hazards were detected before strategy selection"
      : "no merge readiness hazards detected",
    next: signals.find((signal) => signal.next)?.next || "classify-merge-strategy",
    dimensions,
    signals,
  });
}

/**
 * Classify the permitted merge handling for a pull request or repair action.
 *
 * Inputs are facts, not intent prose. Important fields:
 * - requestedStrategy: squash | rebase | merge-commit
 * - githubRejectedExpectedStrategy: true when the expected merge command failed
 * - hasMultipleBatchLedgerEntries / reviewUnitCount / batchCount: aggregate signals
 * - operatorRatifiedStrategy: explicit operator approval for non-default history shape
 * - commitsAreIndependentlyReviewable: each commit is a reviewed unit, not a local work trail
 * - preserveCommitSeries: the commit series itself is the artifact to preserve
 * - isRollback / branchProtectionRequiresPr: protected unmerge path
 * - isStackedPr: PR targets another split branch for review sequencing
 */
export function classifyMergeStrategy(input = {}) {
  const requested = norm(input.requestedStrategy);
  const { hasAggregateDiff, reviewUnitCount, batchCount } = aggregateSignals(input);
  const readiness = classifyMergeReadiness(input);
  const repoAllowsSquash = input.repositoryAllowsSquash !== false;
  const repoAllowsRebase = input.repositoryAllowsRebase !== false;
  const repoAllowsMergeCommit = bool(input.repositoryAllowsMergeCommit);
  const operatorRatified = bool(input.operatorRatifiedStrategy);

  if (bool(input.alreadyMerged)) {
    return result(
      MERGE_STRATEGIES.OBSERVED_MERGED,
      true,
      "terminal-observed-merged",
      "pull request is already merged; merge mutation is a terminal no-op",
      {
        next: "record-terminal-observation",
        dimensions: readiness.dimensions,
        signals: [],
      },
    );
  }

  if (!readiness.allowed) {
    const firstBlocking = readiness.signals.find((signal) => signal.severity === SEVERITIES.OPERATOR || signal.severity === SEVERITIES.BLOCK);
    return result(
      MERGE_STRATEGIES.OPERATOR_DECISION,
      false,
      firstBlocking?.code || "readiness-hazards",
      firstBlocking?.evidence || readiness.evidence,
      {
        requiresOperator: readiness.requiresOperator,
        next: firstBlocking?.next || readiness.next,
        dimensions: readiness.dimensions,
        signals: readiness.signals,
      },
    );
  }

  if (bool(input.githubRejectedExpectedStrategy)) {
    return result(
      MERGE_STRATEGIES.OPERATOR_DECISION,
      false,
      "expected-strategy-rejected",
      "the expected merge method was rejected by the repository; stop and route to the operator instead of selecting another history shape",
      { requiresOperator: true, next: "operator-ratify-new-strategy", dimensions: readiness.dimensions, signals: readiness.signals },
    );
  }

  if (bool(input.isRollback) || norm(input.purpose) === "rollback") {
    if (bool(input.branchProtectionRequiresPr) || bool(input.protectedBase)) {
      return result(
        MERGE_STRATEGIES.REVERT_PR,
        true,
        "protected-rollback",
        "protected base branches unmerge by revert PR; preserve append-only ledgers and odometer discipline",
        { next: "open-revert-pr", dimensions: readiness.dimensions, signals: readiness.signals },
      );
    }
    return result(
      MERGE_STRATEGIES.OPERATOR_DECISION,
      false,
      "rollback-ref-choice",
      "rollback outside a protected PR path may require destructive ref movement; operator ratification is required",
      { requiresOperator: true, next: "operator-ratify-rollback-shape", dimensions: readiness.dimensions, signals: readiness.signals },
    );
  }

  if (bool(input.isStackedPr)) {
    return result(
      MERGE_STRATEGIES.STACKED_PR,
      true,
      "stacked-review",
      "stacked PRs are allowed for split review when the base branch and merge order are explicit",
      { next: "merge-or-retarget-in-stack-order", dimensions: readiness.dimensions, signals: readiness.signals },
    );
  }

  if (hasAggregateDiff && !bool(input.operatorRatifiedAggregate)) {
    return result(
      MERGE_STRATEGIES.OPERATOR_DECISION,
      false,
      "split-required",
      `aggregate PR signal detected (${reviewUnitCount} review unit(s), ${batchCount} batch line(s)); split before merge or obtain explicit operator ratification`,
      { requiresOperator: true, next: "split-pr", dimensions: readiness.dimensions, signals: readiness.signals },
    );
  }

  if (requested === MERGE_STRATEGIES.REBASE) {
    if (!repoAllowsRebase) {
      return result(
        MERGE_STRATEGIES.OPERATOR_DECISION,
        false,
        "rebase-disabled",
        "repository does not allow rebase merge",
        {
          requiresOperator: true,
          next: "choose-supported-strategy",
          dimensions: readiness.dimensions,
          signals: readiness.signals,
        },
      );
    }
    if (!operatorRatified || !bool(input.commitsAreIndependentlyReviewable) || !bool(input.preserveCommitSeries)) {
      return result(
        MERGE_STRATEGIES.OPERATOR_DECISION,
        false,
        "rebase-needs-ratification",
        "rebase merge requires explicit operator ratification plus independently reviewed commits whose series is intentionally preserved",
        { requiresOperator: true, next: "operator-ratify-rebase-or-squash", dimensions: readiness.dimensions, signals: readiness.signals },
      );
    }
    return result(MERGE_STRATEGIES.REBASE, true, "ratified-rebase", "operator ratified preserving an independently reviewed commit series", {
      next: "rebase-merge",
      dimensions: readiness.dimensions,
      signals: readiness.signals,
    });
  }

  if (requested === MERGE_STRATEGIES.MERGE_COMMIT) {
    if (!repoAllowsMergeCommit) {
      return result(
        MERGE_STRATEGIES.OPERATOR_DECISION,
        false,
        "merge-commit-disabled",
        "repository does not allow merge commits; stop rather than switching strategy without operator ratification",
        { requiresOperator: true, next: "operator-ratify-supported-strategy", dimensions: readiness.dimensions, signals: readiness.signals },
      );
    }
    if (!operatorRatified || !bool(input.preserveCommitSeries)) {
      return result(
        MERGE_STRATEGIES.OPERATOR_DECISION,
        false,
        "merge-commit-needs-ratification",
        "merge commits are only justified when the operator ratifies preserving the branch topology",
        { requiresOperator: true, next: "operator-ratify-merge-commit", dimensions: readiness.dimensions, signals: readiness.signals },
      );
    }
    return result(MERGE_STRATEGIES.MERGE_COMMIT, true, "ratified-merge-commit", "operator ratified preserving branch topology", {
      next: "merge-commit",
      dimensions: readiness.dimensions,
      signals: readiness.signals,
    });
  }

  if (!repoAllowsSquash) {
    return result(MERGE_STRATEGIES.OPERATOR_DECISION, false, "squash-disabled", "default squash merge is unavailable", {
      requiresOperator: true,
      next: "operator-ratify-supported-strategy",
      dimensions: readiness.dimensions,
      signals: readiness.signals,
    });
  }

  return result(
    MERGE_STRATEGIES.SQUASH,
    true,
    "default-squash",
    "one coherent review unit merges by squash; local work commits are not treated as public batch structure",
    { next: "squash-merge", dimensions: readiness.dimensions, signals: readiness.signals },
  );
}

export default {
  IDEMPOTENCE_CLASSES,
  MERGE_STRATEGIES,
  PR_SHAPE_DEFAULT_BUDGET,
  classifyGitopsIdempotence,
  classifyPrShape,
  classifyMergeReadiness,
  classifyMergeStrategy,
};
