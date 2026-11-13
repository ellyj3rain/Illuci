// The genome grading-sources control — which lenses DIRECT learning (DR-194).
//
// DR-193 named the gap: a BALANCED disposition (zero tension pairs) composes,
// is measured, passes the DR-176 gates, and derives no delta — because delta
// DIRECTION came from the tension lens ALONE. The ratified D3 (DR-170) is
// multi-lens; v1 consumed the lenses asymmetrically (consistency GATES,
// provenance KEYS, tension DIRECTS). This control makes the direction sources
// an explicit, disclosed, legible choice (DR-129/130):
//
//   genomeGradingSources: string[]  — default ["tension"]  (byte-identical)
//
// TERMINAL-BY-DEFAULT (operator, DR-194): the default is tension-only, so a
// balanced disposition stays a valid terminal disposition unless the operator
// SELECTS otherwise. OPTIONALITY (operator): the classification is a control,
// not an architectural verdict — "salient" is a real, wired, selectable source.
//
// THE SALIENT LIMITATION — disclosed at the point of selection, never hidden:
// salient reinforcement deepens the poles a profile ALREADY expresses (high-C →
// higher-C) toward its expressed direction. It is grade-GATED but not
// attribution-GROUNDED: the grade says "good run", it does not say "these poles
// caused the goodness". Rosa's ruling named this autocatalysis ("geometry
// reading geometry"). The operator ratified shipping it wired and selectable
// (DR-194) with this limitation disclosed. The honest unblock — a grader that
// emits per-facet attribution — is designed in design/genome-grader-attribution.md
// and gated on a separate decision; until then "salient" is an informed choice,
// not a hidden default.

export const GRADING_SOURCES_SCHEMA = "illuci.genome.grading-sources/1";

// The sources that can DIRECT a delta today. "tension" is attribution-neutral
// geometry (opposing saliences); "salient" is expressed-pole reinforcement
// (disclosed limitation above); "behavioral" ([A102]/DR-195) is the
// outcome-grounded director — it reinforces expressed poles ONLY when the
// disposition's expression actually earned good outcomes (the honest unblock
// DR-194 §residual named, now commissioned). No source is RESERVED any longer.
export const KNOWN_GRADING_SOURCES = Object.freeze(["tension", "salient", "behavioral"]);
export const RESERVED_GRADING_SOURCES = Object.freeze([]);
export const DEFAULT_GRADING_SOURCES = Object.freeze(["tension"]);

export const SALIENT_LIMITATION =
  "salient reinforcement is grade-gated but NOT attribution-grounded — it deepens " +
  "expressed poles without evidence those poles caused the outcome (autocatalysis, " +
  "DR-193/DR-194). It reinforces even a losing disposition. The grounded alternative " +
  "is 'behavioral' ([A102]/DR-195), which only reinforces when accrued OUTCOMES earned it.";

export const BEHAVIORAL_LIMITATION =
  "behavioral ([A102]/DR-195) is outcome-grounded — it reinforces expressed poles ONLY " +
  "when the persona's accrued outcomes were substantive + gate-passing, and produces an " +
  "honest null otherwise. v1 is DISPOSITION-level (all salient facets share the run's " +
  "outcome confidence, capped — correlation, not per-facet causation); per-facet " +
  "discrimination (counterfactual) is the disclosed v2 in design/genome-grader-attribution.md.";

export class GradingSourcesConfigError extends Error {
  constructor(message) {
    super(`genome-grading-sources: ${message}`);
    this.name = "GradingSourcesConfigError";
    this.code = "GRADING_SOURCES_CONFIG_INVALID";
  }
}

/**
 * Normalize the operator-facing grading-sources control into a validated,
 * deduped, order-stable list. Absent/empty → the default (tension-only);
 * an unknown or reserved source fails closed LOUDLY (never a silent downgrade).
 *
 * @param {string[]|string|null|undefined} raw
 * @returns {string[]} a frozen subset of KNOWN_GRADING_SOURCES (never empty)
 */
export function normalizeGradingSources(raw) {
  if (raw == null) return DEFAULT_GRADING_SOURCES;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  if (list == null) {
    throw new GradingSourcesConfigError("must be an array of source names (or a comma string)");
  }
  if (list.length === 0) return DEFAULT_GRADING_SOURCES;
  const seen = [];
  for (const s of list) {
    if (typeof s !== "string") throw new GradingSourcesConfigError(`source names must be strings (got ${JSON.stringify(s)})`);
    if (RESERVED_GRADING_SOURCES.includes(s)) {
      throw new GradingSourcesConfigError(`"${s}" is a RESERVED source with no director yet — not selectable until it ships (see design/genome-grader-attribution.md)`);
    }
    if (!KNOWN_GRADING_SOURCES.includes(s)) {
      throw new GradingSourcesConfigError(`unknown source "${s}" — one of: ${KNOWN_GRADING_SOURCES.join(", ")}`);
    }
    if (!seen.includes(s)) seen.push(s);
  }
  // Order-stable canonical form (KNOWN order) so the lens tag set is deterministic.
  return Object.freeze(KNOWN_GRADING_SOURCES.filter((s) => seen.includes(s)));
}

/** Is a non-default (learning-expanding) source selected? — for disclosure/telemetry. */
export function isDefaultGradingSources(sources) {
  const n = normalizeGradingSources(sources);
  return n.length === DEFAULT_GRADING_SOURCES.length && n.every((s, i) => s === DEFAULT_GRADING_SOURCES[i]);
}

export default {
  GRADING_SOURCES_SCHEMA,
  KNOWN_GRADING_SOURCES,
  RESERVED_GRADING_SOURCES,
  DEFAULT_GRADING_SOURCES,
  SALIENT_LIMITATION,
  BEHAVIORAL_LIMITATION,
  normalizeGradingSources,
  isDefaultGradingSources,
  GradingSourcesConfigError,
};
