// @ts-check
/**
 * illuci — Runtime-topology border schema (Zod, the trust-boundary validator)
 *
 * runtime-topologies.js is the WRITABLE trust border: a runtime topology is authored
 * data (from ~/.illuci/topologies/runtime-topologies.json, or from an MCP topology_create
 * call) that then runs the SAME governed path a frozen registry topology does. This
 * module is the schema that guards that border — the "Zod at borders" half of the
 * typed-contracts doctrine (CONTRACTS.md).
 *
 * NON-DIVERGENT BY CONSTRUCTION. The seat interior stays owned by the existing
 * authority: this schema DELEGATES each seat to core/topologies/seat-type.js
 * `createSeat` (normalize-then-validate) rather than re-encoding cardinality / weight /
 * relationship-vocab rules in Zod. Because createSeat applies the runner's defaults
 * before validating, the border is a strict SUPERSET-acceptor of the create path (an
 * under-specified but defaultable seat is accepted; a genuinely-invalid one is rejected).
 * The border envelope (id / name / description / >=1 seat / >=1 phase / additive-only id)
 * mirrors createRuntimeTopology's own invariants. Phases have no pre-existing validator
 * (the runner consumes them implicitly), so the phase SHAPE check is net-new here.
 *
 * LIVE at the border ([A31]). validateRuntimeTopology is wired into createRuntimeTopology
 * (so both the MCP topology_create path and the graph-preset materialize path are guarded)
 * and is called explicitly by the MCP topology_create handler to surface actionable errors.
 *
 * @module core/contracts/runtime-topology-schema
 */

import { z } from "zod";
import { createSeat } from "../topologies/seat-type.js";

/** @typedef {import("./topology.d.ts").RuntimeTopologySpec} RuntimeTopologySpec */

const PHASE_TYPES = new Set(["single", "parallel", "sequential", "rotating"]);
const PHASE_MODES = new Set(["respond", "write", "read", "execute"]);

/**
 * Border-shape check for a phase. Phases have no pre-existing validator, so the
 * border owns this: id, type vocabulary, input expression, exactly-one-of
 * seat/seats (single vs fan-out), and mode vocabulary when present.
 * @param {any} phase
 * @returns {string[]} error messages (empty = valid)
 */
export function phaseShapeErrors(phase) {
  if (!phase || typeof phase !== "object") return ["phase must be an object"];
  const errors = [];
  const id = typeof phase.id === "string" && phase.id.length > 0 ? phase.id : null;
  const label = id ?? "?";
  if (!id) errors.push("phase id must be a non-empty string");
  if (!PHASE_TYPES.has(phase.type)) {
    errors.push(`phase "${label}" type ${JSON.stringify(phase.type)} must be one of ${[...PHASE_TYPES].join(", ")}`);
  }
  if (typeof phase.input !== "string" || phase.input.length === 0) {
    errors.push(`phase "${label}" input must be a non-empty phase-reference string`);
  }
  const hasSeat = typeof phase.seat === "string";
  const hasSeats = Array.isArray(phase.seats);
  if (hasSeat === hasSeats) {
    errors.push(`phase "${label}" must have exactly one of seat (single) or seats (fan-out)`);
  }
  if (phase.mode !== undefined && !PHASE_MODES.has(phase.mode)) {
    errors.push(`phase "${label}" mode ${JSON.stringify(phase.mode)} must be one of ${[...PHASE_MODES].join(", ")}`);
  }
  return errors;
}

// A seat is normalized-then-validated by the single source of truth (seat-type.js).
// createSeat applies the SAME defaults the runner applies (label||id, min/max ?? 1,
// weight ?? 1.0, roleHint ?? null, relationships || []) and THEN validates — so an
// under-specified but defaultable seat (which the shallow createRuntimeTopology path
// stores raw and the runner normalizes at run time) is ACCEPTED, while a genuinely-
// invalid one (bad weight / relationship / roleHint / cardinality) is REJECTED. This
// keeps the border a strict SUPERSET-acceptor of the current create path. `seat` is
// untrusted (any); createSeat is garbage-tolerant and throws a field-anchored SeatError.
const SeatSchema = z.unknown().superRefine((seat, ctx) => {
  try {
    createSeat(/** @type {any} */ (seat));
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid seat";
    const field = err && typeof err === "object" && "field" in err ? /** @type {any} */ (err).field : null;
    ctx.addIssue({ code: "custom", message, path: field ? [String(field)] : [] });
  }
});

const PhaseSchema = z.unknown().superRefine((phase, ctx) => {
  for (const message of phaseShapeErrors(phase)) {
    ctx.addIssue({ code: "custom", message });
  }
});

/**
 * The runtime-topology border schema. The envelope mirrors createRuntimeTopology's
 * invariants (non-empty id, >=1 seat, >=1 phase); seats/phases carry the delegated
 * interior checks above.
 */
export const RuntimeTopologySchema = z.object({
  id: z.string().min(1, "runtime topology id must be a non-empty string"),
  name: z.string().optional(),
  description: z.string().optional(),
  seats: z.array(SeatSchema).min(1, "a runtime topology requires at least one seat"),
  phases: z.array(PhaseSchema).min(1, "a runtime topology requires at least one phase"),
  runtime: z.literal(true).optional(),
});

/**
 * @param {{ path?: Array<string | number | symbol>, message: string }} issue
 * @returns {string}
 */
function formatIssue(issue) {
  const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return `${path}${issue.message}`;
}

/**
 * Validate an authored runtime topology at the trust border. On success, returns the
 * value NORMALIZED to the stored RuntimeTopologySpec shape (the same defaults
 * createRuntimeTopology applies: name||id, description||"", runtime:true). Additive-
 * only: a reserved (source-canon) id is rejected. Never throws.
 *
 * @param {unknown} spec
 * @param {{ reservedIds?: string[] }} [options]
 * @returns {{ ok: true, value: RuntimeTopologySpec } | { ok: false, errors: string[] }}
 */
export function validateRuntimeTopology(spec, options = {}) {
  const parsed = RuntimeTopologySchema.safeParse(spec);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(formatIssue) };
  }
  const value = parsed.data;
  const id = String(value.id).trim();
  if (id === "") {
    return { ok: false, errors: ["runtime topology id must be a non-empty string"] };
  }
  const reserved = new Set(Array.isArray(options.reservedIds) ? options.reservedIds : []);
  if (reserved.has(id)) {
    return {
      ok: false,
      errors: [`runtime topology id "${id}" shadows a reserved source-canon id; runtime ids are additive-only`],
    };
  }
  const normalized = /** @type {RuntimeTopologySpec} */ ({
    id,
    name: typeof value.name === "string" ? value.name : id,
    description: typeof value.description === "string" ? value.description : "",
    seats: /** @type {any} */ (value.seats),
    phases: /** @type {any} */ (value.phases),
    runtime: true,
  });
  return { ok: true, value: normalized };
}

export default { RuntimeTopologySchema, validateRuntimeTopology, phaseShapeErrors };
