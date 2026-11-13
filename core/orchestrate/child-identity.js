// core/orchestrate/child-identity.js
//
// [A91]/DR-184 + [A92]/DR-185 (DR-182 Phases 2-3): the childIdentity seam
// policy — ONE module owns the vocabulary, the arm-time validation, the
// carry fragment every child seam spreads, and the derived-slug scheme. The
// control rides the genome envelope (dispatchOpts.genome.childIdentity); the
// operator ratified ALL FOUR constructions as states of it ("All are optimal
// as options.", DR-182 D1), default `none` (D1a) — arming the parent's
// learning never silently extends it to children.
//
//   none     — children stay anonymous hands (the byte-identity law).
//   inherit  — the parent's raw agents manifest + the full genome control
//              thread through the seam; the child's lineup binds the SAME
//              durable agents to its own seats, and grandchildren inherit
//              under the same policy (the control travels with the genome).
//   derive   — [A92] the child run mints a DERIVED persona per seated agent:
//              `<parentAgentId>-<childSeatId>` (deriveChildSlug below), its
//              genome born from the parent persona's live compensated
//              profile with genealogy recorded at genesis. The manifest +
//              control thread like inherit; the DERIVATION happens at the
//              child's composition gate (disposition-resolver).
//   explicit — [A92] the spawn args carry their own manifest + genome arm;
//              only the control itself threads (grandchildren policy), so a
//              child without explicit args seats no identity at all.

export const CHILD_IDENTITY_STATES = Object.freeze(["none", "inherit", "derive", "explicit"]);

/**
 * Validate + normalize the childIdentity state on a genome control. Absent =
 * `none` (the D1a default). An unknown value is a LOUD error at arm time.
 *
 * @param {object|null} genome  the dispatchOpts.genome control (or null)
 * @returns {"none"|"inherit"|"derive"|"explicit"} the normalized state
 */
export function normalizeChildIdentity(genome) {
  const raw = genome?.childIdentity;
  if (raw === undefined || raw === null) return "none";
  const value = String(raw);
  if (!CHILD_IDENTITY_STATES.includes(value)) {
    throw new Error(`childIdentity "${value}" is not a state (none|inherit|derive|explicit — DR-182 D1)`);
  }
  return value;
}

/**
 * The option fragment a child seam spreads into childOptions.
 *   none     → {} (the byte-identity law).
 *   inherit  → the raw agents manifest + a copy of the genome control.
 *   derive   → same carry as inherit — the child's composition gate performs
 *              the per-seat derivation (the state rides the copied control).
 *   explicit → a copy of the genome control ONLY: the child's identities come
 *              from its own spawn args (or nowhere), never from the parent.
 *
 * @param {object} args
 * @param {object|null} [args.genome]         the parent's armed genome control
 * @param {object|null} [args.agentManifest]  the parent's RAW agents manifest
 * @returns {object} the childOptions fragment
 */
export function carryChildIdentity({ genome = null, agentManifest = null } = {}) {
  const state = normalizeChildIdentity(genome);
  if (state === "none") return {};
  if (state === "explicit") return { genome: { ...genome } };
  // inherit | derive — the manifest travels; derive's split happens downstream.
  return {
    ...(agentManifest ? { agents: agentManifest } : {}),
    genome: { ...genome },
  };
}

/**
 * [A92]/DR-185 (DR-182 D6): the derived-slug scheme — `<parentAgentId>-
 * <childSeatId>`, lowercased (sanitizeSlug case-folds anyway; folding here
 * keeps the mint deterministic and legible). The 64-char cap is a LOUD error,
 * never a truncation — a truncated slug could collide two lineages. The
 * optional topologyId lengthens the mint (`<parent>-<topo>-<seat>`) — the
 * ratified collision hook; no automatic collision DETECTION exists yet, so
 * v1 callers do not pass it (recorded in DR-185, not silently dropped).
 *
 * @param {string} parentAgentId  the durable agent the derivation forks from
 * @param {string} childSeatId    the child topology's seat id
 * @param {{topologyId?: string|null}} [opts]
 * @returns {string} the derived slug (sanitizeSlug-lawful charset expected upstream)
 */
export function deriveChildSlug(parentAgentId, childSeatId, { topologyId = null } = {}) {
  if (!parentAgentId || typeof parentAgentId !== "string") {
    throw new Error("deriveChildSlug: parentAgentId (string) is required");
  }
  if (!childSeatId || typeof childSeatId !== "string") {
    throw new Error("deriveChildSlug: childSeatId (string) is required");
  }
  const parts = topologyId ? [parentAgentId, topologyId, childSeatId] : [parentAgentId, childSeatId];
  const slug = parts.join("-").toLowerCase();
  if (slug.length > 64) {
    throw new Error(
      `deriveChildSlug: derived slug "${slug}" exceeds 64 chars — shorten the agentId or seatId (DR-182 D6: loud, never truncated)`,
    );
  }
  return slug;
}

export default { CHILD_IDENTITY_STATES, normalizeChildIdentity, carryChildIdentity, deriveChildSlug };
