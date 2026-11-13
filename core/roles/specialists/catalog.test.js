import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveSpecialistRole,
  listSpecialistRoleSlugs,
  resolveSpecialistRole,
} from "./catalog.js";

test("specialist roles resolve as role substrate with UI and telemetry metadata", async () => {
  const role = await deriveSpecialistRole("typescript/generalist");

  assert.equal(role.id, "specialist/typescript/generalist");
  assert.equal(role.category, "typescript");
  assert.deepEqual(role.knowledgeRefs, ["typescript"]);
  assert.deepEqual(role.skillFrameworkRefs, []);
  assert.equal(role.ui.label, "Typescript / Generalist");
  assert.equal(role.telemetry.knowledgeRefCount, 1);
  assert.equal(role.telemetry.skillFrameworkRefCount, 0);
  assert.equal(role.provenance.referenceBasis, "core/roles/specialists/profiles/typescript/generalist.md");
});


test("GitHub specialties carry GitOps skill-framework refs", async () => {
  const role = await deriveSpecialistRole("github/pr-reviewer");

  assert.equal(role.id, "specialist/github/pr-reviewer");
  assert.equal(role.category, "github");
  assert.deepEqual(role.knowledgeRefs, ["gitops"]);
  assert.deepEqual(role.skillFrameworkRefs, ["gitops-review"]);
  assert.equal(role.telemetry.skillFrameworkRefCount, 1);
});

test("infrastructure specialties carry hosted infrastructure skill-framework refs", async () => {
  const role = await deriveSpecialistRole("infrastructure/account-auditor");

  assert.equal(role.id, "specialist/infrastructure/account-auditor");
  assert.equal(role.category, "infrastructure");
  assert.deepEqual(role.knowledgeRefs, ["infrastructure"]);
  assert.deepEqual(role.skillFrameworkRefs, ["hosted-infrastructure-operations"]);
  assert.equal(role.telemetry.skillFrameworkRefCount, 1);
});

test("specialist role resolution returns ranked candidates, not a boolean", async () => {
  const result = await resolveSpecialistRole("react hooks specialist");

  assert.equal(result.layer, "role.specialist");
  assert.equal(result.telemetry.resolver, "specialist-role-catalog-v1");
  assert.equal(result.governance.dynamic, true);
  assert.equal(result.governance.auditable, true);
  assert.ok(result.telemetry.totalRoles >= 30);
  assert.ok(result.candidates.length > 0);
  assert.equal(typeof result.confidence, "number");
  assert.equal(result.resolved.slug, "react/hooks-architect");
  assert.ok(result.candidates[0].matchedSignals.includes("react"));
});

test("unresolved specialist queries preserve research telemetry", async () => {
  const result = await resolveSpecialistRole("philip k dick literary analysis");

  assert.equal(result.resolved, null);
  assert.ok(result.confidence >= 0);
  assert.ok(["unresolved", "candidates-below-threshold"].includes(result.telemetry.status));
  assert.ok(result.telemetry.totalRoles >= 30);
});

test("specialist corpus remains discoverable after anthropology is emptied", async () => {
  const slugs = await listSpecialistRoleSlugs();

  assert.ok(slugs.includes("typescript/generalist"));
  assert.ok(slugs.includes("postgresql/rls-specialist"));
  assert.ok(slugs.includes("architect-strategist"));
  assert.ok(slugs.includes("github/pr-reviewer"));
  assert.ok(slugs.includes("github/checks-validator"));
  assert.ok(slugs.includes("github/merge-steward"));
  assert.ok(slugs.includes("github/provenance-auditor"));
  assert.ok(slugs.includes("infrastructure/account-auditor"));
  assert.ok(slugs.includes("infrastructure/deployment-hosting"));
  assert.ok(slugs.includes("infrastructure/managed-data"));
  assert.ok(slugs.includes("infrastructure/knowledge-vault"));
});
