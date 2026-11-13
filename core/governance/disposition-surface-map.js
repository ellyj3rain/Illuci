const POSTURES = [
  "active-runtime",
  "forward-shim",
  "dark-forward",
];

function freezeRecord(record) {
  return Object.freeze({
    ...record,
    paths: Object.freeze([...record.paths]),
    consumers: Object.freeze([...(record.consumers || [])]),
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

export const DISPOSITION_SURFACE_MAP_SCHEMA = "illuci.governance.disposition-surface-map/1";

export const DISPOSITION_SURFACE_POSTURES = Object.freeze([...POSTURES]);

export const DISPOSITION_SURFACE_MAP = Object.freeze([
  freezeRecord({
    id: "seat-disposition-resolver",
    posture: "active-runtime",
    paths: [
      "core/composition/disposition-resolver.js",
      "core/composition/seat-disposition-config.js",
      "core/agents/disposition-dimensions.js",
      "core/agents/disposition-presets.js",
    ],
    consumers: [
      "core/topologies/runner.js",
      "cli/illuci.mjs",
      "core/mcp/composition-tools.js",
    ],
    evidence: "composeBehavioralDisposition resolves dimensional preset/profile configs for topology seats, illuci chat disposition flags, and compose_disposition_v1.",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "disposition-role-skill-composer",
    posture: "active-runtime",
    paths: [
      "core/agents/composition.js",
      "core/composition/role-composition.js",
      "core/agents/skill-registry.js",
      "core/roles/role-profiles.js",
    ],
    consumers: ["core/composition/disposition-resolver.js"],
    evidence: "Dimensional preset resolution composes disposition, role intent, and skill pulls before emitting the Behavioral Disposition block.",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "agent-resolver-coherence-shim",
    posture: "forward-shim",
    paths: ["core/composition/resolve-agent.js"],
    consumers: [],
    evidence: "resolveAgent delegates to the active disposition resolver and preserves preamble order as an additive coherence shim.",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "agent-core-disposition-registry",
    posture: "dark-forward",
    paths: [
      "core/agents/agent-core.js",
      "core/agents/disposition-registry.js",
    ],
    consumers: [],
    evidence: "Agent core and dispositionRef registry are source-owned schema surfaces awaiting a behavior-binding batch.",
  }),
  freezeRecord({
    id: "persona-genome-memory",
    posture: "active-runtime",
    paths: ["core/agents/persona-memory.js"],
    consumers: [
      "core/agents/composition.js",
      "core/composition/disposition-resolver.js",
      "core/agents/genome-grade.js",
      "core/mcp/genome-tools.js",
      "cli/illuci.mjs",
    ],
    evidence: "The DR-170 loop is live behind its disclosed controls: composition replays the genome under genomePrecedence, the resolver reads via readLiveProfile, the grade seam appends/seals, and the read verbs surface status/profile (A78-A88).",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "genome-grade-seam",
    posture: "active-runtime",
    paths: [
      "core/agents/genome-grade.js",
      "core/agents/grader-measurement.js",
    ],
    consumers: ["core/topologies/runner.js"],
    evidence: "The runner's grade step drives measurement -> delta -> append/seal; a nothing-to-learn run emits a typed genome_no_delta observation, never a silent skip (DR-193).",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "genome-grading-sources",
    posture: "active-runtime",
    paths: ["core/agents/genome-grading-sources.js"],
    consumers: [
      "core/agents/genome-grade.js",
      "core/mcp/dispatch-tools.js",
      "cli/illuci.mjs",
    ],
    evidence: "genomeGradingSources is the disclosed per-run control over which lenses DIRECT a delta (default [\"tension\"]; salient and behavioral are opt-ins; DR-194).",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
  freezeRecord({
    id: "genome-attribution",
    posture: "active-runtime",
    paths: ["core/agents/genome-attribution.js"],
    consumers: ["core/agents/grader-measurement.js"],
    evidence: "The behavioral lens grounds deltas in phase_outcome evidence with capped confidence and honest nulls (quality-below-floor / insufficient-evidence; DR-195).",
    smoke: "core/governance/disposition-surface-map.test.js",
  }),
]);

export function listDispositionSurfaces() {
  return DISPOSITION_SURFACE_MAP.map((entry) => ({
    ...entry,
    paths: [...entry.paths],
    consumers: [...entry.consumers],
  }));
}

export function getDispositionSurface(id) {
  const entry = DISPOSITION_SURFACE_MAP.find((record) => record.id === id);
  return entry
    ? { ...entry, paths: [...entry.paths], consumers: [...entry.consumers] }
    : null;
}

export function classifyDispositionSurfacePath(path) {
  return DISPOSITION_SURFACE_MAP
    .filter((entry) => pathIsCovered(path, entry.paths))
    .map((entry) => ({ ...entry, paths: [...entry.paths], consumers: [...entry.consumers] }));
}

export function assertDispositionSurfaceMapCoverage(trackedPaths) {
  if (!Array.isArray(trackedPaths)) {
    throw new TypeError("trackedPaths must be an array of repo-relative paths");
  }

  const normalizedTracked = trackedPaths.map(normalizePath).filter(Boolean);
  const trackedSet = new Set(normalizedTracked);
  const ids = DISPOSITION_SURFACE_MAP.map((entry) => entry.id);
  const seen = new Set();
  const duplicateIds = [...new Set(ids.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  }))];
  const invalidPostures = DISPOSITION_SURFACE_MAP
    .filter((entry) => !POSTURES.includes(entry.posture))
    .map((entry) => ({ id: entry.id, posture: entry.posture }));
  const missingPaths = DISPOSITION_SURFACE_MAP
    .flatMap((entry) => entry.paths.map((path) => ({ id: entry.id, path: normalizePath(path) })))
    .filter(({ path }) => path.endsWith("/")
      ? !normalizedTracked.some((trackedPath) => trackedPath.startsWith(path))
      : !trackedSet.has(path));
  const missingConsumers = DISPOSITION_SURFACE_MAP
    .flatMap((entry) => entry.consumers.map((path) => ({ id: entry.id, path: normalizePath(path) })))
    .filter(({ path }) => !trackedSet.has(path));
  const missingActiveSmoke = DISPOSITION_SURFACE_MAP
    .filter((entry) => entry.posture === "active-runtime" && !entry.smoke)
    .map((entry) => entry.id);

  const ok = duplicateIds.length === 0
    && invalidPostures.length === 0
    && missingPaths.length === 0
    && missingConsumers.length === 0
    && missingActiveSmoke.length === 0;

  return {
    ok,
    duplicateIds,
    invalidPostures,
    missingPaths,
    missingConsumers,
    missingActiveSmoke,
  };
}

export default {
  DISPOSITION_SURFACE_MAP_SCHEMA,
  DISPOSITION_SURFACE_POSTURES,
  DISPOSITION_SURFACE_MAP,
  listDispositionSurfaces,
  getDispositionSurface,
  classifyDispositionSurfacePath,
  assertDispositionSurfaceMapCoverage,
};
