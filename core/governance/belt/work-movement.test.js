/**
 * illuci — [A24.7] Real work movement through the belt (node:test, hermetic)
 *
 * The bar: a station's ACTUAL run outcome drives the gate pair. Clean runs move the
 * work on live tenant identities + live arming; an honest halt or failed content gate
 * is an honest exit rejection carrying the run's OWN reason; the Tier-3 airlock
 * consumes the stopgap port and fails closed without it. The runner enters as a PORT
 * (fakes here; a source guard pins the default port to the real runner via lazy import
 * so this test never loads the bridge graph).
 *
 * Run: node --test core/governance/belt/work-movement.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-work-movement-"));

const { runStationWork, moveWork, WORK_MOVEMENT_SCHEMA } = await import("./work-movement.js");
const { buildWarehouseBelt, provingGroundStopgap, GATE_CODES } = await import("./warehouse-belt.js").then(async (belt) => ({
  ...belt,
  GATE_CODES: (await import("./transition-gate.js")).GATE_CODES,
}));
const { provisionWarehouseStationTenants } = await import("./station-tenants.js");

function freshDataHome() {
  process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-work-movement-"));
}

const ALLOW_PROBE = () => ({ allowed: true, code: "satisfied", decision: "authorized" });
const BLOCK_PROBE = () => ({ allowed: false, code: "violation", decision: "split-brain" });

const CLEAN_RUN = async () => ({ halted: false, phases: { work: { gateStatus: "pass" } } });
const HALTED_RUN = async () => ({ halted: true, haltReason: "the commune could not converge", phases: {} });
const GATE_FAILED_RUN = async () => ({ halted: false, phases: { review: { gateStatus: "fail", gateReason: "reviewer refuted the draft" } } });

// ─── runStationWork: the station's topology runs through the port ─────────────

test("A24.7: runStationWork runs the STATION's governing topology with the task through the port", async () => {
  const belt = buildWarehouseBelt();
  const calls = [];
  const result = await runStationWork(belt.stations[2], {
    task: "converge the spec candidates",
    lineup: { facilitator: "model-x" },
    runOptions: { runControl: { agenda: { strategy: "conducted" } } },
    runTopologyFn: async (topologyId, lineup, task, options) => {
      calls.push({ topologyId, lineup, task, options });
      return { halted: false, phases: {} };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topologyId, "delphi-panel", "S2 runs ITS governing topology");
  assert.equal(calls[0].task, "converge the spec candidates");
  assert.deepEqual(calls[0].lineup, { facilitator: "model-x" });
  assert.equal(calls[0].options.runControl.agenda.strategy, "conducted");
  assert.equal(result.schema, WORK_MOVEMENT_SCHEMA);
  assert.equal(result.stationId, "S2-convergence");
});

test("A24.7: a blank task refuses to run (a station runs WORK)", async () => {
  const belt = buildWarehouseBelt();
  await assert.rejects(() => runStationWork(belt.stations[0], { runTopologyFn: CLEAN_RUN }), /task \(string\) is required/);
});

// ─── moveWork: the run's OWN trace drives the gates ────────────────────────────

test("A24.7: a clean real run moves the work S0→S1 on live identities + live arming", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, {
    payload: { artifact: "intake-item", rev: 1 },
    task: "triage the incoming idea",
    runTopologyFn: CLEAN_RUN,
    armProbe: ALLOW_PROBE,
  });
  assert.equal(hop.admitted, true);
  assert.equal(hop.stage, "admitted");
  assert.equal(hop.from, "S0-intake");
  assert.equal(hop.to, "S1-ideation");
  assert.equal(hop.run.topologyId, "research-swarm");
  assert.ok(hop.exitRecord.signature, "the exit is signed by the live tenant identity");
});

test("A24.7: an honestly-halted run is an honest exit rejection carrying the run's OWN reason — the work does not move", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, {
    payload: { artifact: "x" },
    task: "ideate",
    runTopologyFn: HALTED_RUN,
    armProbe: ALLOW_PROBE,
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.stage, "exit");
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_TAOR_HALTED);
  assert.match(hop.verdict.detail, /the commune could not converge/, "the run's own haltReason, not a re-label");
});

test("A24.7: a failed content gate in the run rejects at exit with the gate's own reason", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, {
    payload: { artifact: "x" },
    task: "draft",
    runTopologyFn: GATE_FAILED_RUN,
    armProbe: ALLOW_PROBE,
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_TAOR_GATE_FAILED);
  assert.match(hop.verdict.detail, /reviewer refuted the draft/);
});

test("A24.7: a split-brain repo context disarms the entry — a clean run still does not move", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, {
    payload: { artifact: "x" },
    task: "triage",
    runTopologyFn: CLEAN_RUN,
    armProbe: BLOCK_PROBE,
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_UNARMED);
});

// ─── The Tier-3 airlock over real movement ─────────────────────────────────────

test("A24.7: the airlock hop (S6→S7) fails closed without a stopgap port and admits with a released one", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const base = { payload: { artifact: "promotable" }, task: "final inspection", runTopologyFn: CLEAN_RUN, armProbe: ALLOW_PROBE };

  const closed = await moveWork(belt, 6, { ...base });
  assert.equal(closed.admitted, false);
  assert.equal(closed.verdict.code, GATE_CODES.REJECTED_TIER3_UNRELEASED, "no stopgap port → the airlock fails closed");

  const released = await moveWork(belt, 6, {
    ...base,
    stopgapFor: (from, to, payload) => provingGroundStopgap({ action: `promote "${payload.artifact}"`, evidence: "belt lineage" }),
  });
  assert.equal(released.admitted, true, "a RELEASED stopgap admits through the airlock");
  assert.equal(released.to, "S7-promotion-airlock");
});

test("A24.7: moveWork refuses a terminal-station index (nothing exits the airlock within the belt)", async () => {
  const belt = buildWarehouseBelt();
  await assert.rejects(() => moveWork(belt, 7, { payload: {}, task: "x", runTopologyFn: CLEAN_RUN }), /no transition/);
});

// ─── [A24.8] Movement records: the movement itself leaves evidence (F-076) ─────

test("A24.8: an admitted hop appends an entry-verdict record to the ENTERING station's ledger", async () => {
  freshDataHome();
  const { readStationLedger, verifyStationLedger } = await import("./transition-gate.js");
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, { payload: { artifact: "x" }, task: "triage", runTopologyFn: CLEAN_RUN, armProbe: ALLOW_PROBE });
  assert.equal(hop.admitted, true);
  assert.ok(hop.movementRecord, "the result carries the record");
  const w1 = readStationLedger("W1");
  const verdict = w1.find((r) => r.kind === "entry-verdict");
  assert.ok(verdict, "W1 (the entering station) holds the verdict");
  assert.equal(verdict.admitted, true);
  assert.equal(verdict.from, "S0-intake");
  assert.equal(verdict.topologyId, "research-swarm");
  assert.equal(verifyStationLedger("W1").continuous, true, "mixed record kinds stay hash-chained");
});

test("A24.8: a REJECTED hop is recorded exactly like an admission (absence of signal would be the failure)", async () => {
  freshDataHome();
  const { readStationLedger } = await import("./transition-gate.js");
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  const hop = await moveWork(belt, 0, { payload: { artifact: "x" }, task: "ideate", runTopologyFn: HALTED_RUN, armProbe: ALLOW_PROBE });
  assert.equal(hop.admitted, false);
  const verdict = readStationLedger("W1").find((r) => r.kind === "entry-verdict");
  assert.ok(verdict, "the rejection left a record");
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.stage, "exit");
  assert.equal(verdict.runHalted, true);
  assert.match(verdict.haltReason, /could not converge/);
});

test("A24.8: exit-anchoring is unaffected by verdict records in the same ledger (the chained hop still admits)", async () => {
  freshDataHome();
  const belt = buildWarehouseBelt();
  provisionWarehouseStationTenants(belt);
  // Hop 0 puts an entry-verdict into W1; hop 1 then signs its exit into W1 and the S2 entry
  // gate must anchor that exit in a ledger that now carries MIXED kinds.
  const hop0 = await moveWork(belt, 0, { payload: { artifact: "x" }, task: "a", runTopologyFn: CLEAN_RUN, armProbe: ALLOW_PROBE });
  assert.equal(hop0.admitted, true);
  const hop1 = await moveWork(belt, 1, { payload: { artifact: "x" }, task: "b", runTopologyFn: CLEAN_RUN, armProbe: ALLOW_PROBE });
  assert.equal(hop1.admitted, true, "anchoring works through a mixed-kind ledger");
});

// ─── The default port is the REAL runner (source guard; no bridge import) ─────

test("A24.7: the default runner port lazy-imports the real core/topologies/runner.js", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "work-movement.js"), "utf8");
  assert.match(source, /await import\("\.\.\/\.\.\/topologies\/runner\.js"\)/, "lazy dynamic import of the real runner");
  assert.match(source, /runTopology\(topologyId, lineup, task, options\)/, "the port signature matches the runner's");
  assert.doesNotMatch(source, /^import .*topologies\/runner/m, "no top-level runner import (bridge graph stays unloaded)");
});
