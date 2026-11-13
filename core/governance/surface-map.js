const POSTURES = [
  "live-run-path",
  "gated",
  "dark-forward",
  "provenance",
  "generated-local",
];

const VISIBILITY_LEVELS = [
  "primary",
  "diagnostic-advisory",
  "source-owned",
];

const READINESS_LEVELS = [
  "active",
  "planned",
  "deprecated",
  "extraction-residue",
];

const REQUIRED_PUBLIC_SURFACES = [
  "cli/illuci.mjs",
  "cli/tui/",
  ".github/workflows/ci-verify.yml",
  ".github/workflows/dependency-scan.yml",
  ".github/workflows/gitops-token-doctor.yml",
  ".github/workflows/generate-docs.yml",
  "README.md",
  "PROVIDERS.md",
  "COMPONENTS.md",
  "ARCHITECTURE.md",
  "GOVERNANCE.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
  "BATCH_LOG.md",
  "DECISION_REGISTRY.md",
  "VERSION",
  "package.json",
  "package-lock.json",
  "core/runtime/",
  "core/model-resource.js",
  "core/model-resource-reasoning-map.js",
];

function freezeRecord(record) {
  return Object.freeze({
    ...record,
    paths: Object.freeze([...record.paths]),
  });
}

function normalizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathIsCovered(path, prefixes) {
  const normalized = normalizePath(path);
  return prefixes.some((prefix) => {
    const candidate = normalizePath(prefix);
    return candidate.endsWith("/")
      ? normalized.startsWith(candidate)
      : normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

export const SURFACE_MAP_SCHEMA = "illuci.governance.surface-map/1";

export const SURFACE_POSTURES = Object.freeze([...POSTURES]);

export const SURFACE_VISIBILITY_LEVELS = Object.freeze([...VISIBILITY_LEVELS]);

export const SURFACE_READINESS_LEVELS = Object.freeze([...READINESS_LEVELS]);

export const SURFACE_MAP = Object.freeze([
  freezeRecord({
    id: "agent-runtime-sdk",
    paths: ["core/agent/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "core/agent/index.js exports the run loop API consumed by topology/company execution.",
  }),
  freezeRecord({
    id: "datastore",
    paths: ["core/datastore/"],
    posture: "gated",
    readiness: "active",
    pruneAction: "retain",
    visibility: "source-owned",
    loadBearing: false,
    evidence: "Unified polyglot datastore — event-sourced SQLite trunk + sqlite-vec/graph/DuckDB projections; dark behind ILLUCI_DATASTORE_ENABLED; captures run/company output and derived read-models over it.",
  }),
  freezeRecord({
    id: "identity-disposition-substrate",
    paths: ["core/agents/", "core/identity/", "core/governance/disposition-surface-map.js"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain-with-deprecated-subpath-overlay",
    visibility: "primary",
    loadBearing: true,
    evidence: "core/governance/disposition-surface-map.js classifies active disposition resolution, the resolve-agent shim, and dark-forward registry/memory surfaces.",
  }),
  freezeRecord({
    id: "legacy-anthropology-retirements",
    paths: ["core/agents/anthropology/"],
    posture: "provenance",
    readiness: "deprecated",
    pruneAction: "quarantine-or-remove-after-replacement-check",
    visibility: "diagnostic-advisory",
    loadBearing: false,
    evidence: "DR-003 retired the extracted anthropology specialist-role corpus into core/roles/specialists; the surviving README is retirement context, not an active anthropology scaffold.",
    next: "[A4.16.core-prune]",
  }),
  freezeRecord({
    id: "composition-roles-and-skills",
    paths: ["core/composition/", "core/roles/", "core/skills/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "Graph presets, role context, specialist profiles, and skill-framework catalogs resolve runtime seats.",
    next: "work-permit-binding",
  }),
  freezeRecord({
    id: "topology-and-company-runtime",
    paths: ["core/topologies/", "core/orchestrate/", "core/presets/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "core/topologies/runner.js, core/orchestrate/company.js, and preset commands are covered by CLI/test smokes.",
  }),
  freezeRecord({
    id: "dispatch-bridges-and-model-resources",
    paths: [
      "core/dispatch/",
      "core/bridges/",
      "core/fleet/",
      "core/health/",
      "core/matrix/",
      "core/preflight/",
      "core/reasoning/",
      "core/model-resource.js",
      "core/model-resource-reasoning-map.js",
    ],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "A4.13 dispatch tests prove selected channel, bridge target, controls, and modelRuntime provenance.",
  }),
  freezeRecord({
    id: "governance-gates-and-invariants",
    paths: ["core/governance/", "core/gates/", "core/invariants/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "npm run governance:floor, npm run governance:ceiling, runtime gate tests, and compiled atoms use these paths.",
  }),
  freezeRecord({
    id: "typed-contracts-spine",
    paths: ["core/contracts/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "source-owned",
    loadBearing: true,
    evidence: "core/contracts/ is the typed contract spine (DR-105 / A30): topology.d.ts canonical types + the Zod runtime-topology border validator (validateRuntimeTopology), checked by npm run typecheck (folded into the test lane) and node:test.",
    next: "wire-runtime-topology-border-into-createRuntimeTopology",
  }),
  freezeRecord({
    id: "illuci-runtime-service",
    paths: ["core/runtime/", "core/connections/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "core/runtime/ is the Illuci Runtime service (identity/capability/doctor + HTTP transport via illuci runtime serve); core/connections/ is its managed per-tenant auth substrate (registry/store/credential-resolver/tenant-context) so a tenant request routes with its own credential, never the server env. [A22]",
  }),
  freezeRecord({
    id: "protocol-and-tool-boundaries",
    paths: ["core/mcp/", "core/acp/", "core/protocol/", "core/tools/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "npm run verify:protocol exercises MCP in-process/stdio and ACP in-process/stdio boundaries.",
  }),
  freezeRecord({
    id: "security-engine-adapter-contract",
    paths: ["core/security/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "diagnostic-advisory",
    loadBearing: true,
    evidence: "core/security/engine-adapter.js normalizes sibling security engine capabilities, permit facts, egress profiles, and evidence references without importing engine internals.",
  }),
  freezeRecord({
    id: "runtime-data-and-events",
    paths: [
      "core/awareness/",
      "core/config/",
      "core/context/",
      "core/data/",
      "core/decisions/",
      "core/events/",
      "core/resilience/",
      "core/sessions/",
      "core/storage/",
      "core/telemetry/",
      "core/throttle/",
    ],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "Runtime state, observations, decisions, event feeds, resilience, sessions, and telemetry are exercised by node tests.",
  }),
  freezeRecord({
    id: "pipeline-and-formation-runtime",
    paths: ["core/pipelines/", "core/formation/", "core/analysis/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "Pipeline CLI plan/run and formation/cost-model tests cover the public orchestration substrate.",
    next: "dogfood-pipeline-readiness",
  }),
  freezeRecord({
    id: "project-and-sandbox-substrate",
    paths: ["core/projects/", "core/sandbox/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "Project substrate commands and sandbox hygiene tests own cross-repo attachment and local repair behavior.",
  }),
  freezeRecord({
    id: "operator-console-and-public-cli",
    paths: ["cli/illuci.mjs", "cli/tui/", "cli/repl/", "cli/bin_wrapper/", "cli/disposition-flags.mjs", "core/operator/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "npm run smoke:help, smoke:topologies, smoke:matrix, and CLI test files exercise public entrypoints.",
    next: "[A4.15]",
  }),
  freezeRecord({
    id: "github-ci-security-automation",
    paths: [
      ".github/workflows/ci-verify.yml",
      ".github/workflows/cd-dry-run.yml",
      ".github/workflows/dependency-scan.yml",
      ".github/workflows/gitops-token-doctor.yml",
      ".github/workflows/generate-docs.yml",
      ".github/scripts/",
      ".github/dependabot.yml",
      ".github/pull_request_template.md",
    ],
    posture: "gated",
    readiness: "active",
    pruneAction: "retain",
    visibility: "diagnostic-advisory",
    loadBearing: true,
    evidence: "CI (self-hosted runner) owns ci-verify and dependency-scan plus PR chronology, GitOps token readiness, and release gates; SAST + secret detection run in the GitLab pipeline (DR-097).",
  }),
  freezeRecord({
    id: "root-governance-and-entry-docs",
    paths: [
      "README.md",
      "PROVIDERS.md",
      "CORE.md",
      "CONTEXT.md",
      "ARCHITECTURE.md",
      "COMPONENTS.md",
      "GOVERNANCE.md",
      "DOCTRINE.md",
      "HIVEMIND.md",
      "ILLUCI.md",
      "ROADMAP.md",
      "SESSION_STATE.md",
      "BATCH_LOG.md",
      "DECISION_REGISTRY.md",
      "FINDINGS.md",
      "VERSION",
    ],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "Governance docs, ledgers, and VERSION are read by operators and author-time governance gates.",
  }),
  freezeRecord({
    id: "package-distribution-boundary",
    paths: ["package.json", "package-lock.json", "runtime/", "scripts/"],
    posture: "gated",
    readiness: "active",
    pruneAction: "retain",
    visibility: "diagnostic-advisory",
    loadBearing: true,
    evidence: "package files define npm bin/files/dependencies; deploy verification proves fresh checkout install and CLI load.",
  }),
  freezeRecord({
    id: "infrastructure-account-posture-doctor",
    paths: [
      "core/infrastructure/account-posture.js",
      "core/data/paths.js",
      "core/roles/skill-frameworks/catalog.js",
      "core/roles/specialists/profiles/infrastructure/",
      "cli/illuci.mjs",
    ],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "diagnostic-advisory",
    loadBearing: true,
      evidence: "illuci infrastructure doctor emits account, quota, API, frontend-verification, execution-substrate, and adapter-family posture for GitHub, GitLab, Vercel, Supabase, and Obsidian.",
  }),
  freezeRecord({
    id: "generated-local-trace-surface",
    paths: ["core/traces/"],
    posture: "generated-local",
    readiness: "active",
    pruneAction: "retain-support-code-only",
    visibility: "diagnostic-advisory",
    loadBearing: false,
    evidence: "Trace organizer code supports local runtime trace cleanup; trace payloads remain generated local data.",
  }),
  freezeRecord({
    id: "surface-capability-card",
    paths: ["core/surface/"],
    posture: "live-run-path",
    readiness: "active",
    pruneAction: "retain",
    visibility: "primary",
    loadBearing: true,
    evidence: "core/surface/capability-card.js + feature-gates.js build illuci's self-description (identity, CLI/MCP/API invocation, capabilities on/gated/dark, run-posture defaults + feature gates with turn-on controls); surfaced via `illuci describe` and the illuci://surface/capability-card MCP resource. Disclosure-only, grounded in the surface-map + defaults + feature-gate registries.",
  }),
]);

export const REQUIRED_PUBLIC_SURFACE_PATHS = Object.freeze([...REQUIRED_PUBLIC_SURFACES]);

export function listSurfaceMap() {
  return SURFACE_MAP.map((entry) => ({ ...entry, paths: [...entry.paths] }));
}

export function listSurfacePostures() {
  return SURFACE_POSTURES.map((posture) => ({
    posture,
    count: SURFACE_MAP.filter((entry) => entry.posture === posture).length,
  }));
}

export function summarizeSurfaceMap(entries = SURFACE_MAP) {
  const summary = {
    total: entries.length,
    loadBearing: entries.filter((entry) => entry.loadBearing).length,
    byPosture: Object.fromEntries(SURFACE_POSTURES.map((posture) => [posture, 0])),
    byVisibility: Object.fromEntries(SURFACE_VISIBILITY_LEVELS.map((visibility) => [visibility, 0])),
    byReadiness: Object.fromEntries(SURFACE_READINESS_LEVELS.map((readiness) => [readiness, 0])),
  };

  for (const entry of entries) {
    summary.byPosture[entry.posture] = (summary.byPosture[entry.posture] || 0) + 1;
    summary.byVisibility[entry.visibility] = (summary.byVisibility[entry.visibility] || 0) + 1;
    summary.byReadiness[entry.readiness] = (summary.byReadiness[entry.readiness] || 0) + 1;
  }

  return summary;
}

export function listDiagnosticSurfaces(options = {}) {
  const { includeAll = false, posture = null, readiness = null, loadBearing = null } = options;

  return listSurfaceMap()
    .filter((entry) => includeAll || entry.visibility === "diagnostic-advisory")
    .filter((entry) => !posture || entry.posture === posture)
    .filter((entry) => !readiness || entry.readiness === readiness)
    .filter((entry) => loadBearing === null || entry.loadBearing === loadBearing);
}

export function getSurfaceEntry(id) {
  const entry = SURFACE_MAP.find((record) => record.id === id);
  return entry ? { ...entry, paths: [...entry.paths] } : null;
}

export function surfacePathPrefixes() {
  return SURFACE_MAP.flatMap((entry) => entry.paths);
}

export function classifySurfacePath(path) {
  const normalized = normalizePath(path);
  const matches = SURFACE_MAP.filter((entry) => pathIsCovered(normalized, entry.paths));
  return matches.map((entry) => ({ ...entry, paths: [...entry.paths] }));
}

export function assertSurfaceMapCoverage(trackedPaths, options = {}) {
  if (!Array.isArray(trackedPaths)) {
    throw new TypeError("trackedPaths must be an array of repo-relative paths");
  }

  const requiredPublicSurfaces = options.requiredPublicSurfaces ?? REQUIRED_PUBLIC_SURFACES;
  const normalizedTracked = trackedPaths.map(normalizePath).filter(Boolean);
  const trackedSet = new Set(normalizedTracked);
  const mappedPrefixes = surfacePathPrefixes().map(normalizePath);

  const coreDirectories = [...new Set(
    normalizedTracked
      .filter((path) => path.startsWith("core/"))
      .map((path) => path.split("/"))
      .filter((parts) => parts.length > 2)
      .map((parts) => parts[1])
  )].sort();

  const ids = SURFACE_MAP.map((entry) => entry.id);
  const seen = new Set();
  const duplicateIds = [...new Set(ids.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  }))];

  const invalidPostures = SURFACE_MAP
    .filter((entry) => !POSTURES.includes(entry.posture))
    .map((entry) => ({ id: entry.id, posture: entry.posture }));

  const invalidVisibility = SURFACE_MAP
    .filter((entry) => !VISIBILITY_LEVELS.includes(entry.visibility))
    .map((entry) => ({ id: entry.id, visibility: entry.visibility }));

  const invalidReadiness = SURFACE_MAP
    .filter((entry) => !READINESS_LEVELS.includes(entry.readiness))
    .map((entry) => ({ id: entry.id, readiness: entry.readiness }));

  const missingPruneAction = SURFACE_MAP
    .filter((entry) => typeof entry.pruneAction !== "string" || entry.pruneAction.trim() === "")
    .map((entry) => entry.id);

  const missingCoreDirectories = coreDirectories
    .filter((directory) => !pathIsCovered(`core/${directory}/__coverage_probe__`, mappedPrefixes))
    .map((directory) => `core/${directory}/`);

  const missingPublicSurfaces = requiredPublicSurfaces
    .map(normalizePath)
    .filter((path) => !pathIsCovered(path, mappedPrefixes));

  const missingMappedPaths = SURFACE_MAP.flatMap((entry) => entry.paths.map(normalizePath).map((path) => ({ entry, path })))
    .filter(({ entry, path }) => {
      if (entry.posture === "generated-local") return false;
      return path.endsWith("/")
        ? !normalizedTracked.some((trackedPath) => trackedPath.startsWith(path))
        : !trackedSet.has(path);
    })
    .map(({ entry, path }) => ({ id: entry.id, path }));

  const ok = duplicateIds.length === 0
    && invalidPostures.length === 0
    && invalidVisibility.length === 0
    && invalidReadiness.length === 0
    && missingPruneAction.length === 0
    && missingCoreDirectories.length === 0
    && missingPublicSurfaces.length === 0
    && missingMappedPaths.length === 0;

  return {
    ok,
    duplicateIds,
    invalidPostures,
    invalidVisibility,
    invalidReadiness,
    missingPruneAction,
    missingCoreDirectories,
    missingPublicSurfaces,
    missingMappedPaths,
    coreDirectories,
  };
}

export default {
  SURFACE_MAP_SCHEMA,
  SURFACE_POSTURES,
  SURFACE_VISIBILITY_LEVELS,
  SURFACE_READINESS_LEVELS,
  SURFACE_MAP,
  REQUIRED_PUBLIC_SURFACE_PATHS,
  listSurfaceMap,
  listSurfacePostures,
  summarizeSurfaceMap,
  listDiagnosticSurfaces,
  getSurfaceEntry,
  surfacePathPrefixes,
  classifySurfacePath,
  assertSurfaceMapCoverage,
};
