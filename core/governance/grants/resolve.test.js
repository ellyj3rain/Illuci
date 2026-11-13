// node:test — CAP-2: the capability algebra. The R3 composition invariants and
// the R4 registry-only rule, each adversarial-review seam as a named case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeCapabilityStates,
  resolveCapabilityGrants,
  evaluateCapabilityGrant,
  capabilityEnforcementMode,
  detectSpoofClaims,
  DENIAL_CODE,
  WARN_CODE,
} from "./resolve.js";
import { issueGrant } from "./manager.js";
import { GRANT_SCHEMA } from "./registry.js";

const FAKE_SIGNER = { kind: "fake", sign: (p) => `FAKESIG(${p.length})` };
const NOW = new Date("2026-07-04T12:00:00Z");

function rec(layer, subjectId, capability, extra = {}) {
  return {
    schema: GRANT_SCHEMA,
    id: `g-${layer}-${capability}-${extra.polarity || "grant"}`,
    layer,
    subject: { id: subjectId },
    capability,
    grantor: { name: "op", principal: "x@noreply" },
    grantedAt: "2026-07-04T10:00:00Z",
    expiresAt: null,
    revocation: null,
    signature: { kind: "fake", value: "s" },
    ...extra,
  };
}

// ── R3: within-layer deny beats grant ─────────────────────────────────────────

test("seat layer: union(grants) minus union(denies) — deny beats grant", () => {
  const { capabilities } = composeCapabilityStates(
    { seatRecords: [rec("seat", "s1", "vision"), rec("seat", "s1", "vision", { polarity: "deny" }), rec("seat", "s1", "shell")] },
    { now: NOW },
  );
  assert.equal(capabilities.vision.state, "denied");
  assert.equal(capabilities.shell.state, "granted");
  assert.equal(capabilities["computer-use"].state, "unset");
});

// ── R3: outer layers are strictly deny-lists ──────────────────────────────────

test("outer layers only narrow: a run/tenant GRANT record can never grant — ignored and flagged", () => {
  const r = composeCapabilityStates(
    { seatRecords: [], runRecords: [rec("run", "r1", "vision")], tenantRecords: [rec("tenant", "t1", "shell")] },
    { now: NOW },
  );
  assert.equal(r.capabilities.vision.state, "unset", "an outer grant must NOT grant");
  assert.equal(r.capabilities.shell.state, "unset");
  assert.equal(r.ignoredOuterGrants.length, 2);
});

test("outer deny withholds what the seat granted (intersection across layers)", () => {
  const { capabilities } = composeCapabilityStates(
    { seatRecords: [rec("seat", "s1", "vision")], runRecords: [rec("run", "r1", "vision", { polarity: "deny" })] },
    { now: NOW },
  );
  assert.equal(capabilities.vision.state, "denied");
});

// ── R3: unset = pass-through; mandatory-but-absent permit denies everything ──

test("absent optional outer layers are unset = pass-through; a MANDATORY absent permit denies all", () => {
  const open = composeCapabilityStates({ seatRecords: [rec("seat", "s1", "vision")] }, { now: NOW });
  assert.equal(open.capabilities.vision.state, "granted");

  const strict = composeCapabilityStates(
    { seatRecords: [rec("seat", "s1", "vision")], runPermitMandatory: true, runPermitPresent: false },
    { now: NOW },
  );
  assert.equal(strict.capabilities.vision.state, "denied");
  assert.equal(strict.mandatoryPermitMissing, true);
});

// ── revoked/expired records do not count ─────────────────────────────────────

test("revoked and expired records are inert in composition", () => {
  const { capabilities } = composeCapabilityStates(
    {
      seatRecords: [
        rec("seat", "s1", "vision", { revocation: { revokedAt: "2026-07-04T11:00:00Z" } }),
        rec("seat", "s1", "shell", { expiresAt: "2026-07-04T11:00:00Z" }),
      ],
    },
    { now: NOW },
  );
  assert.equal(capabilities.vision.state, "unset");
  assert.equal(capabilities.shell.state, "unset");
});

// ── R4: store-only resolution, frozen ─────────────────────────────────────────

test("resolveCapabilityGrants reads the STORE only and returns a FROZEN resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-resolve-test-"));
  const manifestFile = join(dir, "grants.json");
  try {
    issueGrant(
      { layer: "seat", subjectId: "seat-red", capability: "vision", grantorName: "op", grantorPrincipal: "x@noreply" },
      { signer: FAKE_SIGNER, manifestFile },
    );
    const res = resolveCapabilityGrants({ seatId: "seat-red" }, { manifestFile, now: NOW });
    assert.equal(res.capabilities.vision.state, "granted");
    assert.ok(Object.isFrozen(res), "resolution frozen (no TOCTOU mutation)");
    assert.ok(Object.isFrozen(res.capabilities));
    assert.throws(() => {
      "use strict";
      res.capabilities.vision.state = "granted-by-attacker";
    }, TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the evaluator: deny-only; warn-first transition; closed vocabulary ───────

test("evaluate: granted passes to the mode gate; unset/denied WARN-pass under the ratified transition; enforce denies", () => {
  const res = { capabilities: { vision: { state: "granted", via: ["g1"] }, shell: { state: "unset", via: [] }, "computer-use": { state: "denied", via: [] } } };
  assert.equal(evaluateCapabilityGrant("vision", res).allow, true);
  const warned = evaluateCapabilityGrant("shell", res, { mode: "warn" }); // the pre-flip transition, now explicit
  assert.deepEqual([warned.allow, warned.warned, warned.code], [true, true, WARN_CODE]);
  const enforced = evaluateCapabilityGrant("computer-use", res, { mode: "enforce" });
  assert.deepEqual([enforced.allow, enforced.code], [false, DENIAL_CODE]);
});

test("[A40] THE FLIP: the default mode is enforce; ILLUCI_CAPABILITY_MODE=warn is the explicit hatch; garbage fails to enforce", () => {
  assert.equal(capabilityEnforcementMode({}), "enforce");
  assert.equal(capabilityEnforcementMode({ ILLUCI_CAPABILITY_MODE: "warn" }), "warn");
  assert.equal(capabilityEnforcementMode({ ILLUCI_CAPABILITY_MODE: "open-sesame" }), "enforce", "an unknown value never opens the floor");
  // default-mode evaluation DENIES an unset capability (deny-by-default floor)
  const denied = evaluateCapabilityGrant("shell", { capabilities: { shell: { state: "unset", via: [] } } });
  assert.deepEqual([denied.allow, denied.code], [false, DENIAL_CODE]);
});

test("an UNKNOWN capability denies in BOTH modes — warn-first never covers the ungoverned", () => {
  assert.equal(evaluateCapabilityGrant("telepathy", {}, { mode: "warn" }).allow, false);
  assert.equal(evaluateCapabilityGrant("telepathy", {}, { mode: "enforce" }).allow, false);
});

// ── the spoof detector ────────────────────────────────────────────────────────

test("detectSpoofClaims finds the dead booleans at both levels; clean input yields none", () => {
  assert.deepEqual(detectSpoofClaims({ computerUseGrant: true, toolAffordancePosture: { operatorGrant: false } }), [
    "computerUseGrant",
    "toolAffordancePosture.operatorGrant",
  ]);
  assert.deepEqual(detectSpoofClaims({ task: "x" }), []);
});
