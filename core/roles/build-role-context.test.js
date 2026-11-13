/**
 * illuci — Role Governance · build-role-context tests (node:test, hermetic)
 *
 * buildRoleContext is the role-join. These tests pin both halves against the
 * REAL models (no fictions):
 *   - caps = skill-bundle ids (bridged matrix-role → skill-registry ROLES via
 *     the profile's skillBundleRoleId) ∪ the topology overlay (findApplicableTo).
 *   - effectivePermission = the topology ceiling
 *     (PERMISSION_ACTIONS[TOPOLOGY_PERMISSIONS[topology]]) minus the role's
 *     subtractive tighten.
 *
 * Run: node --test illuci/core/roles/build-role-context.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRoleContext } from "./build-role-context.js";
import { ROLES as SKILL_BUNDLE_ROLES, getSkill } from "../agents/skill-registry.js";
import { findApplicableTo } from "../skills/topology-skills.js";
import { PERMISSION_ACTIONS, TOPOLOGY_PERMISSIONS } from "../gates/approval-context.js";

test("caps = skill-bundle ids ∪ topology overlay (real skill model)", () => {
  const { caps } = buildRoleContext({ roleId: "implementer", topology: "dev-team" });

  // skill-bundle half: implementer → senior-engineer bundle skills (objects → ids)
  const bundleIds = SKILL_BUNDLE_ROLES["senior-engineer"].skills.map((id) => getSkill(id).id);
  for (const id of bundleIds) assert.ok(caps.includes(id), `missing bundle skill ${id}`);

  // topology overlay half: dev-team applicable skills
  const overlay = findApplicableTo("dev-team");
  for (const id of overlay) assert.ok(caps.includes(id), `missing overlay skill ${id}`);

  // deduplicated (code-review appears in both halves → once)
  assert.equal(new Set(caps).size, caps.length);
});

test("effectivePermission = ceiling minus the role's tighten (implementer keeps writes)", () => {
  const ceiling = PERMISSION_ACTIONS[TOPOLOGY_PERMISSIONS["dev-team"]]; // "implement"
  const { effectivePermission } = buildRoleContext({ roleId: "implementer", topology: "dev-team" });
  // implementer tightens nothing → full ceiling
  assert.deepEqual(effectivePermission, ceiling);
  assert.ok(effectivePermission.includes("file_write"));
  assert.ok(effectivePermission.includes("git_commit"));
});

test("effectivePermission tightens for a reviewer (writes removed from the ceiling)", () => {
  const ceiling = PERMISSION_ACTIONS[TOPOLOGY_PERMISSIONS["dev-team"]];
  const { effectivePermission } = buildRoleContext({ roleId: "reviewer", topology: "dev-team" });
  assert.ok(ceiling.includes("file_write"), "precondition: ceiling grants writes");
  assert.ok(!effectivePermission.includes("file_write"), "reviewer must lose file_write");
  assert.ok(!effectivePermission.includes("file_edit"));
  assert.ok(!effectivePermission.includes("git_commit"));
  // it still keeps the read floor
  assert.ok(effectivePermission.includes("file_read"));
  // and it is a strict subset of the ceiling (never widened)
  for (const a of effectivePermission) assert.ok(ceiling.includes(a));
});

test("role skill-framework refs contribute graph-resolved capability ids", () => {
  const { caps, skillFrameworkRefs, skillFrameworkUses, permissionBoundaryRefs } = buildRoleContext({
    roleId: "reviewer",
    topology: "dev-team",
  });

  assert.deepEqual(skillFrameworkRefs, ["gitops-review"]);
  assert.ok(caps.includes("code-review"));
  assert.ok(caps.includes("test-generation"));
  assert.ok(caps.includes("security-audit"));
  assert.ok(caps.includes("project-management"));
  assert.deepEqual(permissionBoundaryRefs, ["gitops-read", "gitops-verify"]);
  assert.equal(skillFrameworkUses.length, 1);
  assert.equal(skillFrameworkUses[0].layer, "role.skill-framework.use");
  assert.ok(skillFrameworkUses[0].resolved.enabledToolChannels.includes("github"));
});

test("skill-framework refs do not widen effective permissions", () => {
  const { effectivePermission } = buildRoleContext({ roleId: "reviewer", topology: "dev-team" });

  assert.ok(effectivePermission.includes("shell_exec"));
  assert.ok(!effectivePermission.includes("git_commit"));
  assert.ok(!effectivePermission.includes("file_write"));
});

test("unknown topology → empty ceiling; role with no bundle → empty caps from bundle", () => {
  const { caps, effectivePermission } = buildRoleContext({ roleId: "implementer", topology: "no-such-topology" });
  // no topology permission → empty ceiling (nothing to tighten from)
  assert.deepEqual(effectivePermission, []);
  // caps still carry the bundle half (topology overlay is empty for unknown)
  assert.ok(caps.length > 0);
});

test("absent roleId/topology is safe (empty context)", () => {
  const ctx = buildRoleContext({});
  assert.deepEqual(ctx.caps, []);
  assert.deepEqual(ctx.effectivePermission, []);
});
