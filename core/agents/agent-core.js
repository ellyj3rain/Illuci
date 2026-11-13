/**
 * Illuci — Agent Core (the canonical identity-bearing record)
 *
 * Purpose
 * -------
 * The ONE identity surface for an agent. The smallest record that is true
 * across every assignment, every model, and every world an agent ever
 * appears in. Identity is thin and stable; everything else composes onto it
 * by reference (disposition · voice · world · memory) or is resolved AGAINST
 * it at dispatch (role · model).
 *
 * This module lands the schema + registry + validators ONLY. It is additive:
 * nothing in the substrate reads it yet, so it changes no behavior. The three
 * disposition presets resolve INTO this record in later, separately-gated
 * steps. See the ratified agent-model design:
 *   - §2.2  the core schema (implemented here)
 *   - §6    the decoupling invariants made structural (enforced here)
 *   - §7.5  migration sequencing — this is Step 1 ("land agent-core.js with
 *           zero behavior change; nothing reads it yet")
 *
 * The decoupling invariants, enforced by this validator (not by convention):
 *   - agent ≠ model  (§6.1): there is NO `model` field. Only `modelPrefs`, a
 *     preference over a resource pool, advisory and overridable at dispatch.
 *     The validator REJECTS a `model` key so an author cannot fuse one in.
 *   - identity ≠ role (§6.2): there is NO `role` / `archetype` / `seat` field.
 *     Role is a fluid assignment resolved against the agent at dispatch. The
 *     validator REJECTS these keys so the `role` + `disposition` fusion
 *     (the operator-named anti-pattern, §1.3) is structurally impossible here.
 *
 * Relationship to the existing `identity.js` / `agent-dir.js` (coherence note)
 * --------------------------------------------------------------------------
 * `identity.js` ("Identity Generation Protocol") is NOT this record. It is a
 * per-MODEL self-portrait card (ASCII portrait + self-assessment) keyed by
 * `modelId` and stored under `~/.illuci/agents/<modelId>/` via `agent-dir.js`.
 * Keying identity by `modelId` is itself an instance of the agent≡model fusion
 * the agent-model decouples (§1.4). Reconciling the two — whether the
 * self-portrait reattaches to the AGENT (its `id`) rather than the model, and
 * whether it becomes a voice/world artifact — is a downstream reconciliation,
 * deliberately NOT done in this Step-1 landing. This file does not read, write,
 * or modify `identity.js`; it stands alongside it as the correct, decoupled
 * identity, and the reconciliation is flagged for a later step / operator call.
 *
 * Provenance requirement
 * ----------------------
 * Every agent MUST carry a `provenance` block, matching the discipline
 * disposition presets already enforce. An agent without provenance is a
 * draft and should not be registered.
 *   provenance.codedBy:        who produced the record (human coder id or 'llm-assisted')
 *   provenance.codedOn:        ISO date
 *   provenance.referenceBasis: what the record derives from (cast slug,
 *                              anthropology bio, preset id, operator brief, …)
 *   provenance.notes:          free-form justification
 *
 * @module core/agents/agent-core
 */

import { isValidProfile } from "./disposition-dimensions.js";

/**
 * @typedef {Object} ModelPreference — a ranking over the model resource pool.
 *   Advisory; dispatch may override entirely (matrix, operator pick, availability).
 *   Absence = "any capable model" (the agent is fully functional with zero preference).
 * @property {string}  [primary]          preferred model id
 * @property {string}  [fallback]         fallback model id
 * @property {boolean} [lineageDiversity] prefer spreading across model lineages
 */

/**
 * @typedef {Object} WorldRef — lineage coordinates the world layer generates from.
 * @property {string} lineage        institution doc id (e.g. "the-polyhedral-combine")
 * @property {string} [faction]      faction doc id (e.g. "typescript-faction")
 * @property {string} [anchorBioRef] optional hand-authored canonical bio (the escape hatch);
 *                                    when set, the world layer returns it verbatim instead of generating
 */

/**
 * @typedef {Object} MemoryRef — handle into the per-agent, cross-session memory scope.
 * @property {string} scopeId handle keyed by agent id (NOT by role, NOT by model — memory follows identity)
 * @property {("persistent"|"session"|"ephemeral")} policy how long recall survives
 */

/**
 * @typedef {Object} Provenance
 * @property {string} codedBy
 * @property {string} codedOn          ISO date
 * @property {string} [referenceBasis]
 * @property {string} [notes]
 */

/**
 * @typedef {Object} Agent — the canonical core. The ONE identity-bearing record.
 *
 * @property {string} id   Immutable, opaque, never reused. The agent's true name
 *                         (e.g. "agt_lovelace"). NOT a role, NOT a model, NOT a
 *                         slug that encodes a role.
 * @property {string} name Human-facing display name. Renderable; mutable without
 *                         breaking references (references use id).
 *
 * @property {string}             [dispositionRef]    id of a disposition bundle (the reworked presets)
 * @property {object}             [dispositionInline] escape hatch: an inline DimensionalProfile for a
 *                                                     one-off agent. At most ONE of dispositionRef /
 *                                                     dispositionInline is the disposition source.
 *
 * @property {ModelPreference}    [modelPrefs] preference over the resource pool — NOT identity (§6.1)
 *
 * @property {string|null}        [voiceRef]   id of a voice bundle, or null (model's default register)
 * @property {WorldRef|null}      [worldRef]   lineage coordinates, or null (a bare functional agent)
 * @property {MemoryRef|null}     [memoryRef]  memory scope handle, or null (stateless)
 *
 * @property {Provenance}         provenance
 */

/**
 * Keys that MUST NOT appear on a core record. Their absence is the structural
 * enforcement of the decoupling invariants (§6). An author cannot fuse a role
 * or a model into identity because the validator refuses the record.
 */
export const FORBIDDEN_CORE_KEYS = Object.freeze([
  "model", "role", "archetype", "seat",
  // Privilege/gate keys: an agent's IDENTITY must never declare its own privilege.
  // Capability/permission is granted by the SEAT + the operator's gate (loop.js keys the gate
  // on the tool's gateLevel, never on disposition/identity) - so disposition != privilege is an
  // invariant. Refusing these keys keeps that separation un-bypassable by an author who might
  // try to smuggle a gate-bypass into a "spicy" disposition's core.
  "permission", "permissions", "gate", "gateLevel", "privilege", "allowedTools", "trust", "trustLevel",
]);

/** The subset of forbidden keys that would grant privilege through identity (disposition != privilege). */
const PRIVILEGE_CORE_KEYS = new Set([
  "permission", "permissions", "gate", "gateLevel", "privilege", "allowedTools", "trust", "trustLevel",
]);

const MEMORY_POLICIES = Object.freeze(["persistent", "session", "ephemeral"]);

/**
 * Validate an agent core record against the §2.2 schema and the §6 invariants.
 * Pure: does not register, does not mutate. Returns a report.
 *
 * @param {Agent} agent
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAgent(agent) {
  const errors = [];

  if (!agent || typeof agent !== "object") {
    return { valid: false, errors: ["agent must be an object"] };
  }

  // ── Decoupling invariants, enforced structurally (§6) ──
  for (const key of FORBIDDEN_CORE_KEYS) {
    if (key in agent) {
      errors.push(
        `forbidden key "${key}": the core is decoupled — ` +
        (key === "model"
          ? "model is a resource (use modelPrefs), never identity (§6.1)"
          : PRIVILEGE_CORE_KEYS.has(key)
          ? "privilege is granted by the seat + the operator's gate, never declared by identity (disposition != privilege)"
          : "role/archetype/seat is a fluid assignment resolved against the agent, never identity (§6.2)")
      );
    }
  }

  // ── Stable identity ──
  if (typeof agent.id !== "string" || agent.id.trim() === "") {
    errors.push("id is required and must be a non-empty string");
  }
  if (typeof agent.name !== "string" || agent.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  // ── Disposition: at most one source; inline must be a valid profile ──
  const hasRef = agent.dispositionRef !== undefined && agent.dispositionRef !== null;
  const hasInline = agent.dispositionInline !== undefined && agent.dispositionInline !== null;
  if (hasRef && hasInline) {
    errors.push("dispositionRef and dispositionInline are mutually exclusive — exactly one is the disposition source (§2.2)");
  }
  if (hasRef && typeof agent.dispositionRef !== "string") {
    errors.push("dispositionRef must be a string (a disposition-bundle id)");
  }
  if (hasInline && !isValidProfile(agent.dispositionInline)) {
    errors.push("dispositionInline must be a valid DimensionalProfile (see disposition-dimensions.js)");
  }

  // ── Model PREFERENCES (the only model-related field allowed) ──
  if (agent.modelPrefs !== undefined && agent.modelPrefs !== null) {
    const mp = agent.modelPrefs;
    if (typeof mp !== "object") {
      errors.push("modelPrefs must be an object { primary?, fallback?, lineageDiversity? }");
    } else {
      if (mp.primary !== undefined && typeof mp.primary !== "string") errors.push("modelPrefs.primary must be a string");
      if (mp.fallback !== undefined && typeof mp.fallback !== "string") errors.push("modelPrefs.fallback must be a string");
      if (mp.lineageDiversity !== undefined && typeof mp.lineageDiversity !== "boolean") errors.push("modelPrefs.lineageDiversity must be a boolean");
    }
  }

  // ── Layer attachment points (by reference) ──
  if (agent.voiceRef !== undefined && agent.voiceRef !== null && typeof agent.voiceRef !== "string") {
    errors.push("voiceRef must be a string (a voice-bundle id) or null");
  }

  if (agent.worldRef !== undefined && agent.worldRef !== null) {
    const w = agent.worldRef;
    if (typeof w !== "object") {
      errors.push("worldRef must be an object { lineage?, faction?, anchorBioRef? } or null");
    } else {
      const hasLineage = typeof w.lineage === "string" && w.lineage.trim() !== "";
      const hasAnchor = typeof w.anchorBioRef === "string" && w.anchorBioRef.trim() !== "";
      // A world is valid with EITHER generative coordinates (lineage) OR a
      // hand-authored bio (anchorBioRef). An anchored agent need not have an
      // institution; a generated agent need not have an authored bio.
      if (!hasLineage && !hasAnchor) {
        errors.push("worldRef requires at least one of lineage (generative coordinates) or anchorBioRef (a hand-authored bio)");
      }
      if (w.lineage !== undefined && typeof w.lineage !== "string") errors.push("worldRef.lineage must be a string");
      if (w.faction !== undefined && typeof w.faction !== "string") errors.push("worldRef.faction must be a string");
      if (w.anchorBioRef !== undefined && typeof w.anchorBioRef !== "string") errors.push("worldRef.anchorBioRef must be a string");
    }
  }

  if (agent.memoryRef !== undefined && agent.memoryRef !== null) {
    const m = agent.memoryRef;
    if (typeof m !== "object") {
      errors.push("memoryRef must be an object { scopeId, policy } or null");
    } else {
      if (typeof m.scopeId !== "string" || m.scopeId.trim() === "") errors.push("memoryRef.scopeId is required when memoryRef is set");
      if (!MEMORY_POLICIES.includes(m.policy)) errors.push(`memoryRef.policy must be one of ${MEMORY_POLICIES.join(" | ")}`);
    }
  }

  // ── Provenance (matching the presets' discipline) ──
  if (!agent.provenance || typeof agent.provenance !== "object") {
    errors.push("provenance block is required (codedBy + codedOn)");
  } else {
    if (typeof agent.provenance.codedBy !== "string" || agent.provenance.codedBy.trim() === "") errors.push("provenance.codedBy is required");
    if (typeof agent.provenance.codedOn !== "string" || agent.provenance.codedOn.trim() === "") errors.push("provenance.codedOn is required (ISO date)");
  }

  return { valid: errors.length === 0, errors };
}

/** Convenience boolean form, mirroring isValidProfile. */
export function isValidAgent(agent) {
  return validateAgent(agent).valid;
}

/**
 * Validate and freeze an agent record (id immutability). Throws on invalid.
 * Does NOT register — call registerAgent to add to the registry.
 *
 * @param {Agent} spec
 * @returns {Readonly<Agent>}
 */
export function defineAgent(spec) {
  const { valid, errors } = validateAgent(spec);
  if (!valid) {
    throw new Error(`Invalid agent "${spec && spec.id ? spec.id : "<no id>"}":\n  - ${errors.join("\n  - ")}`);
  }
  return Object.freeze({ ...spec });
}

// ─── REGISTRY ───
// Module-private. Empty at landing: agents are populated in later migration
// steps when the three rosters decompose into core records (§7.1–§7.3).

/** @type {Map<string, Readonly<Agent>>} */
const AGENTS = new Map();

/**
 * Register an agent core record. Validates, freezes, enforces id uniqueness
 * (ids are "never reused" — §2.2). Returns the frozen record.
 *
 * @param {Agent} spec
 * @returns {Readonly<Agent>}
 */
export function registerAgent(spec) {
  const agent = defineAgent(spec);
  if (AGENTS.has(agent.id)) {
    throw new Error(`Agent id "${agent.id}" already registered — ids are immutable and never reused`);
  }
  AGENTS.set(agent.id, agent);
  return agent;
}

/** Get a registered agent by id, or null. */
export function getAgent(id) {
  return AGENTS.get(id) || null;
}

/** True if an agent id is registered. */
export function hasAgent(id) {
  return AGENTS.has(id);
}

/** List all registered agent records. */
export function listAgents() {
  return [...AGENTS.values()];
}

/** Clear the registry (test/dev support). */
export function clearAgents() {
  AGENTS.clear();
}

/**
 * Validate every registered agent. Mirrors `validateAllPresets`.
 * @returns {{ ok: boolean, count: number, invalid: Array<{id: string, errors: string[]}> }}
 */
export function validateAllAgents() {
  const invalid = [];
  for (const agent of AGENTS.values()) {
    const { valid, errors } = validateAgent(agent);
    if (!valid) invalid.push({ id: agent.id, errors });
  }
  return { ok: invalid.length === 0, count: AGENTS.size, invalid };
}

export default {
  FORBIDDEN_CORE_KEYS,
  validateAgent,
  isValidAgent,
  defineAgent,
  registerAgent,
  getAgent,
  hasAgent,
  listAgents,
  clearAgents,
  validateAllAgents,
};
