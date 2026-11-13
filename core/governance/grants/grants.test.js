// node:test — CAP-1 capability-grant records (DR-125): first-class, signed,
// append-only records; closed vocabulary; revocation as a signed act.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  CAPABILITY_VOCABULARY,
  GRANT_LAYERS,
  GRANT_SIGNING_NAMESPACE,
  GrantValidationError,
  canonicalGrantPayload,
  isGrantActive,
  normalizeGrantInput,
} from "./registry.js";
import { issueGrant, listGrants, revokeGrant, verifyGrant } from "./manager.js";
import { sshKeygenAvailable, createSshGrantSigner, createSshGrantVerifier } from "./signing.js";

const FAKE_SIGNER = { kind: "fake", sign: (payload) => `FAKESIG(${payload.length})` };
const GRANT_INPUT = {
  layer: "seat",
  subjectId: "seat-red",
  capability: "vision",
  grantorName: "operator",
  grantorPrincipal: "contributor@example.com",
};

function tempManifest() {
  const dir = mkdtempSync(join(tmpdir(), "illuci-grants-test-"));
  return { dir, manifestFile: join(dir, "grants.json") };
}

// ── registry (pure) ───────────────────────────────────────────────────────────

test("the capability vocabulary is CLOSED — an unknown capability throws, listing the vocabulary", () => {
  assert.throws(
    () => normalizeGrantInput({ ...GRANT_INPUT, capability: "telepathy" }),
    (e) => e instanceof GrantValidationError && e.message.includes("CLOSED"),
  );
  assert.equal(CAPABILITY_VOCABULARY.length, 6);
  assert.ok(Object.isFrozen(CAPABILITY_VOCABULARY));
});

test("unknown layer / missing subject / missing grantor all throw", () => {
  assert.throws(() => normalizeGrantInput({ ...GRANT_INPUT, layer: "galaxy" }), GrantValidationError);
  assert.throws(() => normalizeGrantInput({ ...GRANT_INPUT, subjectId: "" }), GrantValidationError);
  assert.throws(() => normalizeGrantInput({ ...GRANT_INPUT, grantorPrincipal: undefined }), GrantValidationError);
  assert.deepEqual([...GRANT_LAYERS], ["seat", "run", "tenant"]);
});

test("expiry must postdate the grant; activity honors expiry and revocation", () => {
  const now = new Date("2026-07-04T10:00:00Z");
  assert.throws(
    () => normalizeGrantInput({ ...GRANT_INPUT, grantedAt: "2026-07-04T10:00:00Z", expiresAt: "2026-07-04T09:00:00Z" }),
    GrantValidationError,
  );
  const rec = normalizeGrantInput({ ...GRANT_INPUT, grantedAt: now.toISOString(), expiresAt: "2026-07-05T10:00:00Z" }, { now });
  assert.equal(isGrantActive(rec, { now }), true);
  assert.equal(isGrantActive(rec, { now: new Date("2026-07-06T00:00:00Z") }), false, "expired");
  assert.equal(isGrantActive({ ...rec, revocation: { revokedAt: "x" } }, { now }), false, "revoked beats everything");
});

test("the canonical payload is deterministic and excludes mutable state (revocation, signature)", () => {
  const now = new Date("2026-07-04T10:00:00Z");
  const a = normalizeGrantInput({ ...GRANT_INPUT, grantedAt: now.toISOString() }, { now });
  const b = normalizeGrantInput({ ...GRANT_INPUT, grantedAt: now.toISOString() }, { now });
  assert.equal(canonicalGrantPayload(a), canonicalGrantPayload(b));
  assert.equal(canonicalGrantPayload({ ...a, revocation: { x: 1 }, signature: { y: 2 } }), canonicalGrantPayload(a));
});

// ── manager + store (hermetic via fake signer + temp manifest) ────────────────

test("issue → list → revoke roundtrip: signed acts, append-only, revocation attributed", () => {
  const { dir, manifestFile } = tempManifest();
  try {
    const rec = issueGrant(GRANT_INPUT, { signer: FAKE_SIGNER, manifestFile });
    assert.ok(rec.signature.value.startsWith("FAKESIG("));
    assert.equal(rec.layer, "seat");

    const listed = listGrants({ subjectId: "seat-red" }, { manifestFile });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].active, true);

    const revoked = revokeGrant(rec.id, { revokedBy: "operator", reason: "test rotation", signer: FAKE_SIGNER, manifestFile });
    assert.equal(revoked.revocation.reason, "test rotation");
    assert.ok(revoked.revocation.signature.value.startsWith("FAKESIG("));
    assert.equal(listGrants({}, { manifestFile })[0].active, false);

    // double-revoke blocks; duplicate id blocks (append-only, never re-issued in place)
    assert.throws(() => revokeGrant(rec.id, { revokedBy: "x", reason: "y", signer: FAKE_SIGNER, manifestFile }), GrantValidationError);
    assert.throws(() => issueGrant({ ...GRANT_INPUT, grantedAt: rec.grantedAt, id: rec.id }, { signer: FAKE_SIGNER, manifestFile }), GrantValidationError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty signature refuses to persist (no unsigned grant ever lands)", () => {
  const { dir, manifestFile } = tempManifest();
  try {
    assert.throws(
      () => issueGrant(GRANT_INPUT, { signer: { kind: "broken", sign: () => "" }, manifestFile }),
      (e) => e instanceof GrantValidationError && e.message.includes("unsigned"),
    );
    assert.equal(listGrants({}, { manifestFile }).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation without attribution (revokedBy/reason) refuses", () => {
  const { dir, manifestFile } = tempManifest();
  try {
    const rec = issueGrant(GRANT_INPUT, { signer: FAKE_SIGNER, manifestFile });
    assert.throws(() => revokeGrant(rec.id, { signer: FAKE_SIGNER, manifestFile }), GrantValidationError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real ssh edge (integration; skipped when ssh-keygen is absent) ────────

test("REAL ssh sign→verify roundtrip with a throwaway key; a tampered payload FAILS", { skip: !sshKeygenAvailable() }, () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-grants-ssh-"));
  try {
    const keyPath = join(dir, "throwaway");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
    const pub = execFileSync("ssh-keygen", ["-y", "-f", keyPath], { encoding: "utf8" }).trim();
    const principal = "test@grants.local";
    const allowedSigners = join(dir, "allowed_signers");
    execFileSync("node", ["-e", `require('fs').writeFileSync(${JSON.stringify(allowedSigners)}, ${JSON.stringify(`${principal} ${pub}\n`)})`]);

    const signer = createSshGrantSigner({ privateKeyPath: keyPath });
    const verifier = createSshGrantVerifier({ allowedSignersPath: allowedSigners });
    const manifestFile = join(dir, "grants.json");

    const rec = issueGrant({ ...GRANT_INPUT, grantorPrincipal: principal }, { signer, manifestFile });
    assert.match(rec.signature.value, /BEGIN SSH SIGNATURE/);
    assert.deepEqual(verifyGrant(rec, { verifier }), { grantSignature: "verified", revocationSignature: "n/a" });

    // tamper: a different capability under the same signature must FAIL verification
    const tampered = { ...rec, capability: "computer-use" };
    assert.equal(verifyGrant(tampered, { verifier }).grantSignature, "FAILED");

    // revocation act signs + verifies too
    const revoked = revokeGrant(rec.id, { revokedBy: principal, reason: "roundtrip", signer, manifestFile });
    assert.equal(verifyGrant(revoked, { verifier }).revocationSignature, "verified");
    assert.equal(GRANT_SIGNING_NAMESPACE, "illuci-capability-grant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
