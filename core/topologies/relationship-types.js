/**
 * illuci — Relationship edge vocabulary (single source of truth)
 *
 * The set of typed edges the runner has a dispatch handler for. Extracted to a
 * dependency-free LEAF module (Phase F harden, batch 1) so both index.js (the
 * topology registry, which re-exports this as RELATIONSHIP_TYPES for back-compat)
 * and seat-type.js (the validator's derived vocabulary) can import it WITHOUT a
 * circular dependency. index.js imports seat-type.js (for normalizeSeats), so
 * seat-type.js must not import index.js back — it imports this leaf instead.
 *
 * Edge semantics tags, seat weight, and stability thresholds: Grok contribution
 * (2026-04-05). This list is the authoritative vocabulary; adding an edge type
 * here makes it valid everywhere the validator runs.
 */

/**
 * Valid relationship types — the runner has a dispatch handler per type.
 * @type {string[]}
 */
export const RELATIONSHIP_TYPES = [
  "parent-of",       // hierarchy: mob, corporate, incident-command
  "child-of",        // inverse of parent-of
  "adversarial-to",  // debate, judiciary, red-team
  "precedes",        // ordered handoff: dev-team, funnel, release gates
  "integrates-from", // hub-spoke: research swarm, synthesis
  "peer-of",         // flat/equal: commune, co-operative, war-room
  "faction-of",      // group membership: legislature
  "mentors",         // teaching: apprentice-master, classroom
];

export default { RELATIONSHIP_TYPES };
