// core/governance/grants/resolve.js
//
// CAP-2 of the ratified capability-license arc: THE ALGEBRA. Resolution reads
// capability-grant RECORDS from the operator-authenticated store ONLY (R4 —
// no field consumed here may come from dispatch input; client-supplied
// capability claims are dead and recorded as spoof evidence by the classifier).
//
// Composition (R3, pinned as invariants — the adversarial review's requirements):
// - Seat layer: union(active grant-polarity records) MINUS union(active
//   deny-polarity records). Deny beats grant within the layer.
// - Outer layers (run, tenant) are STRICTLY deny-lists: an active deny-polarity
//   record withholds; a grant-polarity record at an outer layer can never
//   grant (outer layers only narrow) — it is IGNORED and flagged.
// - Three-valued per capability: "granted" | "denied" | "unset". An ABSENT
//   optional outer layer is unset = pass-through. A MANDATORY-but-absent run
//   permit denies everything (mandatoriness is explicit configuration, never
//   inferred).
// - The resolution is FROZEN at resolve time (no TOCTOU re-reads mid-dispatch).
//
// Enforcement mode (R6, the ratified sunset): "warn" until the arc's closing
// slice flips the floor — a would-be denial passes with a coded warning.
// "enforce" is the CAP-4 posture. An UNKNOWN capability denies in BOTH modes:
// the vocabulary is closed; warn-first never covers something ungoverned.

import { CAPABILITY_VOCABULARY, GRANT_SCHEMA, isGrantActive } from "./registry.js";
import { listGrants } from "./store.js";

export const CAPABILITY_RESOLUTION_SCHEMA = "illuci.governance.capability-resolution/1";

// [A40]/CAP-4 — THE RATIFIED FLOOR FLIP: the default enforcement mode is now
// "enforce" (hard deny-by-default for the closed vocabulary). The ratified
// sunset was a batch boundary — this batch. ILLUCI_CAPABILITY_MODE=warn is the
// operator's explicit, auditable rollback hatch (no batch needed to pull it);
// any other value is ignored (fail to the ratified default, never open).
export function capabilityEnforcementMode(env = process.env) {
  return env.ILLUCI_CAPABILITY_MODE === "warn" ? "warn" : "enforce";
}
export const DENIAL_CODE = "CAPABILITY_LICENSE_DENIED";
export const WARN_CODE = "CAPABILITY_LICENSE_WARN";

// The dead dispatch-input grant claims (the pre-CAP-2 spoof surface). The
// classifier records their presence as spoof evidence; nothing reads them.
export const DEAD_GRANT_CLAIM_FIELDS = Object.freeze(["computerUseGrant", "frontendGrant", "operatorGrant"]);

/** PURE: compose three-valued capability states from layer record sets. */
export function composeCapabilityStates(
  { seatRecords = [], runRecords = [], tenantRecords = [], runPermitMandatory = false, runPermitPresent = false } = {},
  { now = new Date() } = {},
) {
  const active = (records, polarity) =>
    records.filter((r) => r?.schema === GRANT_SCHEMA && (r.polarity || "grant") === polarity && isGrantActive(r, { now }));

  const ignoredOuterGrants = [
    ...active(runRecords, "grant").map((r) => ({ layer: "run", id: r.id })),
    ...active(tenantRecords, "grant").map((r) => ({ layer: "tenant", id: r.id })),
  ];

  const seatGranted = new Set(active(seatRecords, "grant").map((r) => r.capability));
  const seatDenied = new Set(active(seatRecords, "deny").map((r) => r.capability));
  const runDenied = new Set(active(runRecords, "deny").map((r) => r.capability));
  const tenantDenied = new Set(active(tenantRecords, "deny").map((r) => r.capability));

  const mandatoryPermitMissing = runPermitMandatory && !runPermitPresent;

  const capabilities = {};
  for (const cap of CAPABILITY_VOCABULARY) {
    let state = "unset";
    let via = [];
    if (seatGranted.has(cap) && !seatDenied.has(cap)) {
      state = "granted";
      via = active(seatRecords, "grant").filter((r) => r.capability === cap).map((r) => r.id);
    }
    if (seatDenied.has(cap)) state = "denied";
    if (runDenied.has(cap) || tenantDenied.has(cap)) state = "denied";
    if (mandatoryPermitMissing) state = "denied";
    capabilities[cap] = { state, via };
  }
  return { capabilities, ignoredOuterGrants, mandatoryPermitMissing };
}

/**
 * Resolve a subject's capability states from the STORE (the only source — R4)
 * and freeze the result. Layer keying: seat records by subjectId=seatId,
 * run records by subjectId=runId, tenant records by subjectId=tenantId.
 */
export function resolveCapabilityGrants(
  { seatId = null, runId = null, tenantId = null } = {},
  { now = new Date(), runPermitMandatory = process.env.ILLUCI_CAPABILITY_PERMIT_MANDATORY === "1", ...storeOpts } = {},
) {
  const seatRecords = seatId ? listGrants({ layer: "seat", subjectId: seatId }, storeOpts) : [];
  const runRecords = runId ? listGrants({ layer: "run", subjectId: runId }, storeOpts) : [];
  const tenantRecords = tenantId ? listGrants({ layer: "tenant", subjectId: tenantId }, storeOpts) : [];
  const composed = composeCapabilityStates(
    { seatRecords, runRecords, tenantRecords, runPermitMandatory, runPermitPresent: runRecords.length > 0 },
    { now },
  );
  const resolution = {
    schema: CAPABILITY_RESOLUTION_SCHEMA,
    subject: { seatId, runId, tenantId },
    resolvedAt: now.toISOString(),
    ...composed,
  };
  Object.freeze(resolution.capabilities);
  for (const v of Object.values(resolution.capabilities)) Object.freeze(v);
  return Object.freeze(resolution);
}

/**
 * PURE, deny-only (DR-112 inherited): may this resolution exercise `capability`?
 * Returns at most {allow:true} = "licensed — proceed to the mode gate"; it can
 * never approve or lower a gate. mode "warn" (the ratified transition) passes
 * a would-be denial WITH a coded warning; mode "enforce" (CAP-4) denies.
 * An unknown capability denies in BOTH modes.
 */
export function evaluateCapabilityGrant(capability, resolution, { mode = capabilityEnforcementMode() } = {}) {
  if (!CAPABILITY_VOCABULARY.includes(capability)) {
    return { allow: false, code: DENIAL_CODE, reason: `unknown capability "${capability}" — the vocabulary is closed; warn-first never covers the ungoverned` };
  }
  const state = resolution?.capabilities?.[capability]?.state ?? "unset";
  if (state === "granted") {
    return { allow: true, code: "licensed", reason: `capability "${capability}" granted (${(resolution.capabilities[capability].via || []).join(", ") || "record"}) — proceeds to the mode gate` };
  }
  const reason =
    state === "denied"
      ? `capability "${capability}" is DENIED for this subject (a deny record or a withholding outer layer)`
      : `capability "${capability}" has no grant record for this subject (unset)`;
  if (mode === "warn") {
    return { allow: true, warned: true, code: WARN_CODE, reason: `${reason} — passing under the ratified warn-first transition; the floor flips at the arc's closing slice` };
  }
  return { allow: false, code: DENIAL_CODE, reason };
}

/**
 * PURE [CAP-3, R1]: downward propagation — a child's exercisable set is the
 * INTERSECTION of its own resolution with its parent's: a parent without a
 * capability can never obtain it through delegation. denied dominates;
 * granted requires BOTH granted; anything else is unset.
 */
export function intersectResolutions(parent, child) {
  if (!parent) return child;
  if (!child) return parent;
  const capabilities = {};
  for (const cap of CAPABILITY_VOCABULARY) {
    const p = parent.capabilities?.[cap]?.state ?? "unset";
    const c = child.capabilities?.[cap]?.state ?? "unset";
    let state = "unset";
    if (p === "denied" || c === "denied") state = "denied";
    else if (p === "granted" && c === "granted") state = "granted";
    capabilities[cap] = {
      state,
      via: state === "granted" ? [...(parent.capabilities?.[cap]?.via || []), ...(child.capabilities?.[cap]?.via || [])] : [],
    };
    Object.freeze(capabilities[cap]);
  }
  Object.freeze(capabilities);
  return Object.freeze({
    schema: CAPABILITY_RESOLUTION_SCHEMA,
    subject: { ...(child.subject || {}), intersectedWithParent: parent.subject || true },
    resolvedAt: child.resolvedAt || parent.resolvedAt || null,
    capabilities,
    ignoredOuterGrants: [...(parent.ignoredOuterGrants || []), ...(child.ignoredOuterGrants || [])],
    mandatoryPermitMissing: Boolean(parent.mandatoryPermitMissing || child.mandatoryPermitMissing),
  });
}

/** PURE: which dead grant-claim fields does a dispatch input carry? (Spoof evidence.) */
export function detectSpoofClaims(input = {}) {
  const found = [];
  const explicit = input?.toolAffordancePosture && typeof input.toolAffordancePosture === "object" ? input.toolAffordancePosture : {};
  for (const f of DEAD_GRANT_CLAIM_FIELDS) {
    if (input?.[f] !== undefined) found.push(f);
    if (explicit?.[f] !== undefined) found.push(`toolAffordancePosture.${f}`);
  }
  return found;
}

export default {
  CAPABILITY_RESOLUTION_SCHEMA,
  DENIAL_CODE,
  WARN_CODE,
  DEAD_GRANT_CLAIM_FIELDS,
  capabilityEnforcementMode,
  composeCapabilityStates,
  resolveCapabilityGrants,
  evaluateCapabilityGrant,
  intersectResolutions,
  detectSpoofClaims,
};
