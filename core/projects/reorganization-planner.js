import { existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { assessProjectStandards } from "./standards-assessment.js";

const GOVERNANCE_ROOTS = new Set(["decisions", "design", "pipelines"]);
const APP_FILE_NAMES = new Set([
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "electron.html",
  "electron-entry.tsx",
  "electron-entry.jsx",
  "app-entry.tsx",
  "app-entry.jsx",
]);
const DOC_FILE_EXTENSIONS = new Set([".md", ".txt", ".pdf"]);
const TOOL_FILE_EXTENSIONS = new Set([".sh", ".ps1", ".py", ".cjs", ".mjs"]);
const CODE_FILE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".rs", ".go", ".java"]);

const EXPLICIT_MOVE_RULES = {
  cli: {
    lane: "tooling",
    target: "tooling/cli",
    confidence: "high",
    rationale: "CLI and embedded TUI are internal operator tooling, not the released Illuci product surface.",
  },
  core: {
    lane: "packages",
    target: "packages/core",
    confidence: "high",
    rationale: "Core is shared platform and domain code, which belongs in packages.",
  },
  data: {
    lane: "tooling",
    target: "tooling/data",
    confidence: "medium",
    rationale: "Repository-local runtime and registry data should sit under tooling-owned operational state.",
  },
  electron: {
    lane: "apps",
    target: "apps/ide-shell",
    confidence: "high",
    rationale: "Electron hosts the shipped Illuci IDE shell and belongs in the apps lane.",
  },
  memory: {
    lane: "docs",
    target: "docs/memory",
    confidence: "high",
    rationale: "Memory artifacts are governance and documentation assets, not product runtime code.",
  },
  methodology: {
    lane: "docs",
    target: "docs/methodology",
    confidence: "high",
    rationale: "Methodology is a documentation and governance corpus.",
  },
  scripts: {
    lane: "tooling",
    target: "tooling/scripts",
    confidence: "high",
    rationale: "Automation scripts belong in the tooling lane.",
  },
  visualizer: {
    lane: "apps",
    target: "apps/ide",
    confidence: "high",
    rationale: "The visualizer is the primary Illuci IDE surface and belongs in the apps lane.",
  },
};

function extensionOf(fileName) {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : "";
}

function listDirectoryEntries(dirPath) {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    return [];
  }

  return readdirSync(dirPath, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
  }));
}

function inspectRootDirectory(projectRoot, dirName) {
  const entries = listDirectoryEntries(resolve(projectRoot, dirName));
  const childDirs = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  const childFiles = entries.filter((entry) => entry.isFile).map((entry) => entry.name);
  const lowerName = dirName.toLowerCase();

  if (EXPLICIT_MOVE_RULES[lowerName]) {
    return {
      ...EXPLICIT_MOVE_RULES[lowerName],
      requiresDecision: false,
    };
  }

  if (entries.length === 0) {
    return {
      lane: null,
      target: null,
      confidence: "low",
      rationale: `Directory "${dirName}" is empty, so Illuci cannot infer its target lane responsibly.`,
      requiresDecision: true,
      suggestedLanes: ["apps", "packages", "services", "tooling", "docs"],
    };
  }

  const hasAppIndicators =
    childFiles.some((file) => APP_FILE_NAMES.has(file)) ||
    childDirs.includes("app") ||
    childDirs.includes("public") ||
    childDirs.includes("components");

  const hasElectronIndicators =
    childFiles.includes("main.js") ||
    childFiles.includes("preload.cjs") ||
    childFiles.includes("electron-entry.tsx") ||
    lowerName.includes("electron");

  const docFileCount = childFiles.filter((file) => DOC_FILE_EXTENSIONS.has(extensionOf(file))).length;
  const toolFileCount = childFiles.filter((file) => TOOL_FILE_EXTENSIONS.has(extensionOf(file))).length;
  const codeFileCount = childFiles.filter((file) => CODE_FILE_EXTENSIONS.has(extensionOf(file))).length;
  const hasDocIndicators = docFileCount > 0 && codeFileCount === 0 && !hasAppIndicators && !hasElectronIndicators;
  const hasToolIndicators =
    toolFileCount > 0 ||
    childDirs.includes("bin") ||
    childDirs.includes("commands") ||
    childDirs.includes("tui") ||
    lowerName.includes("tool");

  if (hasAppIndicators || hasElectronIndicators) {
    return {
      lane: "apps",
      target: `apps/${lowerName}`,
      confidence: hasElectronIndicators ? "high" : "medium",
      rationale: `Directory "${dirName}" contains application-surface indicators and fits the apps lane.`,
      requiresDecision: false,
    };
  }

  if (hasDocIndicators || lowerName.includes("doc")) {
    return {
      lane: "docs",
      target: `docs/${lowerName}`,
      confidence: "medium",
      rationale: `Directory "${dirName}" is documentation-heavy and fits the docs lane.`,
      requiresDecision: false,
    };
  }

  if (hasToolIndicators) {
    return {
      lane: "tooling",
      target: `tooling/${lowerName}`,
      confidence: "medium",
      rationale: `Directory "${dirName}" contains automation or internal operator tooling indicators.`,
      requiresDecision: false,
    };
  }

  if (codeFileCount > 0 || childDirs.includes("src") || childDirs.includes("lib")) {
    return {
      lane: "packages",
      target: `packages/${lowerName}`,
      confidence: "medium",
      rationale: `Directory "${dirName}" appears to be shared implementation code and fits the packages lane.`,
      requiresDecision: false,
    };
  }

  return {
    lane: null,
    target: null,
    confidence: "low",
    rationale: `Directory "${dirName}" does not match a deterministic reorganization rule and needs operator review.`,
    requiresDecision: true,
    suggestedLanes: ["apps", "packages", "services", "tooling", "docs"],
  };
}

function createLaneActions(report) {
  return report.evidence.requiredDirectories.missing.map((dir) => ({
    kind: "create-root-lane",
    path: dir,
    rationale: `Create required root lane "${dir}/" for the target posture.`,
  }));
}

function createGovernanceActions(report) {
  const actions = [];

  if (!report.evidence.projectConfigPresent) {
    actions.push({
      kind: "materialize-project-config",
      path: ".illuci/project.json",
      rationale: "Project config must exist before governed reorganization proceeds.",
    });
  }

  if (!report.evidence.governanceManifestPresent) {
    actions.push({
      kind: "materialize-governance-manifest",
      path: "illuci-governance.json",
      rationale: "Governance manifest must exist before broad implementation or structural change.",
    });
  }

  return actions;
}

function createMoveMap(report) {
  const moves = [];
  const unresolved = [];

  for (const candidate of report.evidence.driftCandidates) {
    const plan = inspectRootDirectory(report.projectRoot, candidate.path);

    if (plan.requiresDecision || !plan.target) {
      unresolved.push({
        path: candidate.path,
        rationale: plan.rationale,
        suggestedLanes: plan.suggestedLanes || [],
        sourceFinding: candidate.reason,
      });
      continue;
    }

    moves.push({
      from: candidate.path,
      to: plan.target,
      lane: plan.lane,
      confidence: plan.confidence,
      rationale: plan.rationale,
    });
  }

  return { moves, unresolved };
}

function createBatches({ governanceActions, laneActions, moveMap, unresolvedDecisions }) {
  const batches = [];

  if (governanceActions.length > 0) {
    batches.push({
      id: "governance-normalization",
      title: "Normalize governance contract",
      objective: "Materialize the config and manifest prerequisites before moving structure.",
      actions: governanceActions,
    });
  }

  if (laneActions.length > 0) {
    batches.push({
      id: "lane-creation",
      title: "Create target lanes",
      objective: "Create the missing root-level product lanes before moving existing material.",
      actions: laneActions,
    });
  }

  const docsMoves = moveMap.filter((move) => move.lane === "docs");
  if (docsMoves.length > 0) {
    batches.push({
      id: "docs-and-governance",
      title: "Move documentation and governance support artifacts",
      objective: "Relocate documentation-oriented directories into the docs lane first.",
      actions: docsMoves,
    });
  }

  const appMoves = moveMap.filter((move) => move.lane === "apps");
  if (appMoves.length > 0) {
    batches.push({
      id: "operator-surfaces",
      title: "Move released product surfaces",
      objective: "Place the shipped IDE and other user-facing app surfaces into the apps lane.",
      actions: appMoves,
    });
  }

  const packageMoves = moveMap.filter((move) => move.lane === "packages");
  if (packageMoves.length > 0) {
    batches.push({
      id: "shared-code",
      title: "Move shared platform code",
      objective: "Relocate shared implementation code into the packages lane.",
      actions: packageMoves,
    });
  }

  const toolingMoves = moveMap.filter((move) => move.lane === "tooling");
  if (toolingMoves.length > 0) {
    batches.push({
      id: "tooling-and-ops",
      title: "Move tooling and operational assets",
      objective: "Relocate internal CLI/TUI surfaces, scripts, and operational assets into the tooling lane.",
      actions: toolingMoves,
    });
  }

  if (unresolvedDecisions.length > 0) {
    batches.push({
      id: "operator-decisions",
      title: "Resolve ambiguous roots",
      objective: "Decide target lanes for directories that do not match deterministic rules.",
      actions: unresolvedDecisions.map((decision) => ({
        kind: "operator-decision",
        path: decision.path,
        suggestedLanes: decision.suggestedLanes,
        rationale: decision.rationale,
      })),
    });
  }

  return batches;
}

export function planProjectReorganization(projectRoot) {
  const assessment = assessProjectStandards(projectRoot);
  const governanceActions = createGovernanceActions(assessment);
  const laneActions = createLaneActions(assessment);
  const { moves, unresolved } = createMoveMap(assessment);

  const blocked = assessment.verdict === "blocked" || assessment.reorganization.decision === "blocked";
  const planStatus = blocked
    ? "blocked"
    : unresolved.length > 0 || assessment.verdict === "exception-bearing"
      ? "needs-operator-review"
      : moves.length === 0 && laneActions.length === 0 && governanceActions.length === 0
        ? "no-op"
        : "ready";

  const batches = createBatches({
    governanceActions,
    laneActions,
    moveMap: moves,
    unresolvedDecisions: unresolved,
  });

  const safeguards = [
    "Do not move anything until the standards assessment is accepted for the current repo state.",
    "Create target root lanes before moving existing directories.",
    "Classify released IDE surfaces under apps and internal CLI/TUI surfaces under tooling before moving structure.",
    "Move code, config, docs, and governance artifacts together when they are structurally linked.",
    "Update imports, manifests, and tooling references in the same reorganization batch as the move.",
    "Record unresolved or exception-bearing roots before executing structural changes.",
  ];

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: assessment.projectRoot,
    projectName: assessment.projectName,
    standard: assessment.standard,
    sourceAssessment: {
      verdict: assessment.verdict,
      score: assessment.score,
      reorganizationDecision: assessment.reorganization.decision,
    },
    targetPosture: {
      id: assessment.posture.id,
      owner: assessment.posture.owner,
    },
    planStatus,
    governanceActions,
    laneActions,
    moveMap: moves,
    unresolvedDecisions: unresolved,
    blockingIssues: assessment.driftInventory.filter((entry) => entry.severity === "blocking"),
    batches,
    safeguards,
  };
}

export default {
  planProjectReorganization,
};
