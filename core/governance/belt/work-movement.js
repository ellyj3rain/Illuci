// illuci/core/governance/belt/work-movement.js
//
// [A24.7] Real work movement through the belt — the factory's Lane-2 slice 2.
//
// [A24.4] built the gate pair; [A24.5] the stations+belt; [A24.6] live tenant identities
// and repo-authority-rooted arming. What remained supplied-by-hand was the TRACE: every
// prior walk fed the exit gate a constructed TAOR outcome. This slice closes that gap —
// a station's work is an ACTUAL governed topology run, and the gate evaluates the run's
// OWN trace. The runner's TAOR contract and the gate's invariants are the same shape by
// construction (trace.halted / trace.haltReason / trace.phases[id].gateStatus — [A24.4]
// was written against the runner's contract), so the composition is direct: no adapter,
// no re-authoring of outcomes.
//
// Honest failure is the point: a station run that halts (or fails a content gate) is an
// honest EXIT REJECTION carrying the run's own haltReason — the work does not move, and
// nothing re-labels the failure.
//
// Port-injected per the tier3-chain / planAgenda precedent: the topology runner enters as
// a PORT (defaulting to the real core/topologies/runner.js runTopology via lazy import —
// the dispatch-tools idiom, so importing this module never loads the bridge graph). The
// belt, gates, identities, and arming are the [A24.4–.6] surfaces, consumed not rebuilt.

import { advanceStation, TRANSITION_TIER } from "./warehouse-belt.js";
import { liveTenantIdentities, armStationEntry } from "./station-tenants.js";
import { appendStationLedger, payloadDigest } from "./transition-gate.js";

export const WORK_MOVEMENT_SCHEMA = "illuci.governance.belt-work-movement/1";

/** The default runner port: the REAL governed topology run (lazy — never at import time). */
async function defaultRunTopology(topologyId, lineup, task, options) {
  const { runTopology } = await import("../../topologies/runner.js");
  return runTopology(topologyId, lineup, task, options);
}

/**
 * Run ONE station's work: the station's governing topology over the task, via the runner
 * port. Returns the run's trace verbatim (the gate evaluates it as-is) plus provenance.
 *
 * @param {object} station - a belt station (id, topologyId, tenantId, ledgerId)
 * @param {{task: string, lineup?: object, runOptions?: object, runTopologyFn?: Function}} input
 */
export async function runStationWork(station, input = {}) {
  if (!station || typeof station.topologyId !== "string") {
    throw new Error("runStationWork: a belt station with a topologyId is required");
  }
  if (typeof input.task !== "string" || input.task.length === 0) {
    throw new Error("runStationWork: task (string) is required — a station runs WORK, not a blank");
  }
  const run = typeof input.runTopologyFn === "function" ? input.runTopologyFn : defaultRunTopology;
  const trace = await run(station.topologyId, input.lineup || {}, input.task, input.runOptions || {});
  return {
    schema: WORK_MOVEMENT_SCHEMA,
    stationId: station.id,
    tenantId: station.tenantId,
    topologyId: station.topologyId,
    task: input.task,
    trace,
  };
}

/**
 * Move a work item S(N) → S(N+1) on its REAL run outcome: run the exiting station's
 * topology, then drive the [A24.4] gate pair with the run's own trace. The exit gate
 * evaluates the genuine TAOR outcome — an honest halt is an honest rejection, and the
 * work does not move.
 *
 * Live-by-default: identities resolve from the runtime tenant substrate ([A24.6]) and
 * arming from repo-authority + the entering station's registration (armStationEntry),
 * both overridable (tests inject; a probe passes through). A Tier-3 transition consumes
 * a released stopgap record via `stopgapFor` — absent, the airlock fails closed.
 *
 * @param {object} belt - a buildWarehouseBelt() belt
 * @param {number} fromIndex - the exiting station's index
 * @param {{
 *   payload: object,                      // the work artifact moving down the belt
 *   task: string,                         // the exiting station's work instruction
 *   lineup?: object, runOptions?: object,
 *   runTopologyFn?: Function,             // runner port (default: the real runTopology)
 *   identities?: object,                  // default: liveTenantIdentities(belt)
 *   arming?: {armed: boolean, basis?: string},  // explicit arming fact (else armStationEntry)
 *   armProbe?: Function,                  // probe passthrough for armStationEntry
 *   stopgapFor?: (from, to, payload, run) => Promise<object>,  // Tier-3 stopgap port
 *   connectionsOptions?: object,
 * }} input
 */
export async function moveWork(belt, fromIndex, input = {}) {
  const from = belt.stations[fromIndex];
  const to = belt.stations[fromIndex + 1];
  if (!from || !to) throw new Error(`moveWork: no transition from station index ${fromIndex}`);

  const run = await runStationWork(from, {
    task: input.task,
    lineup: input.lineup,
    runOptions: input.runOptions,
    runTopologyFn: input.runTopologyFn,
  });

  const identities = input.identities || liveTenantIdentities(belt, input.connectionsOptions || {});
  const arming =
    input.arming ||
    armStationEntry({ tenantId: to.tenantId, probe: input.armProbe, options: input.connectionsOptions || {} });

  let stopgapRecord = null;
  if (belt.transitions[fromIndex].tier === TRANSITION_TIER.CONSEQUENTIAL && typeof input.stopgapFor === "function") {
    stopgapRecord = await input.stopgapFor(from, to, input.payload, run);
  }

  const hop = await advanceStation(belt, fromIndex, {
    payload: input.payload,
    trace: run.trace, // the run's OWN outcome — never a constructed stand-in
    exitSigner: identities.signerFor(from.tenantId),
    entryVerifier: identities.verifier,
    arming,
    stopgapRecord,
  });

  // [A24.8] The movement itself leaves a record (F-076: entry verdicts were ephemeral —
  // exits were ledgered but a hop's admission/rejection evaporated with the caller, against
  // see-and-verify). EVERY attempt appends ONE hash-chained verdict record to the ENTERING
  // station's ledger — rejections recorded exactly like admissions (the stopgap precedent).
  // Recording is evidence, not the gate: a failed append never flips the verdict, but the
  // returned result carries the record (or its absence) honestly.
  let movementRecord = null;
  try {
    movementRecord = appendStationLedger(to.ledgerId, {
      schema: WORK_MOVEMENT_SCHEMA,
      kind: "entry-verdict",
      admitted: hop.admitted === true,
      stage: hop.stage,
      code: hop.verdict?.code || null,
      detail: hop.verdict?.detail || null,
      from: from.id,
      to: to.id,
      tier: belt.transitions[fromIndex].tier,
      payloadDigest: payloadDigest(input.payload ?? {}),
      topologyId: run.topologyId,
      runHalted: !!run.trace?.halted,
      haltReason: run.trace?.haltReason || null,
    });
  } catch {
    // evidence, not the gate
  }

  return {
    schema: WORK_MOVEMENT_SCHEMA,
    ...hop,
    run: { stationId: run.stationId, topologyId: run.topologyId, task: run.task },
    trace: run.trace,
    movementRecord,
  };
}

export default { WORK_MOVEMENT_SCHEMA, runStationWork, moveWork };
