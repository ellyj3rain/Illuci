/**
 * illuci — [A24.5] Warehouse belt (node:test, hermetic — temp ledgers per test)
 *
 * The slice-5 verification bar (factory-implementation-plan.md §5):
 *   - end-to-end governed dry-run S0 → S7 admits through every gate pair;
 *   - the belt is STRUCTURALLY unable to provision ungated: a malformed or
 *     ungoverned station chain cannot be constructed, and no payload reaches an
 *     admitted state except through the gated mover;
 *   - every fail-closed circuit (unarmed, unsigned, unverifiable signature,
 *     unreleased Tier-3 stopgap) loudly rejects.
 *
 * Run: node --test core/governance/belt/warehouse-belt.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-warehouse-belt-test-"));

const belt = await import("./warehouse-belt.js");
const { GATE_CODES, readStationLedger } = await import("./transition-gate.js");
const { STOPGAP_CODES } = await import("../stopgap/tier3-chain.js");

const {
  buildWarehouseBelt,
  advanceStation,
  dryRunBelt,
  beltManifestCount,
  createDryRunTenantIdentities,
  provingGroundStopgap,
  WAREHOUSE_STATIONS,
  WAREHOUSE_BELT_COMPOSITION,
  TRANSITION_TIER,
} = belt;

/** Give a test its own ledger root so ledger assertions are deterministic. */
function freshDataHome() {
  process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-warehouse-belt-test-"));
}

const S = WAREHOUSE_STATIONS;

// ─── Structure: the canonical belt ────────────────────────────────────────────

test("A24.5: builds the canonical 8-station belt with 7 gated transitions", () => {
  const b = buildWarehouseBelt();
  assert.equal(b.stations.length, 8);
  assert.equal(b.transitions.length, 7);
  // Only the promotion airlock is Tier-3; every prior hop is below it.
  assert.equal(b.transitions[6].to, "S7-promotion-airlock");
  assert.equal(b.transitions[6].tier, TRANSITION_TIER.CONSEQUENTIAL);
  for (let i = 0; i < 6; i++) assert.ok(b.transitions[i].tier < TRANSITION_TIER.CONSEQUENTIAL);
  // Each station provisions as its own runtime tenant.
  assert.equal(b.stations[0].tenantId, "warehouse-S0-intake");
  assert.equal(b.stations[7].tenantId, "warehouse-S7-promotion-airlock");
});

test("A24.5: every station is a governed structure (manifest count == station count)", () => {
  const b = buildWarehouseBelt();
  assert.equal(beltManifestCount(b), 8);
  for (const { manifest } of belt.beltStationManifests(b)) {
    assert.ok(manifest, "each station's topology derives a governance manifest");
    assert.equal(manifest.source, "registry");
  }
});

// ─── The structural guarantee: an ungated/ungoverned belt cannot be built ─────

test("A24.5: a non-contiguous station chain cannot be constructed", () => {
  assert.throws(() => buildWarehouseBelt({ stations: [{ ...S[0] }, { ...S[2] }] }), /contiguous/);
});

test("A24.5: a duplicate [Wn] ledger cannot be constructed", () => {
  assert.throws(() => buildWarehouseBelt({ stations: [{ ...S[0] }, { ...S[1], ledgerId: "W0" }] }), /duplicate ledger/);
});

test("A24.5: an invalid ledger id cannot be constructed", () => {
  assert.throws(() => buildWarehouseBelt({ stations: [{ ...S[0], ledgerId: "X1" }, { ...S[1] }] }), /invalid ledger id/);
});

test("A24.5: a station naming an ungoverned topology cannot be constructed", () => {
  assert.throws(
    () => buildWarehouseBelt({ stations: [{ ...S[0] }, { ...S[1], topologyId: "no-such-topology-xyz" }] }),
    /no governed structure/,
  );
});

test("A24.5: a single-station 'belt' cannot be constructed (no gated transition)", () => {
  assert.throws(() => buildWarehouseBelt({ stations: [{ ...S[0] }] }), /at least two stations/);
});

// ─── End-to-end governed dry-run S0 → S7 ──────────────────────────────────────

test("A24.5: the end-to-end governed dry-run admits a payload S0 → S7", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const result = await dryRunBelt(b);
  assert.equal(result.admitted, true, "the belt admits the payload all the way to the airlock");
  assert.equal(result.promoted, "S7-promotion-airlock");
  assert.equal(result.hops.length, 7);
  for (const hop of result.hops) assert.equal(hop.admitted, true);
  // The final hop is the Tier-3 airlock admission.
  assert.equal(result.hops[6].tier, TRANSITION_TIER.CONSEQUENTIAL);
  assert.equal(result.hops[6].to, "S7-promotion-airlock");
});

test("A24.5: every promotion is gate-signed — one exit record per hop, none skipped", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const result = await dryRunBelt(b);
  assert.equal(result.admitted, true);
  // Each exiting station (W0..W6) holds exactly one signed exit record; the
  // terminal airlock (W7) never exits within the belt.
  for (let n = 0; n <= 6; n++) {
    const ledger = readStationLedger(`W${n}`);
    assert.equal(ledger.length, 1, `W${n} holds exactly one signed exit`);
    assert.equal(ledger[0].kind, "exit");
    assert.equal(ledger[0].tenantId, `warehouse-${S[n].id}`);
  }
  assert.equal(readStationLedger("W7").length, 0, "the airlock is terminal — nothing exits it");
});

// ─── Fail-closed circuits (absence of signal is a loud failure) ────────────────

test("A24.5: an unarmed transition fails closed", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const ids = createDryRunTenantIdentities(b);
  const hop = await advanceStation(b, 0, {
    payload: { artifact: "x" },
    trace: { halted: false, phases: {} },
    exitSigner: ids.signerFor(b.stations[0].tenantId),
    entryVerifier: ids.verifier,
    arming: { armed: false, basis: "deliberately unarmed" },
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_UNARMED);
});

test("A24.5: the belt holds no keys — a missing tenant signer fails closed at exit", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const ids = createDryRunTenantIdentities(b);
  const hop = await advanceStation(b, 0, {
    payload: { artifact: "x" },
    trace: { halted: false, phases: {} },
    exitSigner: undefined,
    entryVerifier: ids.verifier,
    arming: { armed: true },
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.stage, "exit");
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_SIGNER_FAILED);
});

test("A24.5: a signature that does not verify at the tenant boundary fails closed", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const ids = createDryRunTenantIdentities(b);
  const hop = await advanceStation(b, 0, {
    payload: { artifact: "x" },
    trace: { halted: false, phases: {} },
    exitSigner: ids.signerFor(b.stations[0].tenantId),
    entryVerifier: { verify: async () => false }, // a tenant-identity mismatch
    arming: { armed: true },
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_BAD_SIGNATURE);
});

test("A24.5: a halted station run is an honest rejection at exit", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const ids = createDryRunTenantIdentities(b);
  const hop = await advanceStation(b, 0, {
    payload: { artifact: "x" },
    trace: { halted: true, haltReason: "the station could not converge" },
    exitSigner: ids.signerFor(b.stations[0].tenantId),
    entryVerifier: ids.verifier,
    arming: { armed: true },
  });
  assert.equal(hop.admitted, false);
  assert.equal(hop.stage, "exit");
  assert.equal(hop.verdict.code, GATE_CODES.REJECTED_TAOR_HALTED);
});

// ─── The Tier-3 airlock consumes the stopgap chain (both directions) ───────────

test("A24.5: the Tier-3 airlock rejects without a RELEASED stopgap", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  const result = await dryRunBelt(b, { stopgapForAirlock: async () => ({ outcome: { released: false } }) });
  assert.equal(result.admitted, false);
  assert.equal(result.haltedAt, "S7-promotion-airlock");
  assert.equal(result.hops[6].verdict.code, GATE_CODES.REJECTED_TIER3_UNRELEASED);
});

test("A24.5: the proving-ground stopgap releases only with operator fidelity injection; default fails closed", async () => {
  // With injection (release path): released.
  const released = await provingGroundStopgap({ action: "promote artifact through the airlock" });
  assert.equal(released.outcome.released, true);
  assert.equal(released.outcome.code, STOPGAP_CODES.RELEASED);
  // Without injection: the default J3rain rejects (fail-closed) — no release.
  const held = await provingGroundStopgap({ action: "promote artifact through the airlock" }, { release: false });
  assert.equal(held.outcome.released, false);
  assert.equal(held.outcome.code, STOPGAP_CODES.REJECTED_J3RAIN_DEFAULT);
});

// ─── The forged-belt seam: a hand-crafted belt cannot skip the guarantee ──────

test("A24.5: advanceStation rejects a hand-crafted (unfrozen) belt", async () => {
  freshDataHome();
  const b = buildWarehouseBelt();
  // A new object shaped like a belt but not produced by buildWarehouseBelt.
  const forged = { schema: b.schema, stations: b.stations, transitions: b.transitions.map((t) => ({ ...t })) };
  await assert.rejects(
    () => advanceStation(forged, 0, { payload: {}, trace: { halted: false, phases: {} }, arming: { armed: true } }),
    /frozen|hand-craft/i,
  );
});

test("A24.5: a canonical station cannot be tier-downgraded (the airlock demotion is rejected at construction)", () => {
  const demoted = S.map((s) => (s.id === "S7-promotion-airlock" ? { ...s, entryTier: 1 } : { ...s }));
  assert.throws(() => buildWarehouseBelt({ stations: demoted }), /floor/);
});

// ─── The composition VIEW is data-only (cannot be run ungated) ────────────────

test("A24.5: WAREHOUSE_BELT_COMPOSITION is data-only — no executor to run it ungated", () => {
  assert.equal(WAREHOUSE_BELT_COMPOSITION.stations.length, 8);
  // No function-valued field could smuggle an ungated executor into the descriptor.
  for (const value of Object.values(WAREHOUSE_BELT_COMPOSITION)) {
    assert.notEqual(typeof value, "function");
  }
  // The sole exported mover is the gated one.
  assert.equal(typeof advanceStation, "function");
  assert.equal(belt.default.advanceUngated, undefined);
});
