/**
 * Dynamic composition resolution record.
 *
 * Illuci layers stay maximally dynamic by resolving from intent, presets, slugs,
 * settings, and runtime context. They stay governable by returning this record
 * shape instead of a bare value or Boolean.
 */

export const RESOLUTION_STATUSES = Object.freeze([
  "resolved",
  "resolved-with-candidates",
  "candidates-below-threshold",
  "unresolved",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function confidenceOf(candidate) {
  return typeof candidate?.confidence === "number" ? candidate.confidence : 0;
}

function statusFor({ resolved, candidates, status }) {
  if (RESOLUTION_STATUSES.includes(status)) return status;
  if (resolved) return candidates && candidates.length > 1 ? "resolved-with-candidates" : "resolved";
  return candidates && candidates.length > 0 ? "candidates-below-threshold" : "unresolved";
}

export function defineResolutionRecord(input = {}) {
  const {
    layer,
    query,
    resolved = null,
    candidates = [],
    threshold = 0.5,
    confidence = candidates.length > 0 ? confidenceOf(candidates[0]) : 0,
    resolver = "unknown",
    status = null,
    ui = {},
    telemetry = {},
    governance = {},
    provenance = {},
  } = input;

  if (typeof layer !== "string" || layer.trim() === "") {
    throw new Error("resolution record requires a non-empty layer");
  }
  if (!Array.isArray(candidates)) {
    throw new Error("resolution record candidates must be an array");
  }

  const normalizedThreshold = typeof threshold === "number" ? threshold : 0.5;
  const normalized = {
    layer,
    query: query ?? null,
    resolved,
    confidence,
    candidates,
    ui: isObject(ui) ? ui : {},
    telemetry: {
      ...telemetry,
      resolver,
      threshold: normalizedThreshold,
      status: statusFor({ resolved, candidates, status }),
      candidateCount: telemetry.candidateCount ?? candidates.length,
    },
    governance: {
      auditable: true,
      dynamic: true,
      ...governance,
    },
    provenance: isObject(provenance) ? provenance : {},
  };

  return Object.freeze(normalized);
}

export default {
  RESOLUTION_STATUSES,
  defineResolutionRecord,
};
