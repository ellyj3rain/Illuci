/**
 * illuci — Seat + Agent types (Phase F harden, batch 1, TYPES lane)
 *
 * Promotes Seat (and Agent) from inline POJO literals to first-class VALIDATED
 * types. Today seats are bare objects in index.js
 *   ({ id, label, min, max, roleHint, weight, relationships: [...] });
 * invalid cardinality / weight / relationship / roleHint passes through silently
 * until it fails opaquely somewhere downstream at runtime. This module makes the
 * implicit invariants explicit and catches a malformed seat EARLY — at definition
 * time and at runtime lineup assignment — with a precise, field-specific message.
 *
 * ─── BACK-COMPAT CONTRACT (SACRED) ───────────────────────────────────────────
 * This module is ADDITIVE. A valid existing topology validates and runs
 * byte-identically; only a malformed seat (a typo) now errors early.
 *
 *   1. SHAPE IDENTITY. createSeat applies the EXACT same defaults the index.js
 *      literals / registerFreeformTopology / mutateLiveTopology already apply
 *      (label||id, min??1, max??1, roleHint||null, weight??1.0, relationships||[])
 *      in the SAME field order, so for every existing seat:
 *        JSON.stringify(createSeat(seat)) === JSON.stringify(seat).
 *      Each relationship is re-emitted as { type, target, semantics } — the
 *      literal's order — so the byte-identity holds at the edge level too.
 *
 *   2. VOCABULARY IS DERIVED, NOT RE-HARDCODED. KNOWN_ROLE_HINTS = new Set(
 *      getRoles()) (the capability matrix's role union) and
 *      KNOWN_RELATIONSHIP_TYPES = new Set(RELATIONSHIP_TYPES) (the runner's
 *      dispatch-handled edge types). A future matrix / relationship change can
 *      not silently desync the validator — there is a single source of truth.
 *
 *   3. semantics STAYS FREE-FORM. relationship.semantics is validated for TYPE
 *      (a non-empty string) only, never against an enum. ~80 distinct semantics
 *      tags live across the registry; an enum would reject dozens of them.
 *
 *   4. REFERENTIAL INTEGRITY IS ADVISORY. A relationship whose target does not
 *      point at a real sibling seat is collected as a WARNING, never a hard
 *      error — legitimate self-targeting (war-room, perception-council,
 *      darwinian) and any pre-existing dangling target must not newly throw.
 *      Hard errors are confined to cardinality, weight range, vocab membership,
 *      and shape — invariants no current topology violates.
 *
 * ─── AGENT (the batch-2 seam) ────────────────────────────────────────────────
 * Agent is the runtime occupant of a seat — { modelId, seatId, roleHint, weight,
 * mandate } — carrying the never-loosened mandate invariant: a constructed
 * Agent's effective mandate revision must be >= its floor revision. A child /
 * seat agent can be revised FORWARD (reviseMandate bumps revision) but an Agent
 * carrying a LOWER revision than its floor is rejected. Nothing on the existing
 * path constructs an Agent yet — the worker-threads isolation lane (batch 2)
 * wires createAgent when a seat is hydrated across a thread boundary and the
 * inherited mandate floor must be re-asserted. Until then it is dead-but-tested
 * additive code with zero runtime effect on current runs.
 *
 * Run the suite: node --test illuci/core/topologies/seat-type.test.js
 */
// @ts-check

import { getRoles } from "../matrix/capability-matrix.js";
import { RELATIONSHIP_TYPES } from "./relationship-types.js";

// ─── DERIVED VOCABULARY (frozen) ─────────────────────────────────────────────

/**
 * Every role hint a seat may legitimately carry, DERIVED from the capability
 * matrix's full role enumeration (availability-independent — getRoles() lists
 * ALL roles in MODEL_CAPABILITIES regardless of which models are online). A
 * null roleHint is always allowed (auto-fill falls back to "analyst").
 * @type {Set<string>}
 */
export const KNOWN_ROLE_HINTS = new Set(getRoles());

/**
 * Every relationship edge type the runner has a dispatch handler for, DERIVED
 * from the leaf relationship-types module (the single source of truth). The
 * leaf is dependency-free, so there is NO import cycle and this Set is safe to
 * build eagerly at module-init time.
 * @type {Set<string>}
 */
export const KNOWN_RELATIONSHIP_TYPES = new Set(RELATIONSHIP_TYPES);

/**
 * Return the known relationship-type set (a stable accessor used by STRESS and
 * the index.js canvas-coercion path).
 * @returns {Set<string>}
 */
export function getKnownRelationshipTypes() {
  return KNOWN_RELATIONSHIP_TYPES;
}

// ─── CANONICAL TYPES ([A21.5]: the contracts spine is the ONE shape owner) ────

/**
 * The canonical validated seat shape. The local `Seat` name survives as an
 * ALIAS of the spine's SeatSpec (extend-never-fork, DR-105): topology.d.ts
 * declares SeatSpec as the type-level mirror of THIS module's byte-identity
 * contract, and this alias closes the loop — one shape, two names, zero drift.
 * @typedef {import("../contracts/topology.d.ts").SeatSpec} Seat
 */

/**
 * An UNVALIDATED seat candidate as it arrives at this border (a registry
 * literal, canvas-drawn object, or live mutation). Fields are typed `unknown`
 * because that is the truth before validateSeat proves them — the runtime
 * checks below are the narrowing.
 * @typedef {{ id?: unknown, label?: unknown, min?: unknown, max?: unknown, roleHint?: unknown, weight?: unknown, relationships?: unknown }} RawSeatCandidate
 */

/**
 * An unvalidated relationship-edge candidate (same border semantics).
 * @typedef {{ type?: unknown, target?: unknown, semantics?: unknown }} RawRelationshipCandidate
 */

// ─── ERROR ───────────────────────────────────────────────────────────────────

/**
 * A precise, early, opaque-free seat/agent validation failure. Carries the
 * coordinates of the offending field so a typo names the topology, seat, field,
 * and value instead of failing somewhere downstream at runtime. STRESS asserts
 * on this by type (`err instanceof SeatError`).
 */
export class SeatError extends Error {
  /**
   * @param {string} message
   * @param {{ topologyId?: string, seatId?: unknown, field?: string | null, value?: unknown }} [coords]
   */
  constructor(message, { topologyId, seatId, field, value } = {}) {
    super(message);
    this.name = "SeatError";
    this.topologyId = topologyId ?? null;
    this.seatId = seatId ?? null;
    this.field = field ?? null;
    this.value = value;
  }
}

// ─── HELPERS (type guards — the compiler rides the same checks the runtime runs) ──

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isInteger(v) {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * @param {Set<string>|string[]|null|undefined} knownSeatIds
 * @returns {Set<string>|null}
 */
function toIdSet(knownSeatIds) {
  if (!knownSeatIds) return null;
  return knownSeatIds instanceof Set ? knownSeatIds : new Set(knownSeatIds);
}

// ─── SEAT VALIDATION ───────────────────────────────────────────────────────────

/**
 * Pure validator — never throws, returns a report. Checks the seat's implicit
 * invariants (cardinality, weight range, vocabulary membership, shape) as hard
 * errors, and dangling relationship targets as advisory warnings (only when
 * opts.knownSeatIds is supplied).
 *
 * @param {RawSeatCandidate|null|undefined} seat — a normalized or raw seat object
 * @param {{ topologyId?: string, knownSeatIds?: Set<string>|string[] }} [opts]
 * @returns {{ valid: boolean, errors: SeatError[], warnings: SeatError[] }}
 */
export function validateSeat(seat, opts = {}) {
  const { topologyId } = opts;
  /** @type {SeatError[]} */
  const errors = [];
  /** @type {SeatError[]} */
  const warnings = [];
  const seatId = seat && typeof seat === "object" ? seat.id : undefined;
  /** @type {(field: string, value: unknown) => { topologyId?: string, seatId?: unknown, field: string, value: unknown }} */
  const at = (field, value) => ({ topologyId, seatId, field, value });

  if (!seat || typeof seat !== "object") {
    errors.push(new SeatError(`Seat must be an object, got ${typeof seat}`, at("seat", seat)));
    return { valid: false, errors, warnings };
  }

  // id
  if (!isNonEmptyString(seat.id)) {
    errors.push(new SeatError(`Seat id must be a non-empty string`, at("id", seat.id)));
  }

  // label
  if (!isNonEmptyString(seat.label)) {
    errors.push(new SeatError(`Seat "${seatId}" label must be a non-empty string`, at("label", seat.label)));
  }

  // cardinality: min/max integers, min>=0, max>=1, min<=max
  if (!isInteger(seat.min) || seat.min < 0) {
    errors.push(new SeatError(`Seat "${seatId}" min must be an integer >= 0, got ${seat.min}`, at("min", seat.min)));
  }
  if (!isInteger(seat.max) || seat.max < 1) {
    errors.push(new SeatError(`Seat "${seatId}" max must be an integer >= 1, got ${seat.max}`, at("max", seat.max)));
  }
  if (isInteger(seat.min) && isInteger(seat.max) && seat.min > seat.max) {
    errors.push(new SeatError(`Seat "${seatId}" min (${seat.min}) must be <= max (${seat.max})`, at("min", seat.min)));
  }

  // weight in [0,1]
  if (typeof seat.weight !== "number" || Number.isNaN(seat.weight) || seat.weight < 0 || seat.weight > 1) {
    errors.push(new SeatError(`Seat "${seatId}" weight must be a number in [0,1], got ${seat.weight}`, at("weight", seat.weight)));
  }

  // roleHint: null OR a known capability hint. (typeof-first is the type-level
  // spelling of the same verdict: a non-string was never in the string Set.)
  if (seat.roleHint !== null && seat.roleHint !== undefined) {
    if (typeof seat.roleHint !== "string" || !KNOWN_ROLE_HINTS.has(seat.roleHint)) {
      errors.push(new SeatError(
        `Seat "${seatId}" roleHint "${seat.roleHint}" is not a known capability hint. Known: ${[...KNOWN_ROLE_HINTS].sort().join(", ")}`,
        at("roleHint", seat.roleHint),
      ));
    }
  }

  // relationships: array of { type in vocab, target non-empty string, semantics non-empty string }
  if (seat.relationships !== undefined && seat.relationships !== null && !Array.isArray(seat.relationships)) {
    errors.push(new SeatError(`Seat "${seatId}" relationships must be an array`, at("relationships", seat.relationships)));
  } else {
    /** @type {unknown[]} */
    const rels = Array.isArray(seat.relationships) ? seat.relationships : [];
    const knownIds = toIdSet(opts.knownSeatIds);
    rels.forEach((relRaw, i) => {
      /** @type {(field: string, value: unknown) => { topologyId?: string, seatId?: unknown, field: string, value: unknown }} */
      const relAt = (field, value) => ({ topologyId, seatId, field: `relationships[${i}].${field}`, value });
      if (!relRaw || typeof relRaw !== "object") {
        errors.push(new SeatError(`Seat "${seatId}" relationship #${i} must be an object`, relAt("", relRaw)));
        return;
      }
      const rel = /** @type {RawRelationshipCandidate} */ (relRaw);
      if (typeof rel.type !== "string" || !KNOWN_RELATIONSHIP_TYPES.has(rel.type)) {
        errors.push(new SeatError(
          `Seat "${seatId}" relationship #${i} type "${rel.type}" is not a known relationship type. Known: ${[...KNOWN_RELATIONSHIP_TYPES].join(", ")}`,
          relAt("type", rel.type),
        ));
      }
      if (!isNonEmptyString(rel.target)) {
        errors.push(new SeatError(`Seat "${seatId}" relationship #${i} target must be a non-empty string`, relAt("target", rel.target)));
      }
      // semantics is FREE-FORM — non-empty string only, never an enum.
      if (!isNonEmptyString(rel.semantics)) {
        errors.push(new SeatError(`Seat "${seatId}" relationship #${i} semantics must be a non-empty string`, relAt("semantics", rel.semantics)));
      }
      // ADVISORY: dangling target (only when sibling ids are supplied). Self-
      // targeting is legitimate and common, so it is NOT flagged.
      if (knownIds && isNonEmptyString(rel.target) && !knownIds.has(rel.target)) {
        warnings.push(new SeatError(
          `Seat "${seatId}" relationship #${i} target "${rel.target}" does not match any sibling seat`,
          relAt("target", rel.target),
        ));
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─── SEAT FACTORY ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw seat to the canonical Seat shape (applying the SAME defaults
 * the registry literals already carry, in the SAME field order), validate it,
 * and THROW a SeatError on any hard error. The returned object is
 * shape-identical to today's literal — `JSON.stringify(createSeat(seat)) ===
 * JSON.stringify(seat)` for every existing seat.
 *
 * @param {RawSeatCandidate|null|undefined} raw — a seat object (literal, canvas-drawn, or live-mutated)
 * @param {{ topologyId?: string, knownSeatIds?: Set<string>|string[] }} [opts]
 * @returns {Seat}
 */
export function createSeat(raw, opts = {}) {
  const topologyId = opts.topologyId;
  if (!raw || typeof raw !== "object") {
    throw new SeatError(`Cannot create a seat from ${typeof raw}`, { topologyId, field: "seat", value: raw });
  }

  // Field order MUST match the registry literal: id, label, min, max, roleHint,
  // weight, relationships. Each relationship: type, target, semantics.
  // The relationships cast preserves the legacy contract byte-for-byte: a truthy
  // NON-array still crashes with the same TypeError (.map is not a function) —
  // a ternary here would silently accept garbage, a behavior change.
  const relsRaw = /** @type {unknown[]} */ (raw.relationships || []);
  const seat = {
    id: raw.id,
    label: raw.label || raw.id,
    min: raw.min ?? 1,
    max: raw.max ?? 1,
    roleHint: raw.roleHint ?? null,
    weight: raw.weight ?? 1.0,
    relationships: relsRaw.map((rRaw) => {
      const r = /** @type {RawRelationshipCandidate} */ (rRaw);
      return {
        type: r.type,
        target: r.target,
        semantics: r.semantics,
      };
    }),
  };

  const { valid, errors } = validateSeat(seat, { topologyId, knownSeatIds: opts.knownSeatIds });
  if (!valid) {
    const detail = errors.map((e) => e.message).join("; ");
    throw new SeatError(
      `Invalid seat${seat.id ? ` "${seat.id}"` : ""}${topologyId ? ` in topology "${topologyId}"` : ""}: ${detail}`,
      { topologyId, seatId: seat.id, field: errors[0]?.field, value: errors[0]?.value },
    );
  }
  // The validated border (DR-105): validateSeat just proved every SeatSpec
  // invariant (id/label strings, integer cardinality, weight range, vocabulary
  // membership, edge shape), so this assertion states a fact the compiler
  // cannot see through the report object — not an any-fold.
  return /** @type {Seat} */ (seat);
}

/**
 * Map createSeat over a topology's seats, passing the set of sibling ids as
 * knownSeatIds so the advisory referential-integrity pass can run. Same shape
 * in, same shape out for valid defs; a malformed literal throws.
 *
 * @param {unknown} seats
 * @param {{ topologyId?: string }} [opts]
 * @returns {Seat[]}
 */
export function normalizeSeats(seats, opts = {}) {
  const topologyId = opts.topologyId;
  if (!Array.isArray(seats)) {
    throw new SeatError(`Topology "${topologyId}" seats must be an array`, { topologyId, field: "seats", value: seats });
  }
  const list = /** @type {Array<RawSeatCandidate|null|undefined>} */ (seats);
  // Sibling-id harvest for the advisory referential pass. String-keyed by
  // construction (a non-string id can never match a string relationship target,
  // so the harvested set's verdicts are identical to the legacy truthy-filter).
  /** @type {Set<string>} */
  const knownSeatIds = new Set();
  for (const s of list) {
    if (s && typeof s === "object" && isNonEmptyString(s.id)) knownSeatIds.add(s.id);
  }
  return list.map((s) => createSeat(s, { topologyId, knownSeatIds }));
}

// ─── AGENT (runtime occupant; the batch-2 worker-threads seam) ───────────────────

/**
 * An UNVALIDATED agent candidate at this border (same semantics as
 * RawSeatCandidate: `unknown` fields are the truth before validation).
 * @typedef {{ modelId?: unknown, seatId?: unknown, roleHint?: unknown, weight?: unknown, mandate?: unknown }} RawAgentCandidate
 */

/**
 * Validate a runtime agent against its mandate floor (the never-loosened
 * invariant). Pure — never throws.
 *
 * @param {RawAgentCandidate|null|undefined} agent — { modelId, seatId, roleHint, weight, mandate }
 * @param {{ floorRevision?: number }} [opts]
 * @returns {{ valid: boolean, errors: SeatError[] }}
 */
export function validateAgent(agent, opts = {}) {
  const floorRevision = opts.floorRevision ?? 1;
  /** @type {SeatError[]} */
  const errors = [];
  const seatId = agent && typeof agent === "object" ? agent.seatId : undefined;
  /** @type {(field: string, value: unknown) => { seatId?: unknown, field: string, value: unknown }} */
  const at = (field, value) => ({ seatId, field, value });

  if (!agent || typeof agent !== "object") {
    errors.push(new SeatError(`Agent must be an object, got ${typeof agent}`, at("agent", agent)));
    return { valid: false, errors };
  }

  if (!isNonEmptyString(agent.modelId)) {
    errors.push(new SeatError(`Agent modelId must be a non-empty string`, at("modelId", agent.modelId)));
  }
  if (!isNonEmptyString(agent.seatId)) {
    errors.push(new SeatError(`Agent seatId must be a non-empty string`, at("seatId", agent.seatId)));
  }
  // typeof-first is the type-level spelling of the same verdict (a non-string
  // was never in the string Set) — mirrors validateSeat's roleHint check.
  if (agent.roleHint !== null && agent.roleHint !== undefined && (typeof agent.roleHint !== "string" || !KNOWN_ROLE_HINTS.has(agent.roleHint))) {
    errors.push(new SeatError(`Agent roleHint "${agent.roleHint}" is not a known capability hint`, at("roleHint", agent.roleHint)));
  }
  if (agent.weight !== undefined && (typeof agent.weight !== "number" || Number.isNaN(agent.weight) || agent.weight < 0 || agent.weight > 1)) {
    errors.push(new SeatError(`Agent weight must be a number in [0,1], got ${agent.weight}`, at("weight", agent.weight)));
  }

  // The never-loosened mandate invariant. (A truthy non-object mandate yielded
  // `undefined` through the legacy property access; the typeof spelling lands
  // in the same missing-intent error.)
  const mandate = agent.mandate;
  const intent = mandate && typeof mandate === "object"
    ? /** @type {{ intent?: unknown }} */ (mandate).intent
    : undefined;
  if (!intent || typeof intent !== "object") {
    errors.push(new SeatError(`Agent mandate.intent is missing`, at("mandate.intent", agent.mandate)));
  } else {
    const view = /** @type {{ raw?: unknown, revision?: unknown }} */ (intent);
    if (!isNonEmptyString(view.raw)) {
      errors.push(new SeatError(`Agent mandate.intent.raw must be a non-empty string`, at("mandate.intent.raw", view.raw)));
    }
    if (!isInteger(view.revision) || view.revision < floorRevision) {
      errors.push(new SeatError(
        `Agent mandate revision (${view.revision}) must be >= floor revision (${floorRevision}) — mandate inheritance is never loosened`,
        at("mandate.intent.revision", view.revision),
      ));
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Construct a validated runtime Agent. Carries the seat's roleHint/weight and
 * the inherited mandate, asserting the never-loosened floor. THROWS a SeatError
 * on violation.
 *
 * @param {RawAgentCandidate|null|undefined} raw — { modelId, seatId, roleHint?, weight?, mandate }
 * @param {{ floorRevision?: number }} [opts]
 * @returns {Agent}
 *
 * @typedef {object} Agent
 * @property {string} modelId
 * @property {string} seatId
 * @property {string|null} roleHint
 * @property {number} weight
 * @property {{ intent: { raw: string, revision: number } }} mandate — the
 *   structural minimum validateAgent proves; the real mandate object carries
 *   more (operator, brief, …) and rides through verbatim.
 */
export function createAgent(raw, opts = {}) {
  if (!raw || typeof raw !== "object") {
    throw new SeatError(`Cannot create an agent from ${typeof raw}`, { field: "agent", value: raw });
  }
  const agent = {
    modelId: raw.modelId,
    seatId: raw.seatId,
    roleHint: raw.roleHint ?? null,
    weight: raw.weight ?? 1.0,
    mandate: raw.mandate,
  };
  const { valid, errors } = validateAgent(agent, opts);
  if (!valid) {
    const detail = errors.map((e) => e.message).join("; ");
    throw new SeatError(
      `Invalid agent${agent.seatId ? ` for seat "${agent.seatId}"` : ""}: ${detail}`,
      { seatId: agent.seatId, field: errors[0]?.field, value: errors[0]?.value },
    );
  }
  // The validated border (DR-105), same as createSeat: validateAgent just
  // proved every Agent invariant, including the never-loosened mandate floor.
  return /** @type {Agent} */ (agent);
}

export default {
  SeatError,
  KNOWN_ROLE_HINTS,
  KNOWN_RELATIONSHIP_TYPES,
  getKnownRelationshipTypes,
  validateSeat,
  createSeat,
  normalizeSeats,
  createAgent,
  validateAgent,
};
