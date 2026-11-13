/**
 * illuci — Topology contract types (the canonical typed spine)
 *
 * These are the AUTHORITATIVE shapes of illuci's topology governance contracts,
 * promoted from the JSDoc @typedefs and POJO literals that already define them:
 *   - RelationshipType    <- core/topologies/relationship-types.js RELATIONSHIP_TYPES
 *   - SeatSpec            <- core/topologies/seat-type.js @typedef Seat (byte-identity contract)
 *   - PhaseSpec           <- core/topologies/index.js phase literals
 *   - TopologySpec        <- core/topologies/index.js TOPOLOGIES
 *   - RuntimeTopologySpec <- core/topologies/runtime-topologies.js createRuntimeTopology
 *
 * They are ADDITIVE and DESCRIPTIVE: a valid existing topology already satisfies
 * them. Future contract work EXTENDS these types rather than inventing a parallel
 * shape (see CONTRACTS.md). This is a .d.ts — pure types, ZERO runtime footprint.
 * JS modules reference these via JSDoc `import("./topology.d.ts")` types; the
 * runtime border validator (runtime-topology-schema.js) is checked to PRODUCE a
 * RuntimeTopologySpec.
 */

/**
 * The typed relationship-edge vocabulary the runner dispatches on. Keep in lockstep
 * with core/topologies/relationship-types.js RELATIONSHIP_TYPES (that array is the
 * single runtime source of truth; this union is its type-level mirror).
 */
export type RelationshipType =
  | "parent-of"
  | "child-of"
  | "adversarial-to"
  | "precedes"
  | "integrates-from"
  | "peer-of"
  | "faction-of"
  | "mentors";

/**
 * A typed edge from a seat to a target seat. `semantics` is FREE-FORM — a non-empty
 * label (~80 distinct across the registry), deliberately NOT an enum.
 */
export interface SeatRelationship {
  type: RelationshipType;
  target: string;
  semantics: string;
}

/**
 * A named position in a topology. Byte-identical to core/topologies/seat-type.js's
 * `@typedef Seat` — field order and defaults are SACRED: createSeat guarantees
 * `JSON.stringify(createSeat(seat)) === JSON.stringify(seat)` for every valid seat.
 */
export interface SeatSpec {
  id: string;
  label: string;
  /** integer >= 0 */
  min: number;
  /** integer >= 1, and >= min */
  max: number;
  /** a known capability role hint, or null (auto-fill falls back to "analyst") */
  roleHint: string | null;
  /** priority in [0,1]; drives lazy activation + context scaling */
  weight: number;
  relationships: SeatRelationship[];
}

/** How a phase fans out over its seat(s). */
export type PhaseType = "single" | "parallel" | "sequential" | "rotating";

/** The governed capability posture a phase runs its seat(s) under. */
export type PhaseMode = "respond" | "write" | "read" | "execute";

/**
 * One ordered execution step. A "single" phase targets one `seat`; the other types
 * fan out over `seats` — exactly one of the two is present. `input` is a phase-
 * reference expression ("prompt", "phase:<id>", "phase:a+phase:b", "previous",
 * "shared-artifact"). The remaining fields are optional per-phase flags used by
 * specific topologies.
 */
export interface PhaseSpec {
  id: string;
  type: PhaseType;
  /** present on "single" phases */
  seat?: string;
  /** present on parallel/sequential/rotating phases */
  seats?: string[];
  input: string;
  mode?: PhaseMode;
  raw?: boolean;
  gate?: boolean;
  blind?: boolean;
  chain?: boolean;
  distribute?: boolean;
  pairwise?: boolean;
  dynamic?: boolean;
  stripAttribution?: boolean;
  /** a fixed round count, or an inclusive [min, max] range */
  rounds?: number | [number, number];
  /** explicit per-branch assignment labels (e.g. best-case / worst-case) */
  assignments?: string[];
  description?: string;
}

/** Provenance stamp on a registry topology. */
export interface TopologyOrigin {
  proposedBy: "human" | "model";
  models?: string[];
  timestamp: string;
  context: string;
}

/** Topology-specific vocabulary for seat elimination. */
export interface RemovalSemantics {
  term: string;
  evidence: string;
}

/**
 * A frozen registry topology (core/topologies/index.js TOPOLOGIES). Defines the
 * RELATIONSHIPS between positions, not which models fill them — the operator fills
 * every seat.
 */
export interface TopologySpec {
  id: string;
  name: string;
  description: string;
  origin: TopologyOrigin;
  relationshipTypes: RelationshipType[];
  /** per-topology feedback-loop guardrail in [0,1], or null */
  stabilityThreshold: number | null;
  removalSemantics: RemovalSemantics | null;
  /** true only for sandbox-restricted adversarial-simulation topologies */
  sandboxOnly?: boolean;
  seats: SeatSpec[];
  phases: PhaseSpec[];
}

/**
 * A runtime (overlay) topology authored past the frozen registry — the writable
 * trust border (core/topologies/runtime-topologies.js). It carries the same core
 * shape a frozen topology does, requires at least one seat and one phase, and is
 * stamped `runtime: true`. Additive-only: a runtime id may not shadow source canon.
 */
export interface RuntimeTopologySpec {
  id: string;
  name: string;
  description: string;
  seats: SeatSpec[];
  phases: PhaseSpec[];
  runtime: true;
}

/** The minimal authored input a caller supplies to create a runtime topology. */
export interface RuntimeTopologyInput {
  name?: string;
  description?: string;
  seats: SeatSpec[];
  phases: PhaseSpec[];
}

/**
 * [A24.1] The resolved adaptive disposition carried on a governance manifest —
 * the TAOR policy the run would resolve for this topology absent per-run
 * overrides (core/topologies/adaptive-route.js resolveAdaptivePolicy).
 */
export interface ManifestAdaptiveDisposition {
  enabled: boolean;
  maxLoopsPerPhase: number;
  maxTotalReroutes: number;
}

/** The structural invariants a governance consumer (classifier, auditor) reads. */
export interface ManifestInvariants {
  /** true only for sandbox-restricted adversarial-simulation topologies */
  sandboxOnly: boolean;
  /** per-topology feedback-loop guardrail in [0,1], or null */
  stabilityThreshold: number | null;
  adaptive: ManifestAdaptiveDisposition;
  relationshipTypes: RelationshipType[];
}

/**
 * [A24.1] The governance-manifest facet of a topology — DERIVED, never authored.
 * The factory's classifiers (PR-shape v1, the Belt Inspectorate) and the TAOR
 * planners read a topology through this facet instead of re-deriving structure.
 *
 * Covers BOTH sources as first-class (ratified D1): the frozen registry
 * standard library AND runtime (ad-hoc governed) topologies — a runtime
 * composition is a peer, not a lesser citizen. There is deliberately NO
 * exemption/bypass field, and the border schema is strict: exemption is a
 * property a classifier DEDUCES from structure, never a flag a topology
 * declares (the [A27] plan's security ruling).
 */
export interface TopologyGovernanceManifest {
  schema: "illuci.topology.governance-manifest/1";
  id: string;
  name: string;
  source: "registry" | "runtime";
  /** the seat that plans first (the A17.6 anchor rule), or null when derivable from no phase/seat */
  anchorSeat: string | null;
  seatIds: string[];
  phaseIds: string[];
  /** phases carrying a content gate — where TAOR routing decides */
  gatedPhaseIds: string[];
  invariants: ManifestInvariants;
}
