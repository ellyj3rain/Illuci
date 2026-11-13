// @ts-check
/**
 * illuci — Topology governance manifest ([A24.1], the factory's slice 1)
 *
 * The governance-manifest facet of a topology: the structural read a factory
 * consumer (the PR-shape classifier, the Belt Inspectorate, a TAOR planner)
 * takes of ANY topology without re-deriving structure. DERIVED, never authored
 * — there is no manifest store and no manifest author surface; the underlying
 * TopologySpec / RuntimeTopologySpec stays the single source of truth and this
 * module projects it (extend-never-fork, CONTRACTS.md).
 *
 * Ratified D1 rides in the type: BOTH sources are first-class — the frozen
 * registry standard library ("registry") and runtime ad-hoc governed
 * compositions ("runtime"). A runtime topology is a peer, not a lesser citizen.
 *
 * The [A27] security ruling rides in the border: the schema is STRICT — a
 * manifest carrying any undeclared field (an `isExempt`-class bypass flag) is
 * rejected, because exemption is a property a classifier DEDUCES from
 * structure, never a flag a topology declares.
 *
 * @module core/topologies/manifest
 */

import { z } from "zod";
import { TOPOLOGIES } from "./index.js";
import { getRuntimeTopology } from "./runtime-topologies.js";
import { anchorSeatCandidates } from "./anchor.js";
import { resolveAdaptivePolicy } from "./adaptive-route.js";

/** @typedef {import("../contracts/topology.d.ts").TopologyGovernanceManifest} TopologyGovernanceManifest */

export const MANIFEST_SCHEMA_ID = "illuci.topology.governance-manifest/1";

/**
 * The strict border schema. `.strict()` everywhere is the no-bypass guarantee:
 * unknown keys (exemption flags, ad-hoc annotations) REJECT rather than ride.
 */
export const TopologyGovernanceManifestSchema = z
  .object({
    schema: z.literal(MANIFEST_SCHEMA_ID),
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.enum(["registry", "runtime"]),
    anchorSeat: z.string().min(1).nullable(),
    seatIds: z.array(z.string().min(1)),
    phaseIds: z.array(z.string().min(1)),
    gatedPhaseIds: z.array(z.string().min(1)),
    invariants: z
      .object({
        sandboxOnly: z.boolean(),
        stabilityThreshold: z.number().min(0).max(1).nullable(),
        adaptive: z
          .object({
            enabled: z.boolean(),
            maxLoopsPerPhase: z.number().int().min(0),
            maxTotalReroutes: z.number().int().min(0),
          })
          .strict(),
        relationshipTypes: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

/**
 * Derive the governance manifest from a topology spec (registry or runtime).
 * Pure and total over valid specs; throws loudly on a non-object so a broken
 * caller cannot ride a null through the governance read path.
 *
 * @param {any} spec - a TopologySpec or RuntimeTopologySpec
 * @returns {TopologyGovernanceManifest}
 */
export function deriveTopologyManifest(spec) {
  if (!spec || typeof spec !== "object" || typeof spec.id !== "string" || spec.id.length === 0) {
    throw new Error("deriveTopologyManifest: spec must be a topology object with a non-empty id");
  }
  const phases = /** @type {any[]} */ (Array.isArray(spec.phases) ? spec.phases : []);
  const seats = /** @type {any[]} */ (Array.isArray(spec.seats) ? spec.seats : []);
  const candidates = anchorSeatCandidates(spec);
  const relationshipTypes = Array.isArray(spec.relationshipTypes)
    ? spec.relationshipTypes
    : [...new Set(seats.flatMap((s) => (Array.isArray(s?.relationships) ? s.relationships.map((/** @type {any} */ r) => r?.type) : [])).filter(Boolean))];
  return {
    schema: MANIFEST_SCHEMA_ID,
    id: spec.id,
    name: typeof spec.name === "string" && spec.name ? spec.name : spec.id,
    source: spec.runtime === true ? "runtime" : "registry",
    anchorSeat: candidates[0] ?? null,
    seatIds: seats.map((s) => s?.id).filter((/** @type {any} */ id) => typeof id === "string" && id.length > 0),
    phaseIds: phases.map((p) => p?.id).filter((/** @type {any} */ id) => typeof id === "string" && id.length > 0),
    gatedPhaseIds: phases.filter((p) => p?.gate === true).map((p) => p.id),
    invariants: {
      sandboxOnly: spec.sandboxOnly === true,
      stabilityThreshold: typeof spec.stabilityThreshold === "number" ? spec.stabilityThreshold : null,
      adaptive: resolveAdaptivePolicy(spec, {}),
      relationshipTypes,
    },
  };
}

/**
 * Validate a manifest at the consumer border. Mirrors validateRuntimeTopology's
 * contract shape: never throws.
 *
 * @param {unknown} manifest
 * @returns {{ ok: true, value: TopologyGovernanceManifest } | { ok: false, errors: string[] }}
 */
export function validateTopologyManifest(manifest) {
  const parsed = TopologyGovernanceManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path?.length ? `${i.path.map(String).join(".")}: ` : ""}${i.message}`),
    };
  }
  return { ok: true, value: /** @type {TopologyGovernanceManifest} */ (parsed.data) };
}

/**
 * Resolve a topology id (registry first, then the runtime overlay — the same
 * precedence the runner uses) and derive its governance manifest.
 *
 * @param {string} id
 * @returns {TopologyGovernanceManifest|null} null when the id resolves to no topology
 */
export function getTopologyGovernanceManifest(id) {
  const spec = /** @type {Record<string, any>} */ (TOPOLOGIES)[id] || getRuntimeTopology(id);
  if (!spec) return null;
  return deriveTopologyManifest(spec);
}

export default {
  MANIFEST_SCHEMA_ID,
  TopologyGovernanceManifestSchema,
  deriveTopologyManifest,
  validateTopologyManifest,
  getTopologyGovernanceManifest,
};
