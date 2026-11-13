/**
 * Illuci - relationship semantic classifier.
 *
 * Relationship semantics remain authored/freeform data. This module adds a
 * derived profile beside each raw tag so telemetry can accrue longitudinal
 * structure without erasing the original observation.
 */

export const RELATIONSHIP_SEMANTIC_REGISTRY = {
  "pipeline-flow": {
    canonicalTag: "pipeline-flow",
    family: "ordered-handoff",
    intent: "stage-output-transfer",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: ["stage-handoff", "release-handoff"],
  },
  "submits-to": {
    canonicalTag: "submits-to",
    family: "ordered-handoff",
    intent: "work-product-review-transfer",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: [],
  },
  "approves-for": {
    canonicalTag: "approves-for",
    family: "gate",
    intent: "approval-transfer",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: [],
  },
  "reports-to": {
    canonicalTag: "reports-to",
    family: "hierarchy",
    intent: "upward-reporting",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: [],
  },
  "directs": {
    canonicalTag: "directs",
    family: "hierarchy",
    intent: "downward-direction",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: ["commands"],
  },
  "evaluates": {
    canonicalTag: "evaluates",
    family: "assessment",
    intent: "judgment-or-scoring",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: ["considers", "scores"],
  },
  "synthesizes": {
    canonicalTag: "synthesizes",
    family: "integration",
    intent: "merge-multiple-contributions",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: ["integrates", "consolidates"],
  },
  "critiques": {
    canonicalTag: "critiques",
    family: "challenge",
    intent: "quality-pressure",
    ontologyLayer: "topology-edge",
    dataStatus: "observed-stable",
    aliases: ["challenges", "questions"],
  },
};

const ALIAS_TO_CANONICAL = Object.freeze(Object.fromEntries(
  Object.values(RELATIONSHIP_SEMANTIC_REGISTRY).flatMap((entry) =>
    (entry.aliases || []).map((alias) => [normalizeSemanticTag(alias), entry.canonicalTag]),
  ),
));

export function normalizeSemanticTag(tag) {
  return String(tag ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

export function classifyRelationshipSemantics(tag, context = {}) {
  const raw = String(tag ?? "");
  const normalizedTag = normalizeSemanticTag(raw);
  const canonicalTag = ALIAS_TO_CANONICAL[normalizedTag] || normalizedTag;
  const entry = RELATIONSHIP_SEMANTIC_REGISTRY[canonicalTag] || null;

  return {
    raw,
    normalizedTag,
    canonicalTag,
    known: Boolean(entry),
    family: entry?.family || "freeform-emergent",
    intent: entry?.intent || null,
    ontologyLayer: entry?.ontologyLayer || context.ontologyLayer || "topology-edge",
    dataStatus: entry?.dataStatus || "freeform-observed",
    aliasOf: canonicalTag !== normalizedTag ? canonicalTag : null,
    edgeType: context.edgeType || null,
  };
}

export default {
  RELATIONSHIP_SEMANTIC_REGISTRY,
  normalizeSemanticTag,
  classifyRelationshipSemantics,
};
