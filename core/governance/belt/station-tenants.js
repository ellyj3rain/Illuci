// illuci/core/governance/belt/station-tenants.js
//
// [A24.6] Stations as REAL runtime tenants — the factory's live-provisioning slice
// (the batch catalog's Lane 2; the step past [A24.5]'s dry-run harness).
//
// [A24.5] proved the belt with PROVING-GROUND identities (createDryRunTenantIdentities:
// ephemeral in-memory HMAC keys). This module replaces that harness with the runtime's
// own tenant substrate, composing three shipped surfaces — it reimplements none:
//
//   - the managed-connections store ([A22.3]): each station S0–S7 PROVISIONS as a
//     tenant with a registered signing-identity connection record (visible through
//     listTenantConnections and GET /runtime/connections). The record carries an
//     OPAQUE ref only — assertNoRawSecretMaterial guards the store; the key never
//     enters it.
//   - a per-tenant signing key held at the tenant boundary: 32 random bytes under the
//     governance data kind (warehouse/identities/<tenantId>.key, mode 0600) — beside
//     the [Wn] ledgers, resolved only inside signerFor/verify. The gate still holds
//     no key material ([A24.4] contract).
//   - the repo-authority gate ([A20.2], divergence-only): belt ARMING roots in
//     checkRepoAuthority + the station's live registration, per the ratified plan
//     ("arming on repo-authority + tenant identity"). Fail-closed on probe failure.
//
// REVOCATION IS LIVE GOVERNANCE: revoking a station's connection record kills its belt
// identity — its exit can no longer sign, its prior signatures no longer verify, and
// its entry no longer arms. The registry is the identity's on/off switch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { runtimeDataPath } from "../../data/paths.js";
import { addConnection, listTenantConnections } from "../../connections/manager.js";
import { checkRepoAuthority } from "../gitops/repo-authority-gate.js";

export const STATION_SIGNING_PROVIDER = "warehouse.station-signing";
export const STATION_IDENTITY_SCHEMA = "illuci.governance.station-tenant-identity/1";

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNUSABLE_STATUS = /revok|block|pending|unbound|invalid/i;

/** The tenant-boundary key leaf for one station tenant (validated against path-riding). */
export function stationKeyPath(tenantId) {
  if (typeof tenantId !== "string" || !TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid station tenant id "${tenantId}"`);
  }
  return runtimeDataPath("governance", `warehouse/identities/${tenantId}.key`);
}

/** The registration id a station tenant's signing connection carries. */
export function stationConnectionId(tenantId) {
  return `warehouse-signing-${tenantId}`;
}

function ensureStationKey(tenantId) {
  const path = stationKeyPath(tenantId);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString("hex"), { encoding: "utf8", mode: 0o600 });
  }
  return path;
}

function readStationKey(tenantId) {
  const path = stationKeyPath(tenantId);
  if (!existsSync(path)) return null;
  const key = readFileSync(path, "utf8").trim();
  return key.length > 0 ? key : null;
}

/** The station's live signing registration (prompt-safe view), or null when absent. */
export function stationRegistration(tenantId, options = {}) {
  const records = listTenantConnections(tenantId, options);
  return records.find((c) => c.connectionId === stationConnectionId(tenantId) && c.provider === STATION_SIGNING_PROVIDER) || null;
}

function registrationUsable(tenantId, options = {}) {
  const reg = stationRegistration(tenantId, options);
  if (!reg) return { usable: false, reason: "unregistered" };
  if (reg.status && UNUSABLE_STATUS.test(reg.status)) return { usable: false, reason: `status:${reg.status}` };
  return { usable: true, reason: `status:${reg.status || "configured"}` };
}

/**
 * Provision ONE station as a runtime tenant: ensure its boundary key exists and upsert
 * its signing-identity connection record (idempotent — re-provisioning preserves the key
 * and updates the same connectionId). The record's secretRef is an opaque pointer the
 * generic resolver does not dereference; the key itself never enters the store.
 */
export function provisionStationTenant(station, options = {}) {
  if (!station || typeof station.tenantId !== "string") {
    throw new Error("provisionStationTenant: station with a tenantId is required");
  }
  const keyPath = ensureStationKey(station.tenantId);
  const connection = addConnection(
    {
      connectionId: stationConnectionId(station.tenantId),
      provider: STATION_SIGNING_PROVIDER,
      tenant: station.tenantId,
      authMethod: "api-key",
      secretRef: `warehouse-key:${station.tenantId}`,
      metadata: {
        schema: STATION_IDENTITY_SCHEMA,
        stationId: station.id,
        ledgerId: station.ledgerId,
        role: "belt-signing-identity",
      },
    },
    options,
  );
  return { tenantId: station.tenantId, stationId: station.id, connection, keyPath };
}

/** Provision EVERY station of a belt as a runtime tenant. Idempotent. */
export function provisionWarehouseStationTenants(belt, options = {}) {
  return { schema: STATION_IDENTITY_SCHEMA, tenants: belt.stations.map((s) => provisionStationTenant(s, options)) };
}

function hmac(key, digest) {
  return createHmac("sha256", key).update(String(digest)).digest("hex");
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * LIVE tenant-boundary identities for a belt — the drop-in replacement for the [A24.5]
 * dry-run harness (same signerFor/verifier interface `dryRunBelt` and `advanceStation`
 * consume). Signing requires a USABLE live registration AND the boundary key; both are
 * re-checked at verify time too, so a revoked station's history stops verifying.
 */
export function liveTenantIdentities(belt, options = {}) {
  const tenantIds = new Set(belt.stations.map((s) => s.tenantId));
  return {
    kind: "runtime-tenant-identity",
    signerFor(tenantId) {
      if (!tenantIds.has(tenantId)) throw new Error(`station tenants: "${tenantId}" is not a station of this belt`);
      const usable = registrationUsable(tenantId, options);
      if (!usable.usable) throw new Error(`station tenants: "${tenantId}" has no usable signing registration (${usable.reason}) — provision or un-revoke it`);
      const key = readStationKey(tenantId);
      if (!key) throw new Error(`station tenants: "${tenantId}" has no boundary key — provision it`);
      return { tenantId, sign: async (digest) => ({ signature: hmac(key, digest), keyId: tenantId }) };
    },
    verifier: {
      verify: async (digest, signature, keyId) => {
        if (typeof keyId !== "string" || !tenantIds.has(keyId)) return false;
        if (!registrationUsable(keyId, options).usable) return false;
        const key = readStationKey(keyId);
        if (!key) return false;
        return safeEqualHex(hmac(key, digest), signature);
      },
    },
  };
}

/**
 * The belt's ARMING fact, rooted per the ratified plan: the repo-authority verdict
 * (divergence-only gate — a real split-brain disarms) AND the entering station's live
 * tenant registration. Supplied to evaluateEntryGate as `arming`; never assumed.
 * Fail-closed: a probe failure or missing registration disarms with an honest basis.
 *
 * @param {{tenantId: string, cwd?: string, probe?: Function, options?: object}} input
 * @returns {{armed: boolean, basis: string}}
 */
export function armStationEntry(input = {}) {
  const { tenantId, cwd, options = {} } = input;
  const probe = typeof input.probe === "function" ? input.probe : checkRepoAuthority;
  let authority;
  try {
    authority = probe({ cwd, trigger: "pre-dispatch" });
  } catch (err) {
    return { armed: false, basis: `repo-authority probe failed: ${String(err?.message || err)}` };
  }
  const registration = registrationUsable(tenantId, options);
  const armed = authority?.allowed === true && registration.usable === true;
  return {
    armed,
    basis: `repo-authority:${authority?.code || "unknown"}/${authority?.decision || "unknown"}; tenant:${tenantId}:${registration.usable ? "registered" : registration.reason}`,
  };
}

export default {
  STATION_SIGNING_PROVIDER,
  STATION_IDENTITY_SCHEMA,
  stationKeyPath,
  stationConnectionId,
  stationRegistration,
  provisionStationTenant,
  provisionWarehouseStationTenants,
  liveTenantIdentities,
  armStationEntry,
};
