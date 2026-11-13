/**
 * illuci — Role Governance · role-profiles tests (node:test, hermetic)
 *
 * The load-bearing invariant: applySubtractiveModifier is SUBTRACTIVE ONLY. It
 * removes a role's tightenActions from a base ceiling and can NEVER add an
 * action — the result is always a subset of the base. A profile that "tries to
 * widen" is impossible by construction (there is no additive field).
 *
 * Run: node --test illuci/core/roles/role-profiles.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getRoleProfile,
  applySubtractiveModifier,
  ROLE_PROFILES,
} from "./role-profiles.js";

test("getRoleProfile defaults to an EMPTY profile for unknown/unmapped roles", () => {
  const p = getRoleProfile("totally-unknown-role");
  assert.deepEqual(p.tightenActions, []);
  assert.deepEqual(p.requireGateFor, []);
  assert.equal(p.skillBundleRoleId, null);
  assert.deepEqual(p.skillFrameworkRefs, []);
  assert.deepEqual(p.permissionBoundaryRefs, []);
  // non-string is also safe
  assert.deepEqual(getRoleProfile(undefined).tightenActions, []);
});


test("reviewer and governor roles reference the GitOps skill-framework graph", () => {
  assert.deepEqual(getRoleProfile("reviewer").skillFrameworkRefs, ["gitops-review"]);
  assert.deepEqual(getRoleProfile("reviewer").permissionBoundaryRefs, ["gitops-read", "gitops-verify"]);
  assert.deepEqual(getRoleProfile("governor").skillFrameworkRefs, ["gitops-review"]);
  assert.deepEqual(getRoleProfile("governor").permissionBoundaryRefs, ["gitops-read", "gitops-verify"]);
});

test("applySubtractiveModifier REMOVES a role's tightenActions", () => {
  const base = ["file_read", "file_write", "file_edit", "git_add", "git_commit", "shell_exec"];
  const out = applySubtractiveModifier(base, "reviewer"); // tightens writes + git authoring
  assert.deepEqual(out, ["file_read", "shell_exec"]);
});

test("applySubtractiveModifier NEVER adds — result is always a subset of base", () => {
  const base = ["file_read", "search"];
  for (const roleId of [...Object.keys(ROLE_PROFILES), "unknown", "implementer"]) {
    const out = applySubtractiveModifier(base, roleId);
    for (const action of out) {
      assert.ok(base.includes(action), `${roleId}: '${action}' was not in base — modifier ADDED it`);
    }
    assert.ok(out.length <= base.length, `${roleId}: result grew beyond base`);
  }
});

test("a profile cannot WIDEN: tightenActions absent from base are a no-op", () => {
  // reviewer tightens file_write/file_edit/git_add/git_commit, none present here.
  const base = ["file_read", "search", "glob"];
  const out = applySubtractiveModifier(base, "reviewer");
  assert.deepEqual(out, base); // unchanged — nothing to remove, nothing added
});

test("applySubtractiveModifier is PURE — base is not mutated", () => {
  const base = ["file_read", "file_write"];
  const copy = [...base];
  applySubtractiveModifier(base, "reviewer");
  assert.deepEqual(base, copy, "base array must not be mutated");
});

test("a no-tighten role (implementer) returns the base unchanged (fresh copy)", () => {
  const base = ["file_read", "file_write", "git_commit"];
  const out = applySubtractiveModifier(base, "implementer");
  assert.deepEqual(out, base);
  assert.notStrictEqual(out, base, "must be a fresh array, not the same reference");
});

test("non-array base is treated as empty (defensive)", () => {
  assert.deepEqual(applySubtractiveModifier(null, "reviewer"), []);
  assert.deepEqual(applySubtractiveModifier(undefined, "implementer"), []);
});

test("ROLE_PROFILES carry no additive field — structural impossibility of widening", () => {
  for (const [roleId, profile] of Object.entries(ROLE_PROFILES)) {
    const keys = Object.keys(profile);
    // Only the three sanctioned keys may exist; none of them ADD actions.
    for (const k of keys) {
      assert.ok(
        ["tightenActions", "requireGateFor", "skillBundleRoleId", "skillFrameworkRefs", "permissionBoundaryRefs"].includes(k),
        `${roleId} has an unsanctioned profile key '${k}' that could widen the ceiling`,
      );
    }
  }
});
