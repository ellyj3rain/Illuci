/**
 * illuci — company-rounds: the StopCondition + RoundCeiling shapes (defaults + validation
 * + JSON Schema).
 *
 * THE TWO BRAKES, SEPARATED ON PURPOSE.
 *   - RoundCeiling is the HARD outer bound: "run at most N rounds, full stop." It is the
 *     one knob that, at its default (maxRounds:1), makes a company-rounds run BYTE-IDENTICAL
 *     to a single plain orchestrate() pass — exactly one round, no second pass, the round-1
 *     company result returned untouched.
 *   - StopCondition is the SOFT progress bound: the no-progress / budget detector that can
 *     stop the loop EARLY (before the ceiling) when the bodies stop disagreeing in a way
 *     that produces new work. It NEVER extends past the ceiling — it only ever stops sooner.
 *
 * These shapes are pure DATA (no LLM, no embeddings, no clock, no randomness). The loop
 * (company-rounds.js) and the brakes (brakes.js) read them; nothing here decides anything.
 */

/** The HARD outer bound. Default 1 ⇒ exactly one round ⇒ byte-identical to plain orchestrate. */
export const DEFAULT_ROUND_CEILING = Object.freeze({ kind: "RoundCeiling", maxRounds: 1 });

/**
 * The SOFT progress bound. Defaults chosen so an UN-CONFIGURED StopCondition is the
 * gentlest-possible early-stop:
 *   - tokenCeiling:null      ⇒ unlimited (the session budget never trips the budget brake)
 *   - minCollisionHunks:1    ⇒ a single diff hunk counts as progress (the no-progress gate
 *                              needs FEWER than this to consider a round stalled)
 *   - maxTokenOverlap:0.85   ⇒ above 85% cross-body token overlap, the disagreement is
 *                              "cosmetic" (heterogeneityProof.cosmetic = true)
 *   - stallRounds:1          ⇒ the triple-gate must hold for 1 consecutive round to fire
 */
export const DEFAULT_STOP_CONDITION = Object.freeze({
  kind: "StopCondition",
  tokenCeiling: null,
  minCollisionHunks: 1,
  maxTokenOverlap: 0.85,
  stallRounds: 1,
});

/** Normalize + default a RoundCeiling. A bad/absent maxRounds falls back to 1. */
export function makeRoundCeiling(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const maxRounds = Number.isInteger(src.maxRounds) && src.maxRounds > 0 ? src.maxRounds : 1;
  return { kind: "RoundCeiling", maxRounds };
}

/** Normalize + default a StopCondition. Each field independently falls back to its default. */
export function makeStopCondition(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const tokenCeiling = Number.isFinite(src.tokenCeiling) && src.tokenCeiling > 0 ? src.tokenCeiling : null;
  const minCollisionHunks = Number.isInteger(src.minCollisionHunks) && src.minCollisionHunks >= 0
    ? src.minCollisionHunks : DEFAULT_STOP_CONDITION.minCollisionHunks;
  const maxTokenOverlap = Number.isFinite(src.maxTokenOverlap) && src.maxTokenOverlap >= 0 && src.maxTokenOverlap <= 1
    ? src.maxTokenOverlap : DEFAULT_STOP_CONDITION.maxTokenOverlap;
  const stallRounds = Number.isInteger(src.stallRounds) && src.stallRounds >= 1
    ? src.stallRounds : DEFAULT_STOP_CONDITION.stallRounds;
  return { kind: "StopCondition", tokenCeiling, minCollisionHunks, maxTokenOverlap, stallRounds };
}

/**
 * Normalize a full AdversarialCompanyConfig: the two adversarial bodies (commune,
 * devStructure), the round ceiling, the stop condition, and an OPTIONAL advisory evaluator.
 *
 * commune     — the divergent/exploratory body (a topology id + optional lineup + mandate).
 * devStructure— the convergent/engineering body (a topology id + optional lineup + mandate).
 * evaluator   — OPTIONAL: an advisory topology consulted each round; it can NEVER halt.
 */
export function makeAdversarialCompanyConfig(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  return {
    kind: "AdversarialCompanyConfig",
    commune: normalizeBody(src.commune),
    devStructure: normalizeBody(src.devStructure),
    roundCeiling: makeRoundCeiling(src.roundCeiling),
    stopCondition: makeStopCondition(src.stopCondition),
    evaluator: src.evaluator ? normalizeEvaluator(src.evaluator) : null,
  };
}

function normalizeBody(body) {
  const b = body && typeof body === "object" ? body : {};
  return {
    topologyId: typeof b.topologyId === "string" ? b.topologyId : null,
    ...(b.lineup && typeof b.lineup === "object" ? { lineup: b.lineup } : {}),
    ...(b.mandate != null ? { mandate: b.mandate } : {}),
  };
}

function normalizeEvaluator(evaluator) {
  const e = evaluator && typeof evaluator === "object" ? evaluator : {};
  return {
    topologyId: typeof e.topologyId === "string" ? e.topologyId : null,
    ...(e.lineup && typeof e.lineup === "object" ? { lineup: e.lineup } : {}),
  };
}

/**
 * Validate a (raw or normalized) AdversarialCompanyConfig. Returns { valid, errors }.
 * Validation is structural only — it never dispatches, never inspects the fleet.
 */
export function validate(config = {}) {
  const errors = [];
  const c = config && typeof config === "object" ? config : {};

  if (!c.commune || typeof c.commune !== "object") {
    errors.push("commune is required (an object with a string topologyId)");
  } else if (typeof c.commune.topologyId !== "string" || !c.commune.topologyId) {
    errors.push("commune.topologyId must be a non-empty string");
  }

  if (!c.devStructure || typeof c.devStructure !== "object") {
    errors.push("devStructure is required (an object with a string topologyId)");
  } else if (typeof c.devStructure.topologyId !== "string" || !c.devStructure.topologyId) {
    errors.push("devStructure.topologyId must be a non-empty string");
  }

  const rc = c.roundCeiling;
  if (rc != null) {
    if (typeof rc !== "object") errors.push("roundCeiling must be an object");
    else if (!(Number.isInteger(rc.maxRounds) && rc.maxRounds > 0)) {
      errors.push("roundCeiling.maxRounds must be a positive integer");
    }
  }

  const sc = c.stopCondition;
  if (sc != null) {
    if (typeof sc !== "object") {
      errors.push("stopCondition must be an object");
    } else {
      if (sc.tokenCeiling != null && !(Number.isFinite(sc.tokenCeiling) && sc.tokenCeiling > 0)) {
        errors.push("stopCondition.tokenCeiling must be a positive number or null");
      }
      if (sc.minCollisionHunks != null && !(Number.isInteger(sc.minCollisionHunks) && sc.minCollisionHunks >= 0)) {
        errors.push("stopCondition.minCollisionHunks must be a non-negative integer");
      }
      if (sc.maxTokenOverlap != null && !(Number.isFinite(sc.maxTokenOverlap) && sc.maxTokenOverlap >= 0 && sc.maxTokenOverlap <= 1)) {
        errors.push("stopCondition.maxTokenOverlap must be a number in [0,1]");
      }
      if (sc.stallRounds != null && !(Number.isInteger(sc.stallRounds) && sc.stallRounds >= 1)) {
        errors.push("stopCondition.stallRounds must be an integer >= 1");
      }
    }
  }

  if (c.evaluator != null) {
    if (typeof c.evaluator !== "object") errors.push("evaluator must be an object or null");
    else if (typeof c.evaluator.topologyId !== "string" || !c.evaluator.topologyId) {
      errors.push("evaluator.topologyId must be a non-empty string when an evaluator is configured");
    }
  }

  return { valid: errors.length === 0, errors };
}

/** JSON Schema for the AdversarialCompanyConfig (draft-07). For tooling + the CLI surface. */
export const ADVERSARIAL_COMPANY_CONFIG_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AdversarialCompanyConfig",
  type: "object",
  required: ["commune", "devStructure"],
  additionalProperties: true,
  properties: {
    commune: { $ref: "#/definitions/body" },
    devStructure: { $ref: "#/definitions/body" },
    roundCeiling: {
      type: "object",
      properties: {
        kind: { const: "RoundCeiling" },
        maxRounds: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["maxRounds"],
    },
    stopCondition: {
      type: "object",
      properties: {
        kind: { const: "StopCondition" },
        tokenCeiling: { type: ["integer", "null"], minimum: 1, default: null },
        minCollisionHunks: { type: "integer", minimum: 0, default: 1 },
        maxTokenOverlap: { type: "number", minimum: 0, maximum: 1, default: 0.85 },
        stallRounds: { type: "integer", minimum: 1, default: 1 },
      },
    },
    evaluator: {
      type: ["object", "null"],
      properties: {
        topologyId: { type: "string", minLength: 1 },
        lineup: { type: "object" },
      },
      required: ["topologyId"],
    },
  },
  definitions: {
    body: {
      type: "object",
      required: ["topologyId"],
      properties: {
        topologyId: { type: "string", minLength: 1 },
        lineup: { type: "object" },
        mandate: {},
      },
    },
  },
});

export default {
  DEFAULT_ROUND_CEILING,
  DEFAULT_STOP_CONDITION,
  makeRoundCeiling,
  makeStopCondition,
  makeAdversarialCompanyConfig,
  validate,
  ADVERSARIAL_COMPANY_CONFIG_SCHEMA,
};
