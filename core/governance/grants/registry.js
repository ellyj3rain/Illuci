// core/governance/grants/registry.js
//
// CAP-1 of the ratified capability-license arc (design/capability-license-design.md;
// DR-125 records the ratification): FIRST-CLASS capability-grant records — the
// operator chose the strong form: every grant is an independent record carrying
// grantor, timestamp, expiry, and revocation as DATA, SSH-signed against the
// committed allowed_signers registry (DR-121 infrastructure).
//
// This module is the PURE half: the record schema, the closed capability
// vocabulary, normalization/validation, canonical payloads (what signatures
// cover), and activity semantics. Persistence lives in store.js, the ssh edge
// in signing.js, composition in manager.js.
//
// R4 invariant (adversarial review, adopted): grant resolution reads records
// from the operator-authenticated store ONLY — no field consumed by resolution
// may be sourced from dispatch input. This registry validates records; it
// never accepts capability claims from a dispatch payload.

export const GRANT_SCHEMA = "illuci.governance.capability-grant/1";
export const GRANT_MANIFEST_SCHEMA = "illuci.governance.capability-grant-manifest/1";
export const GRANT_SIGNING_NAMESPACE = "illuci-capability-grant";

// The CLOSED capability vocabulary (spec §1) — source-derived affordances the
// system already distinguishes. Adding one = a reviewed source change citing
// DR-125. No dynamic or model-self-declared capabilities.
export const CAPABILITY_VOCABULARY = Object.freeze([
  "vision",
  "computer-use",
  "browser-frontend",
  "desktop-gui",
  "shell",
  "sandbox-exec",
]);

// Grant layers (spec §2): seat grants, run caps, tenant policy.
export const GRANT_LAYERS = Object.freeze(["seat", "run", "tenant"]);

export class GrantValidationError extends Error {
  constructor(message) {
    super(`capability-grant: ${message}`);
    this.name = "GrantValidationError";
    this.code = "GRANT_INVALID";
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GrantValidationError(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function requireIsoDate(value, field) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new GrantValidationError(`${field} must be an ISO-8601 datetime, got: ${value}`);
  return new Date(t).toISOString();
}

/** Deterministic id for a grant act (layer/subject/capability/time — collision-safe enough
 *  for a single-operator store; uniqueness is re-checked at append). */
export function deriveGrantId({ layer, subjectId, capability, grantedAt }) {
  const slug = `${layer}:${subjectId}:${capability}:${grantedAt}`.toLowerCase().replace(/[^a-z0-9:.-]+/g, "-");
  return `grant-${slug}`;
}

/**
 * Normalize + validate a grant request into an (unsigned) record.
 * Throws GrantValidationError on anything outside the closed shapes.
 */
export function normalizeGrantInput(input = {}, { now = new Date() } = {}) {
  const layer = requireString(input.layer, "layer");
  if (!GRANT_LAYERS.includes(layer)) {
    throw new GrantValidationError(`unknown layer "${layer}" — one of: ${GRANT_LAYERS.join(", ")}`);
  }
  const capability = requireString(input.capability, "capability");
  if (!CAPABILITY_VOCABULARY.includes(capability)) {
    throw new GrantValidationError(
      `unknown capability "${capability}" — the vocabulary is CLOSED (${CAPABILITY_VOCABULARY.join(", ")}); adding one is a reviewed source change (DR-125)`,
    );
  }
  const subjectId = requireString(input.subjectId, "subjectId");
  const grantorName = requireString(input.grantorName, "grantorName");
  const grantorPrincipal = requireString(input.grantorPrincipal, "grantorPrincipal");
  const grantedAt = requireIsoDate(input.grantedAt || now.toISOString(), "grantedAt");
  const expiresAt = input.expiresAt == null ? null : requireIsoDate(input.expiresAt, "expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(grantedAt)) {
    throw new GrantValidationError("expiresAt must be after grantedAt");
  }
  // [CAP-2] polarity: "grant" (default) or "deny" — the R3 within-layer deny
  // primitive (deny beats grant) and the outer layers' only effective voice.
  const polarity = input.polarity == null ? "grant" : String(input.polarity);
  if (!["grant", "deny"].includes(polarity)) {
    throw new GrantValidationError(`unknown polarity "${polarity}" — grant or deny`);
  }
  return {
    schema: GRANT_SCHEMA,
    id: input.id || deriveGrantId({ layer, subjectId, capability, grantedAt }),
    layer,
    subject: { id: subjectId },
    capability,
    polarity,
    grantor: { name: grantorName, principal: grantorPrincipal },
    grantedAt,
    expiresAt,
    revocation: null,
    signature: null, // attached by the manager after signing the canonical payload
  };
}

/** The exact byte-string a GRANT signature covers: the granting act, nothing mutable.
 *  [CAP-2] polarity joins the payload ONLY when "deny" — default-grant records keep
 *  the CAP-1 payload shape byte-for-byte, so records signed before polarity existed
 *  still verify (additive schema evolution, never a silent re-sign). */
export function canonicalGrantPayload(record) {
  const payload = {
    schema: record.schema,
    id: record.id,
    layer: record.layer,
    subject: record.subject,
    capability: record.capability,
    grantor: record.grantor,
    grantedAt: record.grantedAt,
    expiresAt: record.expiresAt,
  };
  if ((record.polarity || "grant") === "deny") payload.polarity = "deny";
  return JSON.stringify(payload);
}

/** The exact byte-string a REVOCATION signature covers: the revoking act. */
export function canonicalRevocationPayload({ grantId, revokedAt, revokedBy, reason }) {
  return JSON.stringify({ schema: `${GRANT_SCHEMA}#revocation`, grantId, revokedAt, revokedBy, reason });
}

/** Is this grant exercisable at `now`? Revocation beats expiry beats everything.
 *  Revocation semantics (ratified): effective at NEXT resolution — session-pinned
 *  resolution snapshots are the consumer's concern (CAP-2), not the record's. */
export function isGrantActive(record, { now = new Date() } = {}) {
  if (!record || record.schema !== GRANT_SCHEMA) return false;
  if (record.revocation) return false;
  if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) return false;
  return true;
}

/** One-line human summary (CLI list). */
export function summarizeGrant(record, { now = new Date() } = {}) {
  const state = record.revocation
    ? `REVOKED ${record.revocation.revokedAt}`
    : record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()
      ? `EXPIRED ${record.expiresAt}`
      : "active";
  return `${record.id}  ${record.layer}/${record.subject.id}  ${record.capability}  by ${record.grantor.name}  ${record.grantedAt}  [${state}]`;
}

export default {
  GRANT_SCHEMA,
  GRANT_MANIFEST_SCHEMA,
  GRANT_SIGNING_NAMESPACE,
  CAPABILITY_VOCABULARY,
  GRANT_LAYERS,
  GrantValidationError,
  deriveGrantId,
  normalizeGrantInput,
  canonicalGrantPayload,
  canonicalRevocationPayload,
  isGrantActive,
  summarizeGrant,
};
