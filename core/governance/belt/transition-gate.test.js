/**
 * illuci — [A24.4] Belt transition gate (node:test, hermetic — HMAC ports, temp ledgers)
 *
 * The ratified verification bar is ADVERSARIAL: every attempt to force a
 * state transition with unmet invariants, invalid signatures, tampered or
 * discontinuous ledgers, unarmed gates, or an unreleased Tier-3 stopgap MUST
 * loudly fail. The happy path exists — signed exit, continuous lineage,
 * verified entry — and the gate never holds key material (the anchor requests
 * the signature from the tenant boundary; it does not sign it itself).
 *
 * Run: node --test core/governance/belt/transition-gate.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

process.env.ILLUCI_DATA_HOME = mkdtempSync(join(tmpdir(), "illuci-belt-test-"));

const {
  GATE_CODES,
  payloadDigest,
  stationLedgerPath,
  appendStationLedger,
  verifyStationLedger,
  evaluateExitGate,
  evaluateEntryGate,
} = await import("./transition-gate.js");

// The tenant boundary: an HMAC signer/verifier pair. The KEY lives here in the
// test's "tenant boundary" — never inside the gate.
const TENANT_KEY = "zerostation-tenant-key-for-tests";
const signer = {
  tenantId: "zerostation",
  sign: async (digest) => ({ signature: createHmac("sha256", TENANT_KEY).update(digest).digest("hex"), keyId: "k1" }),
};
const verifier = {
  verify: async (digest, signature) => signature === createHmac("sha256", TENANT_KEY).update(digest).digest("hex"),
};
const ARMED = { armed: true, basis: "repo-authority verdict + tenant identity (test fixture)" };
const CLEAN_TRACE = { halted: false, phases: { work: { gateStatus: "pass" } } };
const PAYLOAD = { artifact: "spec-draft", content: "the S2 convergence output", meta: { rev: 3 } };

let LEDGER_N = 0;
const freshLedger = () => `W${LEDGER_N++}`;

// ─── The happy path: signed exit → continuous lineage → verified entry ─────────

test("A24.4: a clean run exits signed and enters admitted (full lineage)", async () => {
  const ledger = freshLedger();
  const exit = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S2-convergence", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  assert.equal(exit.admitted, true);
  assert.equal(exit.code, GATE_CODES.EXIT_SIGNED);
  assert.equal(exit.record.tenantId, "zerostation");

  const entry = await evaluateEntryGate({ fromLedgerId: ledger, payload: PAYLOAD, exitRecord: exit.record, arming: ARMED, verifier });
  assert.equal(entry.admitted, true);
  assert.equal(entry.code, GATE_CODES.ENTRY_ADMITTED);
});

test("A24.4: semantically-equal payloads digest equal across key order (nested)", () => {
  const a = payloadDigest({ x: { b: 1, a: [ { z: 1, y: 2 } ] }, w: "s" });
  const b = payloadDigest({ w: "s", x: { a: [ { y: 2, z: 1 } ], b: 1 } });
  assert.equal(a, b);
  assert.notEqual(a, payloadDigest({ x: { b: 2, a: [{ z: 1, y: 2 }] }, w: "s" }));
});

// ─── Adversarial: unmet TAOR invariants ─────────────────────────────────────────

test("A24.4: a HALTED station run cannot exit (the run's own haltReason is carried)", async () => {
  const exit = await evaluateExitGate({
    stationLedgerId: freshLedger(),
    stationId: "S4-bench",
    payload: PAYLOAD,
    trace: { halted: true, haltReason: "all-empty" },
    signer,
  });
  assert.equal(exit.admitted, false);
  assert.equal(exit.code, GATE_CODES.REJECTED_TAOR_HALTED);
  assert.match(exit.detail, /all-empty/);
});

test("A24.4: a failed content gate inside the run blocks exit", async () => {
  const exit = await evaluateExitGate({
    stationLedgerId: freshLedger(),
    stationId: "S4-bench",
    payload: PAYLOAD,
    trace: { halted: false, phases: { build: { gateStatus: "fail", gateReason: "seat-error" } } },
    signer,
  });
  assert.equal(exit.code, GATE_CODES.REJECTED_TAOR_GATE_FAILED);
  assert.match(exit.detail, /seat-error/);
});

// ─── Adversarial: the gate never signs; a broken tenant boundary fails closed ──

test("A24.4: no signer / thrown signer / empty signature all fail closed", async () => {
  const base = { stationLedgerId: freshLedger(), stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE };
  for (const badSigner of [
    undefined,
    { tenantId: "t", sign: async () => { throw new Error("boundary offline"); } },
    { tenantId: "t", sign: async () => ({ signature: "" }) },
  ]) {
    const exit = await evaluateExitGate({ ...base, signer: badSigner });
    assert.equal(exit.admitted, false);
    assert.equal(exit.code, GATE_CODES.REJECTED_SIGNER_FAILED);
  }
});

// ─── Adversarial: forged / mismatched / unanchored entries ─────────────────────

test("A24.4: a forged signature is rejected at entry", async () => {
  const ledger = freshLedger();
  const forger = { tenantId: "zerostation", sign: async (d) => ({ signature: createHmac("sha256", "WRONG-KEY").update(d).digest("hex") }) };
  const exit = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE, signer: forger });
  assert.equal(exit.admitted, true, "the forge only surfaces at VERIFICATION — exit cannot verify against itself");
  const entry = await evaluateEntryGate({ fromLedgerId: ledger, payload: PAYLOAD, exitRecord: exit.record, arming: ARMED, verifier });
  assert.equal(entry.admitted, false);
  assert.equal(entry.code, GATE_CODES.REJECTED_BAD_SIGNATURE);
});

test("A24.4: a payload swapped after signing is rejected (digest mismatch)", async () => {
  const ledger = freshLedger();
  const exit = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  const entry = await evaluateEntryGate({
    fromLedgerId: ledger,
    payload: { ...PAYLOAD, content: "TAMPERED" },
    exitRecord: exit.record,
    arming: ARMED,
    verifier,
  });
  assert.equal(entry.admitted, false);
  assert.equal(entry.code, GATE_CODES.REJECTED_PAYLOAD_MISMATCH);
});

test("A24.4: an exit record not anchored in the ledger is rejected", async () => {
  const ledgerA = freshLedger();
  const ledgerB = freshLedger();
  const exit = await evaluateExitGate({ stationLedgerId: ledgerA, stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  await evaluateExitGate({ stationLedgerId: ledgerB, stationId: "S1", payload: { other: true }, trace: CLEAN_TRACE, signer });
  // Present ledgerA's record against ledgerB.
  const entry = await evaluateEntryGate({ fromLedgerId: ledgerB, payload: PAYLOAD, exitRecord: exit.record, arming: ARMED, verifier });
  assert.equal(entry.admitted, false);
  assert.equal(entry.code, GATE_CODES.REJECTED_LEDGER_DISCONTINUOUS);
});

test("A24.4: no exit record at all is rejected", async () => {
  const entry = await evaluateEntryGate({ fromLedgerId: freshLedger(), payload: PAYLOAD, exitRecord: null, arming: ARMED, verifier });
  assert.equal(entry.code, GATE_CODES.REJECTED_NO_EXIT_RECORD);
});

// ─── Adversarial: tampered / discontinuous ledgers ─────────────────────────────

test("A24.4: a tampered middle record breaks the chain loudly", async () => {
  const ledger = freshLedger();
  await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: { a: 1 }, trace: CLEAN_TRACE, signer });
  const second = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: { c: 3 }, trace: CLEAN_TRACE, signer });

  // Tamper the middle record on disk (an attacker rewriting history).
  const path = stationLedgerPath(ledger);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  lines[1].payloadDigest = "0".repeat(64);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  const chain = verifyStationLedger(ledger);
  assert.equal(chain.continuous, false);
  assert.equal(chain.breakAt, 1);

  const entry = await evaluateEntryGate({ fromLedgerId: ledger, payload: PAYLOAD, exitRecord: second.record, arming: ARMED, verifier });
  assert.equal(entry.admitted, false);
  assert.equal(entry.code, GATE_CODES.REJECTED_LEDGER_DISCONTINUOUS);
});

// ─── Adversarial: arming + Tier-3 ──────────────────────────────────────────────

test("A24.4: an unarmed gate admits nothing (even a perfect lineage)", async () => {
  const ledger = freshLedger();
  const exit = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S1", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  const entry = await evaluateEntryGate({ fromLedgerId: ledger, payload: PAYLOAD, exitRecord: exit.record, arming: { armed: false, basis: "repo-authority divergence" }, verifier });
  assert.equal(entry.admitted, false);
  assert.equal(entry.code, GATE_CODES.REJECTED_UNARMED);
});

test("A24.4: a Tier-3 transition without a RELEASED stopgap record is rejected; a released one admits", async () => {
  const ledger = freshLedger();
  const exit = await evaluateExitGate({ stationLedgerId: ledger, stationId: "S6", payload: PAYLOAD, trace: CLEAN_TRACE, signer });
  const base = { fromLedgerId: ledger, payload: PAYLOAD, exitRecord: exit.record, arming: ARMED, verifier, tier: 3 };

  for (const stopgapRecord of [undefined, { outcome: { released: false, code: "rejected-by-j3rain" } }]) {
    const entry = await evaluateEntryGate({ ...base, stopgapRecord });
    assert.equal(entry.admitted, false);
    assert.equal(entry.code, GATE_CODES.REJECTED_TIER3_UNRELEASED);
  }
  const released = await evaluateEntryGate({ ...base, stopgapRecord: { outcome: { released: true, code: "released" } } });
  assert.equal(released.admitted, true);
});

// ─── Structure ─────────────────────────────────────────────────────────────────

test("A24.4: ledger ids are validated (no path riding through the id)", () => {
  assert.throws(() => stationLedgerPath("../escape"), /invalid station ledger id/);
  assert.throws(() => stationLedgerPath("W1/../../x"), /invalid station ledger id/);
  assert.doesNotThrow(() => stationLedgerPath("W-PARENT"));
  assert.doesNotThrow(() => stationLedgerPath("W7"));
});

test("A24.4: appendStationLedger chains seq + prevHash and seals selfHash", async () => {
  const ledger = freshLedger();
  const first = appendStationLedger(ledger, { kind: "exit", payloadDigest: "d1", signature: "s1" });
  const second = appendStationLedger(ledger, { kind: "exit", payloadDigest: "d2", signature: "s2" });
  assert.equal(first.seq, 0);
  assert.equal(first.prevHash, null);
  assert.equal(second.seq, 1);
  assert.equal(second.prevHash, first.selfHash);
  assert.equal(verifyStationLedger(ledger).continuous, true);
});
