// illuci/core/governance/belt/warehouse-belt.js
//
// [A24.5] Stations S0–S7 as runtime tenants + the WAREHOUSE_BELT composition —
// the factory's slice 5 and its capstone (DR-115, [A27] D1/D2/D3). This is the
// pre-GitOps R&D warehouse beneath the CWP: a conveyor of eight governed
// stations that a work artifact traverses in order, admitted between stations
// ONLY through the slice-4 per-transition entry/exit gate.
//
// It composes the four prior slices — it re-implements none of them:
//   - slice 1 (manifest):   every station's governing topology derives a
//                           border-valid governance manifest, so a station is a
//                           real governed structure, never a bare label.
//   - slice 2 (pr-shape):   a transition's TIER is the consequence doctrine —
//                           internal hops are belt-gated only; the promotion
//                           airlock is Tier-3.
//   - slice 3 (stopgap):    the Tier-3 airlock consumes a RELEASED stopgap
//                           record (two auditors → J3rain → operator 2FA); it
//                           does not reimplement the chain.
//   - slice 4 (gate):       the sole mover between stations is evaluateExitGate
//                           (sign into [W(N)]) → evaluateEntryGate (fail-closed
//                           verify at S(N+1)). The belt holds no key material.
//
// THE STRUCTURAL GUARANTEE — "structurally unable to provision ungated":
//   1. A belt cannot be CONSTRUCTED with an ungated edge. buildWarehouseBelt
//      rejects a non-contiguous station chain, a duplicate/invalid [Wn] ledger,
//      or a station whose governing topology does not derive a border-valid
//      manifest. There is no station without a preceding gate except the head.
//   2. A payload cannot be ADVANCED except through advanceStation, whose only
//      code path calls both gates. No ungated mover is exported; the belt is
//      deliberately NOT wired into the plain (ungated) pipeline runner.
//   3. Every entry is fail-closed on arming, signature, ledger lineage, TAOR
//      invariants, and — at Tier-3 — a released stopgap. Absence of any is a
//      loud REJECTED, never a silent pass.
//
// The dry-run harness (createDryRunTenantIdentities / dryRunBelt) is the
// slice-5 verification surface: it provisions per-tenant HMAC identities so a
// real signature round-trips end to end (S0→S7), proving the wiring is genuine
// rather than stubbed. It is explicitly a PROVING-GROUND identity, not the
// production trust root — a live belt roots signer/verifier in the Illuci Runtime
// per-tenant identity, cross-validated against the repo-authority guard.

import { createHmac, randomBytes } from "node:crypto";
import { getTopologyGovernanceManifest, validateTopologyManifest } from "../../topologies/manifest.js";
import { evaluateExitGate, evaluateEntryGate } from "./transition-gate.js";
import { runTier3StopgapChain, createJ3rainPort } from "../stopgap/tier3-chain.js";

export const WAREHOUSE_BELT_SCHEMA = "illuci.governance.warehouse-belt/1";

/**
 * A transition's tier — the slice-2 consequence doctrine, applied to belt
 * movement. INTERNAL/WATCH hops are belt-gated only; a CONSEQUENTIAL transition
 * (the promotion airlock) additionally requires a released Tier-3 stopgap.
 */
export const TRANSITION_TIER = Object.freeze({ INTERNAL: 1, WATCH: 2, CONSEQUENTIAL: 3 });

/** The tenant id a station provisions as (an isolated Illuci Runtime tenant). */
export function stationTenantId(station) {
  return `warehouse-${station.id}`;
}

/**
 * The eight stations of the warehouse belt. `index` and `ledgerId` are
 * STRUCTURAL (the guard enforces them). `topologyId` is a swappable DEFAULT
 * (ratified D2: a station's governing topology is a default, per-belt
 * overridable — grounded in the BRAINSTORM_PLAN / GOVERNED_FULL_CYCLE
 * precedents). `entryTier` is the tier of the transition that ADMITS into the
 * station: only the promotion airlock is Tier-3.
 */
export const WAREHOUSE_STATIONS = Object.freeze([
  { index: 0, id: "S0-intake",            name: "Intake",            ledgerId: "W0", topologyId: "research-swarm",     entryTier: TRANSITION_TIER.INTERNAL },
  { index: 1, id: "S1-ideation",          name: "Ideation",          ledgerId: "W1", topologyId: "commune",           entryTier: TRANSITION_TIER.INTERNAL },
  { index: 2, id: "S2-convergence",       name: "Convergence",       ledgerId: "W2", topologyId: "delphi-panel",      entryTier: TRANSITION_TIER.INTERNAL },
  { index: 3, id: "S3-spec",              name: "Spec",              ledgerId: "W3", topologyId: "dev-team",          entryTier: TRANSITION_TIER.INTERNAL },
  { index: 4, id: "S4-build-on-bench",    name: "Build-on-Bench",    ledgerId: "W4", topologyId: "apprentice-master", entryTier: TRANSITION_TIER.INTERNAL },
  { index: 5, id: "S5-proving-ground",    name: "Proving-Ground",    ledgerId: "W5", topologyId: "adversarial-debate", entryTier: TRANSITION_TIER.WATCH },
  { index: 6, id: "S6-belt-inspectorate", name: "Belt Inspectorate", ledgerId: "W6", topologyId: "censorate",         entryTier: TRANSITION_TIER.WATCH },
  { index: 7, id: "S7-promotion-airlock", name: "Promotion Airlock", ledgerId: "W7", topologyId: "legislature",       entryTier: TRANSITION_TIER.CONSEQUENTIAL },
]);

const LEDGER_ID_RE = /^W[0-9]+$/;

/**
 * The ratified tier FLOOR for each canonical station id (its entryTier). A
 * custom or hand-crafted belt may never DOWNGRADE a canonical station below its
 * floor — the promotion airlock cannot be quietly demoted out of Tier-3 to skip
 * the stopgap chain. Non-canonical (caller-authored) stations carry no floor.
 */
const CANONICAL_STATION_TIER_FLOOR = new Map(WAREHOUSE_STATIONS.map((s) => [s.id, s.entryTier]));

/**
 * The structural guard. Rejects any station chain that could describe an
 * ungated or ungoverned belt: fewer than two stations, non-contiguous indices,
 * a duplicate or malformed [Wn] ledger id, or a station whose governing
 * topology does not resolve to a border-valid governance manifest (slice 1).
 *
 * A rejection here is the "structurally unable to provision ungated" property
 * at construction time — the belt object for a malformed chain never exists.
 *
 * @param {Array<object>} stations
 */
export function assertWellFormedStationChain(stations) {
  if (!Array.isArray(stations) || stations.length < 2) {
    throw new Error("warehouse belt: a belt needs at least two stations (head + one gated transition)");
  }
  const seenLedgers = new Set();
  stations.forEach((station, i) => {
    if (!station || typeof station.id !== "string" || station.id.length === 0) {
      throw new Error(`warehouse belt: station at position ${i} has no id`);
    }
    if (station.index !== i) {
      throw new Error(`warehouse belt: station "${station.id}" has index ${station.index} at position ${i} (stations must be contiguous from 0)`);
    }
    if (typeof station.ledgerId !== "string" || !LEDGER_ID_RE.test(station.ledgerId)) {
      throw new Error(`warehouse belt: station "${station.id}" has invalid ledger id "${station.ledgerId}" (expected W0..Wn)`);
    }
    if (seenLedgers.has(station.ledgerId)) {
      throw new Error(`warehouse belt: duplicate ledger id "${station.ledgerId}" — each station owns a distinct [Wn] ledger`);
    }
    seenLedgers.add(station.ledgerId);
    // Slice-1 proof: a station is a governed structure or it does not provision.
    const manifest = getTopologyGovernanceManifest(station.topologyId);
    if (!manifest) {
      throw new Error(`warehouse belt: station "${station.id}" names topology "${station.topologyId}" which resolves to no governed structure`);
    }
    const border = validateTopologyManifest(manifest);
    if (!border.ok) {
      throw new Error(`warehouse belt: station "${station.id}" topology "${station.topologyId}" fails the manifest border: ${border.errors.join("; ")}`);
    }
    // A canonical station may not be defined below its ratified tier floor.
    const floor = CANONICAL_STATION_TIER_FLOOR.get(station.id);
    if (floor !== undefined && Number(station.entryTier) < floor) {
      throw new Error(`warehouse belt: canonical station "${station.id}" declares entryTier ${station.entryTier}, below its ratified floor ${floor} (a canonical station cannot be tier-downgraded)`);
    }
  });
}

/**
 * Advancement-time integrity check: reject a belt that did not come from
 * buildWarehouseBelt (wrong schema / not frozen) or whose transitions have been
 * tampered to contradict their stations or to downgrade a canonical station's
 * tier. The construction guard already enforces this for built belts; this
 * closes the forged-belt seam so advanceStation cannot be driven with a
 * hand-crafted object that, e.g., demotes the Tier-3 airlock to skip the stopgap.
 *
 * @param {object} belt
 */
export function assertBeltIntegrity(belt) {
  if (!belt || belt.schema !== WAREHOUSE_BELT_SCHEMA || !Array.isArray(belt.stations) || !Array.isArray(belt.transitions)) {
    throw new Error("warehouse belt: advanceStation requires a belt from buildWarehouseBelt (schema/shape mismatch)");
  }
  if (!Object.isFrozen(belt) || !Object.isFrozen(belt.stations) || !Object.isFrozen(belt.transitions)) {
    throw new Error("warehouse belt: the belt must be frozen — build it with buildWarehouseBelt, do not hand-craft it");
  }
  belt.transitions.forEach((t, i) => {
    const from = belt.stations[i];
    const to = belt.stations[i + 1];
    if (!to || t.to !== to.id || !from || t.fromLedgerId !== from.ledgerId) {
      throw new Error(`warehouse belt: transition ${i} does not match its stations`);
    }
    if (t.tier !== to.entryTier) {
      throw new Error(`warehouse belt: transition ${i} tier ${t.tier} contradicts station "${to.id}" entryTier ${to.entryTier}`);
    }
    const floor = CANONICAL_STATION_TIER_FLOOR.get(to.id);
    if (floor !== undefined && Number(t.tier) < floor) {
      throw new Error(`warehouse belt: transition into canonical station "${to.id}" is tier ${t.tier}, below its ratified floor ${floor} (a hand-crafted belt cannot downgrade the airlock)`);
    }
  });
}

/**
 * Construct a warehouse belt. Runs the structural guard, then derives the frozen
 * transition list — one per adjacent station pair, tier = the entering station's
 * entryTier. The returned belt is frozen and exposes NO ungated mover.
 *
 * @param {{stations?: Array<object>}} [options]
 * @returns {Readonly<{schema: string, stations: ReadonlyArray<object>, transitions: ReadonlyArray<object>}>}
 */
export function buildWarehouseBelt(options = {}) {
  const stations = (options.stations ? options.stations : WAREHOUSE_STATIONS).map((s) => ({ ...s, tenantId: s.tenantId || stationTenantId(s) }));
  assertWellFormedStationChain(stations);
  const transitions = [];
  for (let n = 0; n < stations.length - 1; n++) {
    const from = stations[n];
    const to = stations[n + 1];
    transitions.push(Object.freeze({
      from: from.id,
      to: to.id,
      fromLedgerId: from.ledgerId,
      fromTenantId: from.tenantId,
      toTenantId: to.tenantId,
      tier: to.entryTier,
    }));
  }
  return Object.freeze({
    schema: WAREHOUSE_BELT_SCHEMA,
    stations: Object.freeze(stations.map((s) => Object.freeze(s))),
    transitions: Object.freeze(transitions),
  });
}

/**
 * The SOLE mover between stations. Advances a payload S(N) → S(N+1) through the
 * slice-4 gate pair: sign the exit into [W(N)], then fail-closed entry
 * verification at S(N+1). There is no code path here that reaches an admitted
 * state without both gates — that absence IS the structural guarantee.
 *
 * @param {object} belt - a belt from buildWarehouseBelt
 * @param {number} fromIndex - the exiting station's index
 * @param {{
 *   payload: object,
 *   trace: object,                    // the exiting station's TAOR run trace
 *   exitSigner: {tenantId: string, sign: Function},   // the exiting tenant's boundary signer
 *   entryVerifier: {verify: Function},                // the entering tenant's boundary verifier
 *   arming: {armed: boolean, basis?: string},         // repo-authority + tenant-identity rooted
 *   stopgapRecord?: object,           // required (released) for a Tier-3 transition
 * }} io
 */
export async function advanceStation(belt, fromIndex, io = {}) {
  assertBeltIntegrity(belt);
  const from = belt.stations[fromIndex];
  const to = belt.stations[fromIndex + 1];
  if (!from || !to) {
    throw new Error(`warehouse belt: no transition from station index ${fromIndex}`);
  }
  const transition = belt.transitions[fromIndex];

  const exit = await evaluateExitGate({
    stationLedgerId: from.ledgerId,
    stationId: from.id,
    payload: io.payload,
    trace: io.trace,
    signer: io.exitSigner,
  });
  if (!exit.admitted) {
    return { admitted: false, stage: "exit", from: from.id, to: to.id, tier: transition.tier, verdict: exit };
  }

  const entry = await evaluateEntryGate({
    fromLedgerId: from.ledgerId,
    payload: io.payload,
    exitRecord: exit.record,
    arming: io.arming,
    verifier: io.entryVerifier,
    tier: transition.tier,
    stopgapRecord: io.stopgapRecord,
  });
  return {
    admitted: entry.admitted === true,
    stage: entry.admitted === true ? "admitted" : "entry",
    from: from.id,
    to: to.id,
    tier: transition.tier,
    exitRecord: exit.record,
    verdict: entry,
  };
}

/**
 * Per-station governance manifests (slice 1) for the whole belt — the "every
 * station is a governed structure" read. The monitor watches its count:
 * a deviation from the station count is a stopgap-grade alert.
 */
export function beltStationManifests(belt) {
  return belt.stations.map((s) => ({ station: s.id, topologyId: s.topologyId, manifest: getTopologyGovernanceManifest(s.topologyId) }));
}

export function beltManifestCount(belt) {
  return beltStationManifests(belt).filter((m) => m.manifest).length;
}

/**
 * Provision per-tenant PROVING-GROUND identities for a dry run: an HMAC
 * signer/verifier keyed per station tenant. A real signature round-trips (the
 * entry verifier resolves the EXITING tenant's key by keyId), so a dry run
 * proves genuine wiring — a tampered payload breaks the digest, a wrong tenant
 * breaks the signature. This is NOT the production trust root (that is the Illuci
 * Runtime per-tenant identity); it is the slice-5 verification surface.
 *
 * @param {object} belt
 */
export function createDryRunTenantIdentities(belt) {
  const keys = new Map();
  for (const station of belt.stations) {
    keys.set(station.tenantId, randomBytes(32).toString("hex"));
  }
  return {
    kind: "dry-run-proving-ground",
    signerFor(tenantId) {
      const key = keys.get(tenantId);
      if (!key) throw new Error(`warehouse belt dry-run: no identity for tenant "${tenantId}"`);
      return {
        tenantId,
        sign: async (digest) => ({ signature: createHmac("sha256", key).update(digest).digest("hex"), keyId: tenantId }),
      };
    },
    verifier: {
      verify: async (digest, signature, keyId) => {
        const key = keys.get(keyId);
        if (!key) return false;
        return signature === createHmac("sha256", key).update(digest).digest("hex");
      },
    },
  };
}

/**
 * Run the Tier-3 stopgap for the promotion airlock in a proving ground. Injects
 * the operator-held emulation-fidelity method and 2FA release that, live, arrive
 * out-of-band — so a dry run can observe the airlock ADMIT when released. With
 * no injection the chain fails closed (default J3rain rejects, no 2FA channel),
 * and the airlock rejects — both directions are provable.
 *
 * @param {{action: string, evidence?: string}} subject
 * @param {{release?: boolean, j3rainEvaluator?: Function, twoFactor?: object}} [injection]
 */
export async function provingGroundStopgap(subject, injection = {}) {
  const release = injection.release !== false;
  return runTier3StopgapChain(
    { action: subject.action, evidence: subject.evidence, tierVerdict: { code: "tier-3", dimensions: { tier: 3 }, signals: ["promotion-airlock"] } },
    {
      auditors: [
        { modelId: "dry-run-auditor-alpha", dispatch: async () => ({ verdict: "no-refutation-found", findings: [], confidence: 0.9 }) },
        { modelId: "dry-run-auditor-beta", dispatch: async () => ({ verdict: "no-refutation-found", findings: [], confidence: 0.88 }) },
      ],
      j3rain: createJ3rainPort({
        evaluator: injection.j3rainEvaluator || (release ? async () => ({ decision: "pass-to-operator", reasoning: "proving-ground fidelity injection" }) : undefined),
      }),
      twoFactor: injection.twoFactor || (release ? { requestRelease: async () => ({ released: true, channel: "proving-ground-2fa", evidence: "operator release (dry-run)" }) } : undefined),
    },
  );
}

/** A clean TAOR trace for a station whose run passed (dry-run default). */
const CLEAN_STATION_TRACE = Object.freeze({ halted: false, phases: { work: { gateStatus: "pass" } } });

/**
 * The end-to-end governed dry run: walk a payload S0 → S7, admitting through
 * every transition's gate pair. At the Tier-3 airlock it resolves a stopgap
 * (released by default via the proving-ground injection). Returns the full hop
 * trace; halts loudly at the first rejected transition.
 *
 * @param {object} belt
 * @param {{
 *   payload: object,
 *   identities?: object,              // createDryRunTenantIdentities(belt) by default
 *   arming?: {armed: boolean, basis?: string},
 *   stationTrace?: (station: object) => object,
 *   stopgapForAirlock?: (from: object, to: object, payload: object) => Promise<object>,
 * }} [io]
 */
export async function dryRunBelt(belt, io = {}) {
  const identities = io.identities || createDryRunTenantIdentities(belt);
  const arming = io.arming || { armed: true, basis: "dry-run: repo-authority verdict + tenant identity (simulated)" };
  const payload = io.payload || { artifact: "warehouse-dry-run", content: "a work item traversing the belt" };
  const hops = [];
  for (let n = 0; n < belt.stations.length - 1; n++) {
    const from = belt.stations[n];
    const to = belt.stations[n + 1];
    const transition = belt.transitions[n];
    let stopgapRecord = null;
    if (transition.tier === TRANSITION_TIER.CONSEQUENTIAL) {
      stopgapRecord = io.stopgapForAirlock
        ? await io.stopgapForAirlock(from, to, payload)
        : await provingGroundStopgap({ action: `promote "${payload.artifact}" through the ${to.name}`, evidence: `belt lineage S0..${from.id}` });
    }
    const hop = await advanceStation(belt, n, {
      payload,
      trace: io.stationTrace ? io.stationTrace(from) : CLEAN_STATION_TRACE,
      exitSigner: identities.signerFor(from.tenantId),
      entryVerifier: identities.verifier,
      arming,
      stopgapRecord,
    });
    hops.push(hop);
    if (!hop.admitted) {
      return { admitted: false, promoted: null, haltedAt: to.id, hops };
    }
  }
  return { admitted: true, promoted: belt.stations[belt.stations.length - 1].id, hops };
}

/**
 * The WAREHOUSE_BELT composition descriptor — the pipeline-shaped VIEW of the
 * belt (ordered station stages). Deliberately data-only and NOT registered with
 * the plain pipeline runner: the belt's only executor is the gated walker, so it
 * cannot be run ungated through the ordinary pipeline path.
 */
export const WAREHOUSE_BELT_COMPOSITION = Object.freeze({
  id: "warehouse-belt",
  name: "Warehouse Belt",
  schema: WAREHOUSE_BELT_SCHEMA,
  description:
    "The [A27] pre-GitOps R&D warehouse beneath the CWP: stations S0–S7 as runtime tenants, advanced ONLY through the per-transition entry/exit gate. Not a plain pipeline — it is structurally unable to run ungated.",
  stations: WAREHOUSE_STATIONS.map((s) => Object.freeze({ station: s.id, name: s.name, topologyId: s.topologyId, ledgerId: s.ledgerId, entryTier: s.entryTier })),
});

export default {
  WAREHOUSE_BELT_SCHEMA,
  TRANSITION_TIER,
  WAREHOUSE_STATIONS,
  WAREHOUSE_BELT_COMPOSITION,
  stationTenantId,
  assertWellFormedStationChain,
  assertBeltIntegrity,
  buildWarehouseBelt,
  advanceStation,
  beltStationManifests,
  beltManifestCount,
  createDryRunTenantIdentities,
  provingGroundStopgap,
  dryRunBelt,
};
