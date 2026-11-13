import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, relative, resolve } from "path";
import { bootstrap } from "../bootstrap/project-init.js";
import { logDecision } from "../decisions/logger.js";
import { resolveProjectConfigFile } from "./config-dir.js";
import { buildDefaultProjectConfig } from "./manager.js";
import { planProjectReorganization } from "./reorganization-planner.js";
import { assessProjectStandards } from "./standards-assessment.js";

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const TEXT_BASENAMES = new Set([
  "Dockerfile",
  "LICENSE",
  "README",
  "README.md",
  "VERSION",
]);

const IGNORED_SCAN_DIRS = new Set([
  ".git",
  ".illuci-cache",
  ".illuci-sandboxes",
  ".next",
  ".turbo",
  ".vscode",
  ".idea",
  "build",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "out",
]);

const EXECUTABLE_BATCH_IDS = new Set([
  "governance-normalization",
  "lane-creation",
  "docs-and-governance",
  "operator-surfaces",
  "shared-code",
  "tooling-and-ops",
]);

function extensionOf(fileName) {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : "";
}

function repoPath(pathValue) {
  return pathValue.replace(/\\/g, "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureUnderRoot(projectRoot, targetPath) {
  const absPath = resolve(targetPath);
  const rel = relative(projectRoot, absPath);

  if (rel === "" || (!rel.startsWith("..") && !rel.includes(":"))) {
    return absPath;
  }

  throw new Error(`Path escapes project root: ${targetPath}`);
}

function normalizeDecisionOverrides(decisionOverrides = {}) {
  const normalized = {};

  for (const [source, target] of Object.entries(decisionOverrides)) {
    if (!source || !target) continue;
    const cleanSource = repoPath(source).replace(/^\.?\//, "").replace(/\/+$/, "");
    const cleanTarget = repoPath(target).replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!cleanSource || !cleanTarget) continue;
    normalized[cleanSource] = cleanTarget;
  }

  return normalized;
}

function createOverrideMove(decision, target) {
  const lane = target.split("/")[0] || "packages";
  return {
    from: decision.path,
    to: target,
    lane,
    confidence: "operator",
    rationale: `Operator resolved "${decision.path}" to "${target}" during reorganization execution.`,
  };
}

function applyDecisionOverrides(plan, overrides) {
  if (Object.keys(overrides).length === 0) {
    return {
      moveMap: [...plan.moveMap],
      unresolvedDecisions: [...plan.unresolvedDecisions],
      resolvedOverrides: [],
    };
  }

  const moveMap = [...plan.moveMap];
  const unresolvedDecisions = [];
  const resolvedOverrides = [];

  for (const decision of plan.unresolvedDecisions) {
    const target = overrides[decision.path];
    if (!target) {
      unresolvedDecisions.push(decision);
      continue;
    }

    const overrideMove = createOverrideMove(decision, target);
    moveMap.push(overrideMove);
    resolvedOverrides.push(overrideMove);
  }

  return {
    moveMap,
    unresolvedDecisions,
    resolvedOverrides,
  };
}

function batchIdForMove(move) {
  switch (move.lane) {
    case "docs":
      return "docs-and-governance";
    case "apps":
      return "operator-surfaces";
    case "packages":
      return "shared-code";
    case "tooling":
      return "tooling-and-ops";
    default:
      return null;
  }
}

function getExecutableBatches(plan) {
  return plan.batches.filter((batch) => EXECUTABLE_BATCH_IDS.has(batch.id));
}

function selectBatches(plan, batchIds = [], dryRun = true) {
  const executableBatches = getExecutableBatches(plan);

  if (!batchIds || batchIds.length === 0) {
    return {
      selectedBatchIds: executableBatches.map((batch) => batch.id),
      selectedBatches: executableBatches,
      blocked: false,
      reason: null,
    };
  }

  const selected = [];
  const selectedSet = new Set(batchIds);

  for (const batchId of batchIds) {
    if (!EXECUTABLE_BATCH_IDS.has(batchId)) {
      return {
        selectedBatchIds: [],
        selectedBatches: [],
        blocked: true,
        reason: `Batch "${batchId}" is not executable. Resolve operator decisions before applying them.`,
      };
    }

    const batch = executableBatches.find((entry) => entry.id === batchId);
    if (!batch) {
      return {
        selectedBatchIds: [],
        selectedBatches: [],
        blocked: true,
        reason: `Batch "${batchId}" is not available for the current plan.`,
      };
    }

    selected.push(batch);
  }

  if (!dryRun) {
    for (let index = 0; index < executableBatches.length; index += 1) {
      const batch = executableBatches[index];
      if (!selectedSet.has(batch.id)) {
        continue;
      }

      for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
        const priorBatch = executableBatches[priorIndex];
        if (!selectedSet.has(priorBatch.id) && priorBatch.actions.length > 0) {
          return {
            selectedBatchIds: [],
            selectedBatches: [],
            blocked: true,
            reason: `Batch "${priorBatch.id}" must be applied before later batches. Reorganization execution proceeds in plan order.`,
          };
        }
      }
    }

    let foundSelected = false;
    for (const batch of executableBatches) {
      if (selectedSet.has(batch.id)) {
        foundSelected = true;
        continue;
      }

      if (foundSelected && batch.actions.length > 0) {
        return {
          selectedBatchIds: [],
          selectedBatches: [],
          blocked: true,
          reason: `Batch "${batch.id}" must be applied before later batches. Reorganization execution proceeds in plan order.`,
        };
      }
    }
  }

  return {
    selectedBatchIds: batchIds,
    selectedBatches: selected,
    blocked: false,
    reason: null,
  };
}

function isTextFile(filePath) {
  const fileName = basename(filePath);
  return TEXT_BASENAMES.has(fileName) || TEXT_EXTENSIONS.has(extensionOf(fileName));
}

function collectTextFiles(projectRoot, currentDir = projectRoot) {
  const files = [];

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_SCAN_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      files.push(...collectTextFiles(projectRoot, resolve(currentDir, entry.name)));
      continue;
    }

    const fullPath = resolve(currentDir, entry.name);
    if (isTextFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function mapAbsolutePath(absPath, projectRoot, moveMap) {
  const repoRelative = repoPath(relative(projectRoot, absPath));
  if (!repoRelative || repoRelative.startsWith("..") || repoRelative.includes(":")) {
    return absPath;
  }

  const sortedMoves = [...moveMap].sort((left, right) => right.from.length - left.from.length);

  for (const move of sortedMoves) {
    if (repoRelative === move.from || repoRelative.startsWith(`${move.from}/`)) {
      const suffix = repoRelative === move.from ? "" : repoRelative.slice(move.from.length + 1);
      return resolve(projectRoot, move.to, suffix);
    }
  }

  return absPath;
}

function rewriteRelativeSpecifier(specifier, oldFilePath, newFilePath, projectRoot, moveMap) {
  if (!specifier.startsWith(".")) return specifier;
  if (specifier.includes("://")) return specifier;

  const oldResolved = resolve(dirname(oldFilePath), specifier);
  const newResolved = mapAbsolutePath(oldResolved, projectRoot, moveMap);

  if (oldResolved === newResolved && oldFilePath === newFilePath) {
    return specifier;
  }

  let nextSpecifier = repoPath(relative(dirname(newFilePath), newResolved));
  if (!nextSpecifier || nextSpecifier === "") {
    nextSpecifier = ".";
  } else if (!nextSpecifier.startsWith(".")) {
    nextSpecifier = `./${nextSpecifier}`;
  }

  if (specifier.endsWith("/") && !nextSpecifier.endsWith("/")) {
    nextSpecifier += "/";
  }

  return nextSpecifier;
}

function rewriteCodeSpecifiers(content, oldFilePath, newFilePath, projectRoot, moveMap) {
  const patterns = [
    /(\bfrom\s*)(['"])([^'"]+)\2/g,
    /(^\s*import\s*)(['"])([^'"]+)\2/gm,
    /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g,
    /(\brequire\s*\(\s*)(['"])([^'"]+)\2/g,
  ];

  let nextContent = content;
  let rewrites = 0;

  for (const pattern of patterns) {
    nextContent = nextContent.replace(pattern, (match, prefix, quote, specifier) => {
      const updated = rewriteRelativeSpecifier(specifier, oldFilePath, newFilePath, projectRoot, moveMap);
      if (updated !== specifier) {
        rewrites += 1;
      }
      return `${prefix}${quote}${updated}${quote}`;
    });
  }

  return { content: nextContent, rewrites };
}

function rewriteRepoRelativePaths(content, moveMap) {
  let nextContent = content;
  let rewrites = 0;
  const sortedMoves = [...moveMap].sort((left, right) => right.from.length - left.from.length);

  for (const move of sortedMoves) {
    const fromPattern = escapeRegExp(repoPath(move.from));
    const pattern = new RegExp(`(?<![A-Za-z0-9_./\\\\-])${fromPattern}(?=(?:/|\\\\|["'\`\\s)])|$)`, "g");
    nextContent = nextContent.replace(pattern, () => {
      rewrites += 1;
      return repoPath(move.to);
    });
  }

  return { content: nextContent, rewrites };
}

function planTextRewrites(projectRoot, moveMap) {
  const rewritePlan = [];

  if (moveMap.length === 0) {
    return rewritePlan;
  }

  for (const filePath of collectTextFiles(projectRoot)) {
    const oldContent = readFileSync(filePath, "utf-8");
    const newFilePath = mapAbsolutePath(filePath, projectRoot, moveMap);
    let nextContent = oldContent;
    let rewriteCount = 0;

    if (CODE_EXTENSIONS.has(extensionOf(filePath))) {
      const rewrittenCode = rewriteCodeSpecifiers(nextContent, filePath, newFilePath, projectRoot, moveMap);
      nextContent = rewrittenCode.content;
      rewriteCount += rewrittenCode.rewrites;
    }

    const rewrittenPaths = rewriteRepoRelativePaths(nextContent, moveMap);
    nextContent = rewrittenPaths.content;
    rewriteCount += rewrittenPaths.rewrites;

    if (nextContent === oldContent) {
      continue;
    }

    rewritePlan.push({
      oldPath: filePath,
      newPath: newFilePath,
      relativeOldPath: repoPath(relative(projectRoot, filePath)),
      relativeNewPath: repoPath(relative(projectRoot, newFilePath)),
      rewriteCount,
      content: nextContent,
    });
  }

  return rewritePlan;
}

function writeProjectConfig(projectRoot) {
  const configPath = resolveProjectConfigFile(projectRoot, "project.json");
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = buildDefaultProjectConfig(projectRoot);
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

function ensureGovernance(projectRoot) {
  const manifestPath = resolve(projectRoot, "illuci-governance.json");
  const configPath = resolveProjectConfigFile(projectRoot, "project.json");
  const actions = [];

  if (!existsSync(manifestPath)) {
    const bootstrapState = bootstrap(projectRoot, basename(projectRoot));
    actions.push({
      kind: "materialize-governance-manifest",
      path: "illuci-governance.json",
      created: bootstrapState.created,
      skipped: bootstrapState.skipped,
    });
  }

  if (!existsSync(configPath)) {
    actions.push({
      kind: "materialize-project-config",
      path: repoPath(relative(projectRoot, writeProjectConfig(projectRoot))),
    });
  }

  return actions;
}

function ensureLanes(projectRoot, laneActions) {
  const created = [];
  const skipped = [];

  for (const action of laneActions) {
    const target = ensureUnderRoot(projectRoot, resolve(projectRoot, action.path));
    if (existsSync(target)) {
      skipped.push(action.path);
      continue;
    }
    mkdirSync(target, { recursive: true });
    created.push(action.path);
  }

  return { created, skipped };
}

function applyMoveMap(projectRoot, moveMap) {
  const executed = [];
  const skipped = [];

  for (const move of moveMap) {
    const source = ensureUnderRoot(projectRoot, resolve(projectRoot, move.from));
    const destination = ensureUnderRoot(projectRoot, resolve(projectRoot, move.to));

    if (!existsSync(source)) {
      skipped.push({ from: move.from, to: move.to, reason: "source-missing" });
      continue;
    }

    if (existsSync(destination)) {
      skipped.push({ from: move.from, to: move.to, reason: "destination-exists" });
      continue;
    }

    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    executed.push({ from: move.from, to: move.to, lane: move.lane });
  }

  return { executed, skipped };
}

function applyTextRewrites(rewritePlan) {
  const written = [];

  for (const rewrite of rewritePlan) {
    mkdirSync(dirname(rewrite.newPath), { recursive: true });
    writeFileSync(rewrite.newPath, rewrite.content, "utf-8");
    written.push({
      path: rewrite.relativeNewPath,
      rewrites: rewrite.rewriteCount,
    });
  }

  return written;
}

function writeExecutionReport(projectRoot, report) {
  const reportDir = resolve(projectRoot, "pipelines", "accountability");
  mkdirSync(reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = resolve(reportDir, `reorganization-execution-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  return reportPath;
}

function verifyAppliedMoves(projectRoot, moveMap) {
  return moveMap.map((move) => ({
    from: move.from,
    to: move.to,
    sourceExists: existsSync(resolve(projectRoot, move.from)),
    destinationExists: existsSync(resolve(projectRoot, move.to)),
  }));
}

export function executeProjectReorganization(projectRoot, options = {}) {
  const absPath = resolve(projectRoot);
  const dryRun = options.dryRun !== false;
  const decisionOverrides = normalizeDecisionOverrides(options.decisionOverrides);
  const plan = planProjectReorganization(absPath);
  const { moveMap, unresolvedDecisions, resolvedOverrides } = applyDecisionOverrides(plan, decisionOverrides);
  const batchSelection = selectBatches(plan, options.batchIds || [], dryRun);

  if (batchSelection.blocked) {
    return {
      ok: false,
      projectRoot: absPath,
      dryRun,
      reason: batchSelection.reason,
      planStatus: "blocked",
    };
  }

  const selectedBatchIds = batchSelection.selectedBatchIds;
  const selectedBatchSet = new Set(selectedBatchIds);
  const selectedGovernanceActions = plan.governanceActions.filter(() => selectedBatchSet.has("governance-normalization"));
  const selectedLaneActions = plan.laneActions.filter(() => selectedBatchSet.has("lane-creation"));
  const selectedMoves = moveMap.filter((move) => {
    const batchId = batchIdForMove(move);
    return batchId ? selectedBatchSet.has(batchId) : false;
  });

  const unresolvedRemaining = unresolvedDecisions.filter((decision) => !decisionOverrides[decision.path]);
  if (!dryRun && unresolvedRemaining.length > 0 && !(options.batchIds && options.batchIds.length > 0)) {
    return {
      ok: false,
      projectRoot: absPath,
      dryRun,
      reason: "Operator decisions remain unresolved. Use --batch for earlier safe batches or --decide <path=target> to resolve them before applying all batches.",
      planStatus: "needs-operator-review",
      unresolvedDecisions: unresolvedRemaining,
    };
  }

  const rewritePlan = planTextRewrites(absPath, selectedMoves);
  const executionReport = {
    generatedAt: new Date().toISOString(),
    projectRoot: absPath,
    dryRun,
    selectedBatchIds,
    resolvedOverrides,
    governanceActions: selectedGovernanceActions,
    laneActions: selectedLaneActions,
    moveMap: selectedMoves,
    unresolvedDecisions: unresolvedRemaining,
    rewritePlan: rewritePlan.map((rewrite) => ({
      from: rewrite.relativeOldPath,
      to: rewrite.relativeNewPath,
      rewrites: rewrite.rewriteCount,
    })),
    safeguards: plan.safeguards,
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      planStatus: unresolvedRemaining.length > 0 ? "needs-operator-review" : "ready",
      report: executionReport,
    };
  }

  const governanceResult = selectedGovernanceActions.length > 0 ? ensureGovernance(absPath) : [];
  const laneResult = selectedLaneActions.length > 0
    ? ensureLanes(absPath, selectedLaneActions)
    : { created: [], skipped: [] };
  const moveResult = applyMoveMap(absPath, selectedMoves);
  const rewriteResult = applyTextRewrites(rewritePlan);
  const verification = {
    postAssessment: assessProjectStandards(absPath),
    moveVerification: verifyAppliedMoves(absPath, selectedMoves),
  };

  const finalReport = {
    ...executionReport,
    execution: {
      governanceResult,
      laneResult,
      moveResult,
      rewriteResult,
    },
    verification,
  };

  const shouldWriteReport = options.writeReport !== false;
  const reportPath = shouldWriteReport ? writeExecutionReport(absPath, finalReport) : null;

  if (options.logDecision !== false) {
    logDecision({
      humanStatus: "operator-initiated",
      modelStatus: { model: "illuci", role: "reorganization-executor" },
      context: `Reorganization execution on ${absPath}`,
      type: "reorganization-execution",
      decision: `Executed batches: ${selectedBatchIds.join(", ") || "none"}`,
      outputs: {
        reportPath: reportPath ? repoPath(relative(absPath, reportPath)) : null,
        executedMoves: moveResult.executed.length,
        rewrittenFiles: rewriteResult.length,
        postAssessment: verification.postAssessment.verdict,
      },
      metadata: {
        dryRun: false,
        resolvedOverrides,
      },
    });
  }

  return {
    ok: true,
    dryRun: false,
    planStatus: verification.postAssessment.reorganization.decision,
    reportPath,
    report: finalReport,
  };
}

export default {
  executeProjectReorganization,
};
