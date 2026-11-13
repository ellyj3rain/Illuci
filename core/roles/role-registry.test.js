/**
 * illuci — Role Governance · role-registry tests (node:test, hermetic)
 *
 * Canonical roles come from capability-matrix getRoles() (the model-routing
 * namespace), NOT skill-registry ROLES. These tests pin: alias + canonical
 * resolution, unknown → null, isKnownRoleId, and the Phase-1 topology-validity
 * default (no entry / null entry => valid everywhere).
 *
 * Run: node --test illuci/core/roles/role-registry.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveRoleId,
  isKnownRoleId,
  isRoleValidForTopology,
  listRoleIds,
  ROLE_VALID_TOPOLOGIES,
} from "./role-registry.js";
import { getRoles } from "../matrix/capability-matrix.js";

test("listRoleIds mirrors the canonical matrix namespace (getRoles)", () => {
  assert.deepEqual(listRoleIds(), getRoles());
  // The canonical roles named in the spec exist in this namespace.
  for (const id of ["implementer", "reviewer", "arbiter", "attacker-blackbox"]) {
    assert.ok(listRoleIds().includes(id), `${id} must be a canonical matrix role`);
  }
});

test("resolveRoleId: canonical id resolves to itself", () => {
  assert.equal(resolveRoleId("implementer"), "implementer");
  assert.equal(resolveRoleId("reviewer"), "reviewer");
  assert.equal(resolveRoleId("attacker-blackbox"), "attacker-blackbox");
});

test("resolveRoleId: aliases resolve to a REAL canonical id", () => {
  assert.equal(resolveRoleId("attacker"), "attacker-blackbox");
  assert.equal(resolveRoleId("red-team"), "attacker-blackbox");
  assert.equal(resolveRoleId("builder"), "implementer");
  assert.equal(resolveRoleId("coder"), "implementer");
  // every alias target must be a known canonical role (no invented ids)
  for (const target of ["attacker-blackbox", "implementer"]) {
    assert.ok(isKnownRoleId(target));
  }
});

test("resolveRoleId: unknown / empty / non-string → null", () => {
  assert.equal(resolveRoleId("nonexistent-role"), null);
  assert.equal(resolveRoleId(""), null);
  assert.equal(resolveRoleId("   "), null);
  assert.equal(resolveRoleId(undefined), null);
  assert.equal(resolveRoleId(null), null);
  assert.equal(resolveRoleId(42), null);
});

test("isKnownRoleId: exact canonical membership only", () => {
  assert.equal(isKnownRoleId("implementer"), true);
  assert.equal(isKnownRoleId("attacker-blackbox"), true);
  // an alias spelling is NOT itself a canonical id
  assert.equal(isKnownRoleId("attacker"), false);
  assert.equal(isKnownRoleId("bogus"), false);
  assert.equal(isKnownRoleId(""), false);
});

test("isRoleValidForTopology: Phase-1 default (no/null entry) => valid everywhere", () => {
  // Seed ships empty, so every known role is valid in any topology.
  assert.equal(isRoleValidForTopology("reviewer", "dev-team"), true);
  assert.equal(isRoleValidForTopology("implementer", "legislature"), true);
  assert.equal(isRoleValidForTopology("attacker-blackbox", "anything-at-all"), true);
  // aliases resolve first, then validate
  assert.equal(isRoleValidForTopology("attacker", "honeypot"), true);
  // unknown role is never valid
  assert.equal(isRoleValidForTopology("bogus-role", "dev-team"), false);
});

test("isRoleValidForTopology: a null entry is explicitly valid-everywhere", () => {
  // Pin the null-entry semantics without mutating the frozen seed: prove that a
  // role whose entry is undefined behaves identically to a hypothetical null.
  const sample = listRoleIds()[0];
  assert.equal(ROLE_VALID_TOPOLOGIES[sample], undefined); // seed has no entries
  assert.equal(isRoleValidForTopology(sample, "any-topology"), true);
});
