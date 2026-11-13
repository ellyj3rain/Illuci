// core/governance/grants/manager.js
//
// CAP-1: composition — the operations the CLI (and later CAP-2 resolution)
// call. Every mutating act is SIGNED: the grant act at issue, the revocation
// act at revoke. Ports are injectable ({signer, verifier}) so tests run
// hermetic; defaults are the real ssh edge against the committed registry.

import {
  GrantValidationError,
  canonicalGrantPayload,
  canonicalRevocationPayload,
  isGrantActive,
  normalizeGrantInput,
} from "./registry.js";
import { appendGrant, findGrant, listGrants as storeList, markRevoked } from "./store.js";
import { createSshGrantSigner, createSshGrantVerifier } from "./signing.js";

/** Issue a grant: normalize → sign the canonical granting act → persist. */
export function issueGrant(input = {}, options = {}) {
  const signer = options.signer || createSshGrantSigner(options.signing);
  const record = normalizeGrantInput(input, options);
  const signature = signer.sign(canonicalGrantPayload(record));
  if (!signature || !String(signature).trim()) {
    throw new GrantValidationError("the signer returned an empty signature — refusing to persist an unsigned grant");
  }
  record.signature = { kind: signer.kind || "unknown", value: signature };
  return appendGrant(record, options);
}

/** Revoke a grant: the revoking act is signed exactly like the granting act. */
export function revokeGrant(id, { revokedBy, reason, ...options } = {}) {
  if (!revokedBy || !reason) throw new GrantValidationError("revocation requires revokedBy and reason (a recorded, attributed act)");
  const existing = findGrant(id, options);
  if (!existing) throw new GrantValidationError(`grant ${id} not found`);
  if (existing.revocation) throw new GrantValidationError(`grant ${id} is already revoked`);
  const signer = options.signer || createSshGrantSigner(options.signing);
  const revokedAt = (options.now || new Date()).toISOString();
  const payload = canonicalRevocationPayload({ grantId: id, revokedAt, revokedBy, reason });
  const signature = signer.sign(payload);
  if (!signature || !String(signature).trim()) {
    throw new GrantValidationError("the signer returned an empty signature — refusing an unsigned revocation");
  }
  return markRevoked(
    id,
    { revokedAt, revokedBy, reason, signature: { kind: signer.kind || "unknown", value: signature } },
    options,
  );
}

/** List grants (optionally filtered), each annotated with live activity. */
export function listGrants(filter = {}, options = {}) {
  return storeList(filter, options).map((g) => ({ ...g, active: isGrantActive(g, options) }));
}

/** Verify a record's signatures against the committed registry (grant act +
 *  revocation act when present). Returns coded results, never throws on a
 *  bad signature — a bad signature is a FINDING the caller must see. */
export function verifyGrant(record, options = {}) {
  const verifier = options.verifier || createSshGrantVerifier(options.signing);
  const principal = record?.grantor?.principal;
  const grantOk = Boolean(
    record?.signature?.value && principal && verifier.verify(canonicalGrantPayload(record), record.signature.value, principal),
  );
  let revocationOk = null;
  if (record?.revocation) {
    const { revokedAt, revokedBy, reason, signature } = record.revocation;
    revocationOk = Boolean(
      signature?.value &&
        verifier.verify(canonicalRevocationPayload({ grantId: record.id, revokedAt, revokedBy, reason }), signature.value, principal),
    );
  }
  return { grantSignature: grantOk ? "verified" : "FAILED", revocationSignature: record?.revocation ? (revocationOk ? "verified" : "FAILED") : "n/a" };
}

export default { issueGrant, revokeGrant, listGrants, verifyGrant };
