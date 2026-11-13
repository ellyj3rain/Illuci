import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, resolve } from "path";

const DEFAULT_STANDARD_ID = "gzs-governance-standard";
const DEFAULT_STANDARD_NAME = "Ground Zero Solutions Governance Standard";
const DEFAULT_WORKSPACE_POSTURE = "root-level-monorepo-product";

const REQUIRED_MONOREPO_DIRS = [
  "apps",
  "packages",
  "services",
  "infra",
  "tooling",
  "docs",
];

const REQUIRED_GOVERNANCE_DIRS = [
  "decisions",
  "design",
  "pipelines",
];

const REQUIRED_ROOT_DIRS = [
  ...REQUIRED_MONOREPO_DIRS,
  ...REQUIRED_GOVERNANCE_DIRS,
];

const IGNORED_ROOT_DIRS = new Set([
  ".git",
  ".github",
  ".illuci",
  ".illuci-cache",
  ".illuci-sandboxes",
  ".vscode",
  ".idea",
  "node_modules",
  ".husky",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
]);

const ROOT_DIR_RECOMMENDATIONS = {
  src: "packages",
  lib: "packages",
  libs: "packages",
  api: "services",
  apis: "services",
  server: "services",
  servers: "services",
  backend: "services",
  backends: "services",
  worker: "services",
  workers: "services",
  frontend: "apps",
  frontends: "apps",
  web: "apps",
  ui: "apps",
  client: "apps",
  clients: "apps",
  scripts: "tooling",
  script: "tooling",
  bin: "tooling",
  tests: "tooling",
  test: "tooling",
  e2e: "tooling",
  config: "tooling",
  configs: "tooling",
  assets: "docs",
  public: "apps",
  infrastructure: "infra",
  ops: "infra",
};

function isIgnoredRootDir(dirName) {
  return IGNORED_ROOT_DIRS.has(dirName) || (dirName.startsWith(".") && !REQUIRED_ROOT_DIRS.includes(dirName));
}

function safeReadJson(filePath) {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function listRootEntries(projectRoot) {
  return readdirSync(projectRoot, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function calculateScore({
  blocked,
  configPresent,
  manifestPresent,
  missingRequiredDirs,
  driftCandidates,
  unexpectedRootDirs,
  explicitExceptions,
}) {
  if (blocked) return 0;

  let score = 100;

  if (!configPresent) score -= 12;
  if (!manifestPresent) score -= 12;

  score -= Math.min(missingRequiredDirs.length * 7, 42);
  score -= Math.min(driftCandidates.length * 4, 20);
  score -= Math.min(unexpectedRootDirs.length * 2, 12);

  if (explicitExceptions.length > 0) {
    score -= 4;
  }

  return Math.max(0, score);
}

function buildDriftCandidates(rootDirectories) {
  const candidates = [];

  for (const dir of rootDirectories) {
    if (REQUIRED_ROOT_DIRS.includes(dir)) continue;
    if (isIgnoredRootDir(dir)) continue;

    const recommendedLane = ROOT_DIR_RECOMMENDATIONS[dir.toLowerCase()] || null;
    const reason = recommendedLane
      ? `Root directory "${dir}" likely belongs under "${recommendedLane}/" in the default product posture.`
      : `Root directory "${dir}" is outside the default root-level product lanes and should be assessed for reorganization.`;

    candidates.push({
      path: dir,
      recommendedLane,
      reason,
    });
  }

  return candidates;
}

function normalizeExceptions(config) {
  const explicitExceptions = [];

  if (config?.workspacePosture && config.workspacePosture !== DEFAULT_WORKSPACE_POSTURE) {
    explicitExceptions.push(`Non-default workspace posture declared: ${config.workspacePosture}`);
  }

  if (Array.isArray(config?.workspaceExceptions)) {
    for (const exception of config.workspaceExceptions) {
      if (typeof exception === "string" && exception.trim()) {
        explicitExceptions.push(exception.trim());
      }
    }
  }

  return explicitExceptions;
}

export function assessProjectStandards(projectRoot) {
  const absPath = resolve(projectRoot);

  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    return {
      assessedAt: new Date().toISOString(),
      projectRoot: absPath,
      projectName: basename(absPath),
      standard: {
        id: DEFAULT_STANDARD_ID,
        name: DEFAULT_STANDARD_NAME,
      },
      posture: {
        id: DEFAULT_WORKSPACE_POSTURE,
        owner: "illuci",
      },
      verdict: "blocked",
      score: 0,
      reorganization: {
        decision: "blocked",
        reasons: [`Project root does not exist or is not a directory: ${absPath}`],
      },
      evidence: {
        projectConfigPresent: false,
        governanceManifestPresent: false,
        rootDirectories: [],
        rootFiles: [],
        requiredDirectories: {
          present: [],
          missing: REQUIRED_ROOT_DIRS,
        },
        driftCandidates: [],
      },
      explicitExceptions: [],
      driftInventory: [
        {
          type: "path",
          severity: "blocking",
          message: `Project root does not exist or is not a directory: ${absPath}`,
        },
      ],
    };
  }

  const configPath = resolve(absPath, ".illuci", "project.json");
  const manifestPath = resolve(absPath, "illuci-governance.json");
  const config = safeReadJson(configPath);
  const manifest = safeReadJson(manifestPath);
  const entries = listRootEntries(absPath);
  const rootDirectories = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  const rootFiles = entries.filter((entry) => entry.isFile).map((entry) => entry.name);
  const presentRequiredDirs = REQUIRED_ROOT_DIRS.filter((dir) => rootDirectories.includes(dir));
  const missingRequiredDirs = REQUIRED_ROOT_DIRS.filter((dir) => !rootDirectories.includes(dir));
  const unexpectedRootDirs = rootDirectories.filter(
    (dir) => !REQUIRED_ROOT_DIRS.includes(dir) && !isIgnoredRootDir(dir),
  );
  const driftCandidates = buildDriftCandidates(rootDirectories);
  const explicitExceptions = normalizeExceptions(config);

  const configStandardId = config?.governanceStandardId || null;
  const manifestStandardId = manifest?.governance?.standard?.id || null;
  const standardMismatch = Boolean(
    (configStandardId && configStandardId !== DEFAULT_STANDARD_ID) ||
    (manifestStandardId && manifestStandardId !== DEFAULT_STANDARD_ID) ||
    (configStandardId && manifestStandardId && configStandardId !== manifestStandardId),
  );

  const postureId =
    config?.workspacePosture ||
    manifest?.governance?.workspace?.defaultPosture ||
    DEFAULT_WORKSPACE_POSTURE;

  const driftInventory = [];

  if (!config) {
    driftInventory.push({
      type: "governance-config",
      severity: "high",
      message: "Project config is missing. Initialize or normalize .illuci/project.json before broad implementation.",
    });
  }

  if (!manifest) {
    driftInventory.push({
      type: "governance-manifest",
      severity: "high",
      message: "Governance manifest is missing. Materialize illuci-governance.json before broad implementation.",
    });
  }

  if (standardMismatch) {
    driftInventory.push({
      type: "governance-standard",
      severity: "blocking",
      message: "Declared governance standard does not match the Ground Zero Solutions governance standard.",
    });
  }

  for (const dir of missingRequiredDirs) {
    driftInventory.push({
      type: "missing-lane",
      severity: "high",
      message: `Required root lane "${dir}/" is missing for the default root-level monorepo product posture.`,
      path: dir,
    });
  }

  for (const candidate of driftCandidates) {
    driftInventory.push({
      type: "root-drift",
      severity: candidate.recommendedLane ? "medium" : "review",
      message: candidate.reason,
      path: candidate.path,
      recommendedLane: candidate.recommendedLane,
    });
  }

  let verdict = "transitional";
  let reorganizationDecision = "mandatory";
  const reorganizationReasons = [];

  if (standardMismatch) {
    verdict = "blocked";
    reorganizationDecision = "blocked";
    reorganizationReasons.push("Governance standard mismatch must be resolved before structural work.");
  } else if (explicitExceptions.length > 0) {
    verdict = "exception-bearing";
    reorganizationDecision = "optional";
    reorganizationReasons.push("Explicit workspace exceptions are declared and should be honored during planning.");
  } else if (
    config &&
    manifest &&
    missingRequiredDirs.length === 0 &&
    unexpectedRootDirs.length === 0 &&
    postureId === DEFAULT_WORKSPACE_POSTURE
  ) {
    verdict = "standard";
    reorganizationDecision = "optional";
    reorganizationReasons.push("Workspace conforms to the default Ground Zero Solutions-governed Illuci posture.");
  } else {
    reorganizationReasons.push("Workspace drift exists relative to the default root-level monorepo product posture.");

    if (missingRequiredDirs.length === 0 && driftCandidates.length === 0) {
      reorganizationDecision = "optional";
      reorganizationReasons.push("No structural lane drift was detected; remaining work is governance normalization.");
    }
  }

  const score = calculateScore({
    blocked: verdict === "blocked",
    configPresent: Boolean(config),
    manifestPresent: Boolean(manifest),
    missingRequiredDirs,
    driftCandidates,
    unexpectedRootDirs,
    explicitExceptions,
  });

  return {
    assessedAt: new Date().toISOString(),
    projectRoot: absPath,
    projectName: basename(absPath),
    standard: {
      id: manifestStandardId || configStandardId || DEFAULT_STANDARD_ID,
      name: manifest?.governance?.standard?.name || config?.governanceStandardName || DEFAULT_STANDARD_NAME,
      owner: manifest?.governance?.standard?.owner || "Ground Zero Solutions, Inc.",
    },
    posture: {
      id: postureId,
      owner: "illuci",
    },
    verdict,
    score,
    reorganization: {
      decision: reorganizationDecision,
      reasons: reorganizationReasons,
    },
    evidence: {
      projectConfigPresent: Boolean(config),
      governanceManifestPresent: Boolean(manifest),
      rootDirectories,
      rootFiles,
      requiredDirectories: {
        present: presentRequiredDirs,
        missing: missingRequiredDirs,
      },
      unexpectedRootDirectories: unexpectedRootDirs,
      driftCandidates,
    },
    explicitExceptions,
    driftInventory,
  };
}

export default {
  assessProjectStandards,
};
