// illuci/core/governance/belt/transition-gate.js
//
// [A24.4] The per-transition entry/exit gate — the warehouse belt's ONE
// load-bearing new contract (the factory's slice 4; DR-115, [A27] D3).
//
// A payload moves station S(N-1) → S(N) only through this contract:
//
//   EXIT  (at S(N-1)): the station's TAOR run outcome is evaluated; on pass,
//         a signed exit record is appended to the station's [W(N-1)] ledger.
//         The gate REQUESTS the signature from the tenant boundary (an
//         injected signer port tied to the Illuci Runtime per-tenant identity) —
//         it never holds key material and never signs anything itself.
//
//   ENTRY (at S(N)): fail-closed verification that
//         1. the gate is ARMED (an arming fact rooted in the repo-authority
//            guard + tenant identity — supplied, never assumed),
//         2. the payload cryptographically proves its signed exit from
//            S(N-1): the exit record's signature verifies at the tenant
//            boundary AND the [W(N-1)] ledger's hash chain is CONTINUOUS
//            through that record (ledger lineage continuity),
//         3. the TAOR outcome invariants hold (an honest halt is an honest
//            rejection carrying the run's own haltReason),
//         4. a Tier-3 transition carries a RELEASED Tier-3 stopgap record
//            (the slice-3 chain is consumed, not reimplemented).
//
// [Wn] ledgers are append-only, hash-chained jsonl files under the governance
// data kind: every record carries prevHash + its own selfHash, so a tampered
// or truncated middle breaks the chain loudly at verification.
//
// Fail-closed by construction: unarmed, unsigned, tampered, discontinuous,
// halted, or unreleased-Tier-3 transitions all resolve to a loud REJECTED
// verdict. There is no fail-open path and no bypass input.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { runtimeDataPath } from "../../data/paths.js";

export const TRANSITION_GATE_SCHEMA = "illuci.governance.belt-transition/1";

/** Terminal gate codes (every one is recorded on the verdict). */
export const GATE_CODES = Object.freeze({
  EXIT_SIGNED: "exit-signed",
  ENTRY_ADMITTED: "entry-admitted",
  REJECTED_UNARMED: "gate-unarmed",
  REJECTED_TAOR_HALTED: "taor-run-halted",
  REJECTED_TAOR_GATE_FAILED: "taor-gate-failed",
  REJECTED_NO_EXIT_RECORD: "no-signed-exit-record",
  REJECTED_BAD_SIGNATURE: "exit-signature-invalid",
  REJECTED_LEDGER_DISCONTINUOUS: "ledger-lineage-broken",
  REJECTED_PAYLOAD_MISMATCH: "payload-digest-mismatch",
  REJECTED_TIER3_UNRELEASED: "tier3-stopgap-not-released",
  REJECTED_SIGNER_FAILED: "tenant-signer-failed",
});

/** Recursively sort object keys so semantically-equal payloads digest equal. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/** Canonical sha256 digest of a payload (stable across key order). */
export function payloadDigest(payload) {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload ?? {}))).digest("hex");
}

function recordHash(record) {
  const { selfHash, ...rest } = record;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export function stationLedgerPath(stationLedgerId) {
  if (!/^W(-PARENT|[0-9]+)$/.test(String(stationLedgerId))) {
    throw new Error(`invalid station ledger id "${stationLedgerId}" (expected W0..Wn or W-PARENT)`);
  }
  return runtimeDataPath("governance", `warehouse/${stationLedgerId}/ledger.jsonl`);
}

export function readStationLedger(stationLedgerId) {
  const path = stationLedgerPath(stationLedgerId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Append a hash-chained record to a station ledger. prevHash binds each record
 * to its predecessor; selfHash seals the record. Append-only by construction.
 */
export function appendStationLedger(stationLedgerId, entry) {
  const existing = readStationLedger(stationLedgerId);
  const prevHash = existing.length > 0 ? existing[existing.length - 1].selfHash : null;
  const record = { ...entry, seq: existing.length, prevHash, at: new Date().toISOString() };
  record.selfHash = recordHash(record);
  const path = stationLedgerPath(stationLedgerId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return record;
}

/**
 * Verify a station ledger's hash-chain continuity. A tampered, reordered, or
 * truncated-in-the-middle ledger breaks loudly here.
 * @returns {{continuous: boolean, breakAt: number|null, length: number}}
 */
export function verifyStationLedger(stationLedgerId) {
  const records = readStationLedger(stationLedgerId);
  let prev = null;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.prevHash !== (prev ? prev.selfHash : null)) return { continuous: false, breakAt: i, length: records.length };
    if (record.selfHash !== recordHash(record)) return { continuous: false, breakAt: i, length: records.length };
    if (record.seq !== i) return { continuous: false, breakAt: i, length: records.length };
    prev = record;
  }
  return { continuous: true, breakAt: null, length: records.length };
}

function verdict(admitted, code, detail, extra = {}) {
  return {
    schema: TRANSITION_GATE_SCHEMA,
    admitted,
    code,
    detail: detail || null,
    at: new Date().toISOString(),
    ...extra,
  };
}

/** The TAOR-outcome invariants an exiting run must satisfy (honest halts are honest rejections). */
function taorOutcomeErrors(trace) {
  if (!trace || typeof trace !== "object") return { code: GATE_CODES.REJECTED_TAOR_HALTED, detail: "no run trace supplied" };
  if (trace.halted === true) {
    return { code: GATE_CODES.REJECTED_TAOR_HALTED, detail: `the station run halted: ${trace.haltReason || "(unreported reason)"}` };
  }
  const failedGate = Object.entries(trace.phases || {}).find(([, phase]) => phase?.gateStatus === "fail");
  if (failedGate) {
    return { code: GATE_CODES.REJECTED_TAOR_GATE_FAILED, detail: `phase "${failedGate[0]}" failed its content gate: ${failedGate[1].gateReason || "(unreported)"}` };
  }
  return null;
}

/**
 * EXIT gate at S(N-1): evaluate the TAOR outcome and, on pass, append a
 * SIGNED exit record to the station's ledger. The signature comes from the
 * injected tenant-boundary signer — the gate holds no keys.
 *
 * @param {{
 *   stationLedgerId: string,          // e.g. "W2"
 *   stationId: string,                // e.g. "S2-convergence"
 *   payload: object,                  // the artifact moving down the belt
 *   trace: object,                    // the station's TAOR run trace
 *   signer: { tenantId: string, sign: (digest: string) => Promise<{signature: string, keyId?: string}> },
 * }} input
 */
export async function evaluateExitGate(input = {}) {
  const { stationLedgerId, stationId, payload, trace, signer } = input;
  const taorError = taorOutcomeErrors(trace);
  if (taorError) return verdict(false, taorError.code, taorError.detail);
  if (!signer || typeof signer.sign !== "function" || !signer.tenantId) {
    return verdict(false, GATE_CODES.REJECTED_SIGNER_FAILED, "no tenant-boundary signer supplied; the gate cannot sign and fails closed");
  }
  const digest = payloadDigest(payload ?? {});
  let signed;
  try {
    signed = await signer.sign(digest);
  } catch (err) {
    return verdict(false, GATE_CODES.REJECTED_SIGNER_FAILED, String(err?.message || err));
  }
  if (!signed || typeof signed.signature !== "string" || signed.signature.length === 0) {
    return verdict(false, GATE_CODES.REJECTED_SIGNER_FAILED, "the tenant boundary returned no signature");
  }
  const record = appendStationLedger(stationLedgerId, {
    schema: TRANSITION_GATE_SCHEMA,
    kind: "exit",
    stationId,
    tenantId: signer.tenantId,
    payloadDigest: digest,
    signature: signed.signature,
    keyId: signed.keyId || null,
  });
  return verdict(true, GATE_CODES.EXIT_SIGNED, null, { record });
}

/**
 * ENTRY gate at S(N): fail-closed admission. The payload must prove its
 * signed exit from S(N-1) via that station's ledger (signature verifies at
 * the tenant boundary; hash chain continuous THROUGH the exit record), the
 * gate must be armed, the TAOR invariants must hold, and a Tier-3 transition
 * must carry a RELEASED stopgap record.
 *
 * @param {{
 *   fromLedgerId: string,             // the [W(N-1)] ledger id
 *   payload: object,
 *   exitRecord: object,               // the signed exit record presented by the payload
 *   arming: { armed: boolean, basis?: string },   // repo-authority + tenant-identity rooted fact
 *   verifier: { verify: (digest: string, signature: string, keyId?: string|null) => Promise<boolean> },
 *   tier?: number,                    // the transition's tier (3 = consequential, e.g. the promotion airlock)
 *   stopgapRecord?: object,           // the slice-3 chain record for Tier-3 transitions
 * }} input
 */
export async function evaluateEntryGate(input = {}) {
  const { fromLedgerId, payload, exitRecord, arming, verifier, tier, stopgapRecord } = input;

  if (!arming || arming.armed !== true) {
    return verdict(false, GATE_CODES.REJECTED_UNARMED, `the entry gate is not armed${arming?.basis ? ` (basis: ${arming.basis})` : ""}`);
  }
  if (!exitRecord || typeof exitRecord !== "object" || exitRecord.kind !== "exit") {
    return verdict(false, GATE_CODES.REJECTED_NO_EXIT_RECORD, "the payload presents no signed exit record");
  }

  // Ledger lineage continuity: the chain must be continuous AND contain this
  // exact record (same selfHash at the same seq).
  const chain = verifyStationLedger(fromLedgerId);
  if (!chain.continuous) {
    return verdict(false, GATE_CODES.REJECTED_LEDGER_DISCONTINUOUS, `the ${fromLedgerId} ledger chain breaks at record ${chain.breakAt}`);
  }
  const ledger = readStationLedger(fromLedgerId);
  const anchored = ledger.find((record) => record.selfHash === exitRecord.selfHash && record.seq === exitRecord.seq);
  if (!anchored) {
    return verdict(false, GATE_CODES.REJECTED_LEDGER_DISCONTINUOUS, "the presented exit record is not anchored in the station ledger");
  }

  // The payload is the one that was signed.
  const digest = payloadDigest(payload ?? {});
  if (digest !== anchored.payloadDigest) {
    return verdict(false, GATE_CODES.REJECTED_PAYLOAD_MISMATCH, "the payload does not match the signed exit digest");
  }

  // The signature verifies at the tenant boundary (the gate holds no keys).
  if (!verifier || typeof verifier.verify !== "function") {
    return verdict(false, GATE_CODES.REJECTED_BAD_SIGNATURE, "no tenant-boundary verifier supplied; the gate fails closed");
  }
  let signatureOk;
  try {
    signatureOk = await verifier.verify(anchored.payloadDigest, anchored.signature, anchored.keyId ?? null);
  } catch (err) {
    return verdict(false, GATE_CODES.REJECTED_BAD_SIGNATURE, String(err?.message || err));
  }
  if (signatureOk !== true) {
    return verdict(false, GATE_CODES.REJECTED_BAD_SIGNATURE, "the exit signature does not verify against the tenant identity");
  }

  // Tier-3 transitions consume the slice-3 chain: released or rejected.
  if (tier === 3) {
    if (stopgapRecord?.outcome?.released !== true) {
      return verdict(false, GATE_CODES.REJECTED_TIER3_UNRELEASED, "a Tier-3 transition requires a RELEASED Tier-3 stopgap record");
    }
  }

  return verdict(true, GATE_CODES.ENTRY_ADMITTED, null, { anchoredSeq: anchored.seq });
}

export default {
  TRANSITION_GATE_SCHEMA,
  GATE_CODES,
  payloadDigest,
  stationLedgerPath,
  readStationLedger,
  appendStationLedger,
  verifyStationLedger,
  evaluateExitGate,
  evaluateEntryGate,
};
