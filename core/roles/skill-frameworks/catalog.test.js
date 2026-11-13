import test from "node:test";
import assert from "node:assert/strict";

import {
  getSkillFrameworkGraph,
  listSkillFrameworkIds,
  permissionBoundaryRefsForFrameworkRef,
  permissionControlsForFrameworkRef,
  resolveSkillFramework,
  resolveSkillFrameworkUse,
  skillAtomsForFrameworkRef,
  skillIdsForFrameworkRef,
  toolChannelControlsForFrameworkRef,
  validateSkillFrameworkGraph,
} from "./catalog.js";

test("GitOps skill framework is a valid graph-native framework", () => {
  const validation = validateSkillFrameworkGraph("gitops-review");

  assert.equal(validation.valid, true);
  assert.equal(validation.status, "resolvable");
  assert.deepEqual(validation.permissionBoundaryRefs, ["gitops-read", "gitops-verify"]);
});

test("GitOps framework exposes capability skill ids through graph skill nodes", () => {
  const skillIds = skillIdsForFrameworkRef("gitops-review");

  assert.ok(skillIds.includes("code-review"));
  assert.ok(skillIds.includes("test-generation"));
  assert.ok(skillIds.includes("security-audit"));
  assert.ok(skillIds.includes("project-management"));
  assert.equal(new Set(skillIds).size, skillIds.length);
});

test("GitOps framework carries permission-boundary refs as graph metadata", () => {
  const refs = permissionBoundaryRefsForFrameworkRef("gitops-review");

  assert.deepEqual(refs, ["gitops-read", "gitops-verify"]);
});

test("GitOps framework exposes atomic skill controls", () => {
  const atoms = skillAtomsForFrameworkRef("gitops-review");
  const refs = atoms.map((atom) => atom.ref);

  assert.deepEqual(refs, [
    "gitops.pr-diff-review",
    "gitops.check-evidence",
    "gitops.branch-protection",
    "gitops.merge-provenance",
  ]);
  assert.ok(atoms.every((atom) => atom.atomic === true));
  assert.ok(atoms.every((atom) => atom.permissionControls.length > 0));

  const merge = atoms.find((atom) => atom.ref === "gitops.merge-provenance");
  const mergeAction = merge.permissionControls.find((control) => control.actionRef === "github_pr_merge");
  assert.equal(mergeAction.defaultEnabled, false);
  assert.equal(mergeAction.requiresExplicitGrant, true);
});

test("permission and tool-channel controls are resolved as reusable framework data", () => {
  const controls = permissionControlsForFrameworkRef("gitops-review");
  const actionRefs = controls.map((control) => control.actionRef);
  const toolChannels = toolChannelControlsForFrameworkRef("gitops-review").map((control) => control.toolChannel);

  assert.ok(actionRefs.includes("file_read"));
  assert.ok(actionRefs.includes("github_pr_read"));
  assert.ok(actionRefs.includes("mcp_tool_read"));
  assert.ok(actionRefs.includes("shell_exec"));
  assert.ok(toolChannels.includes("github"));
  assert.ok(toolChannels.includes("mcp"));
});

test("skill framework resolution returns a resolution record", () => {
  const result = resolveSkillFramework("gitops-review");

  assert.equal(result.layer, "role.skill-framework");
  assert.equal(result.telemetry.resolver, "skill-framework-graph-catalog-v1");
  assert.equal(result.governance.dynamic, true);
  assert.equal(result.resolved.id, "gitops-review");
  assert.deepEqual(result.telemetry.permissionBoundaryRefs, ["gitops-read", "gitops-verify"]);
  assert.ok(result.telemetry.atomicSkillRefs.includes("gitops.pr-diff-review"));
  assert.ok(result.telemetry.toolChannels.includes("github"));
});

test("skill framework use resolution does not require role or topology context", () => {
  const result = resolveSkillFrameworkUse({ frameworkId: "gitops-review" });

  assert.equal(result.layer, "role.skill-framework.use");
  assert.equal(result.telemetry.status, "resolved");
  assert.equal(result.resolved.context.roleId, null);
  assert.equal(result.resolved.context.topology, null);
  assert.ok(result.resolved.enabledActionRefs.includes("file_read"));
  assert.ok(result.resolved.enabledToolChannels.includes("github"));
  assert.equal(result.governance.roleRequired, false);
  assert.equal(result.governance.topologyRequired, false);
});

test("skill framework use can select an atomic skill", () => {
  const result = resolveSkillFrameworkUse({
    frameworkId: "gitops-review",
    skillRefs: ["gitops.check-evidence"],
  });

  assert.deepEqual(result.resolved.selectedSkillRefs, ["gitops.check-evidence"]);
  assert.ok(result.resolved.enabledActionRefs.includes("github_checks_read"));
  assert.ok(!result.resolved.enabledActionRefs.includes("github_branch_protection_read"));
});

test("skill framework use applies granular action and tool-channel toggles without widening unknown controls", () => {
  const result = resolveSkillFrameworkUse({
    frameworkId: "gitops-review",
    skillRefs: ["gitops.merge-provenance"],
    actionToggles: [
      { actionRef: "github_pr_merge", enabled: true },
      { actionRef: "does_not_exist", enabled: true },
    ],
    toolChannelToggles: [
      { toolChannel: "mcp", enabled: false },
      { toolChannel: "nope", enabled: true },
    ],
  });

  assert.ok(result.resolved.enabledActionRefs.includes("github_pr_merge"));
  assert.ok(!result.resolved.enabledActionRefs.includes("mcp_resource_read"));
  assert.ok(!result.resolved.enabledToolChannels.includes("mcp"));
  assert.deepEqual(result.telemetry.ignoredActionToggles, ["does_not_exist"]);
  assert.deepEqual(result.telemetry.ignoredToolChannelToggles, ["nope"]);
});

test("skill framework graph keeps roles and specialties as graph references", () => {
  const graph = getSkillFrameworkGraph("gitops-review");
  const nodes = graph.nodes.map((node) => `${node.type}:${node.ref || node.id}`);

  assert.ok(nodes.includes("role:reviewer"));
  assert.ok(nodes.includes("role:governor"));
  assert.ok(nodes.includes("specialist-role:github/pr-reviewer"));
  assert.ok(nodes.includes("specialist-role:github/checks-validator"));
  assert.ok(nodes.includes("specialist-role:github/merge-steward"));
  assert.ok(nodes.includes("specialist-role:github/provenance-auditor"));
  assert.ok(listSkillFrameworkIds().includes("gitops-review"));
});

test("hosted infrastructure framework keeps vendor adapters below the domain framework", () => {
  const validation = validateSkillFrameworkGraph("hosted-infrastructure-operations");
  const graph = getSkillFrameworkGraph("hosted-infrastructure-operations");
  const framework = graph.nodes.find((node) => node.id === "framework.hosted-infrastructure-operations");
  const atoms = skillAtomsForFrameworkRef("hosted-infrastructure-operations");

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.permissionBoundaryRefs, ["infrastructure-read", "infrastructure-verify", "infrastructure-mutate"]);
  assert.equal(framework.metadata.domain, "devops-infrastructure");
  assert.deepEqual(framework.metadata.adapterTargets, ["github", "gitlab", "vercel", "supabase", "obsidian"]);
  assert.deepEqual(atoms.map((atom) => atom.ref), [
    "infrastructure.account-posture",
    "infrastructure.execution-substrate",
    "infrastructure.deployment-hosting",
    "infrastructure.managed-data-platform",
    "infrastructure.knowledge-vault-substrate",
  ]);
});

test("hosted infrastructure framework gates frontend and mutation controls explicitly", () => {
  const result = resolveSkillFrameworkUse({
    frameworkId: "hosted-infrastructure-operations",
    skillRefs: ["infrastructure.account-posture", "infrastructure.deployment-hosting"],
  });

  assert.equal(result.layer, "role.skill-framework.use");
  assert.ok(result.resolved.enabledActionRefs.includes("github_actions_billing_read"));
  assert.ok(result.resolved.enabledActionRefs.includes("gitlab_runner_read"));
  assert.ok(result.resolved.enabledActionRefs.includes("vercel_account_read"));
  assert.ok(!result.resolved.enabledActionRefs.includes("browser_frontend_read"));
  assert.ok(!result.resolved.enabledActionRefs.includes("vercel_project_mutate"));
  assert.equal(result.resolved.permissionControls.find((control) => control.actionRef === "browser_frontend_read").enabled, false);
  assert.equal(result.resolved.permissionControls.find((control) => control.actionRef === "vercel_project_mutate").enabled, false);
  assert.ok(result.resolved.enabledToolChannels.includes("http"));
});

test("evolving skill frameworks resolve self-improvement as gated framework data", () => {
  const validation = validateSkillFrameworkGraph("evolving-skill-frameworks");
  const graph = getSkillFrameworkGraph("evolving-skill-frameworks");
  const framework = graph.nodes.find((node) => node.id === "framework.evolving-skill-frameworks");
  const reviewCoordinator = graph.nodes.find((node) => node.id === "skill.review-coordinator-alignment-challenge");
  const atoms = skillAtomsForFrameworkRef("evolving-skill-frameworks");

  assert.equal(validation.valid, true);
  assert.equal(validation.status, "resolvable");
  assert.deepEqual(validation.permissionBoundaryRefs, [
    "evolution-read",
    "evolution-propose",
    "evolution-verify",
    "evolution-stage",
    "evolution-promote",
  ]);
  assert.equal(framework.metadata.headOrchestrator, "Illuci");
  assert.equal(framework.metadata.optionalSubOrchestrator, "ReviewCoordinator");
  assert.match(framework.metadata.orchestratorLoop, /not seated/);
  assert.match(framework.metadata.concurrentImprovementMode, /shared trace awareness/);
  assert.equal(reviewCoordinator.metadata.partnerLayer, "optional-secondary-sub-orchestrator");
  assert.equal(reviewCoordinator.metadata.partnerModel, "ReviewCoordinator");
  assert.ok(!graph.nodes.some((node) => node.type === "seat" && String(node.ref || "").toLowerCase() === "illuci"));
  assert.ok(!graph.nodes.some((node) => node.type === "seat" && String(node.ref || "").toLowerCase() === "review-coordinator"));
  assert.deepEqual(atoms.map((atom) => atom.ref), [
    "evolution.self-reflection-checkpoint",
    "evolution.experience-library-curation",
    "evolution.trace-driven-skill-evolution",
    "evolution.pareto-framework-selection",
    "evolution.review-coordinator-alignment-challenge",
    "evolution.semantic-preservation-gate",
    "evolution.runtime-overlay-incubation",
    "evolution.evolution-backpressure",
  ]);
});

test("evolving skill framework use can propose improvements without enabling persistent mutation", () => {
  const result = resolveSkillFrameworkUse({
    frameworkId: "evolving-skill-frameworks",
    skillRefs: [
      "evolution.trace-driven-skill-evolution",
      "evolution.runtime-overlay-incubation",
      "evolution.review-coordinator-alignment-challenge",
    ],
  });

  assert.equal(result.layer, "role.skill-framework.use");
  assert.ok(result.resolved.enabledActionRefs.includes("improvement_candidate_propose"));
  assert.ok(result.resolved.enabledActionRefs.includes("review-coordinator_challenge_emit"));
  assert.ok(result.resolved.enabledActionRefs.includes("runtime_overlay_candidate_propose"));
  assert.ok(!result.resolved.enabledActionRefs.includes("skill_delta_candidate_stage"));
  assert.ok(!result.resolved.enabledActionRefs.includes("runtime_overlay_stage"));
  assert.ok(!result.resolved.enabledActionRefs.includes("runtime_overlay_activate"));
  assert.equal(result.resolved.permissionControls.find((control) => control.actionRef === "skill_delta_candidate_stage").requiresExplicitGrant, true);
  assert.equal(result.resolved.permissionControls.find((control) => control.actionRef === "runtime_overlay_activate").requiresExplicitGrant, true);
  assert.ok(result.resolved.enabledToolChannels.includes("runtime"));
});

test("evolving skill framework use carries the promoted behavior contract", () => {
  const result = resolveSkillFrameworkUse({ frameworkId: "evolving-skill-frameworks" });

  assert.equal(result.resolved.behaviorContract.schema, "illuci.evolving-skill.behavior-contract/1");
  assert.equal(result.resolved.behaviorContract.status, "promoted-from-live-dogfood");
  assert.deepEqual(result.resolved.behaviorContract.requiredOutputFields, [
    "seat",
    "candidate",
    "parent",
    "delegation",
    "gate",
    "loopback",
    "reject_if",
    "root_exception",
  ]);
  assert.deepEqual(result.resolved.behaviorContract.conditionalOutputFields, [
    {
      field: "review-coordinator_loopback",
      when: "ReviewCoordinator is active or secondary-orchestrator critique is invoked",
      requirement: "record ReviewCoordinator challenge, acceptance, or absence instead of implying it through prose",
    },
  ]);
  assert.match(result.resolved.behaviorContract.orchestrationStandard, /expert orchestration bodies/);
  assert.equal(result.resolved.traceabilityGate.status, "blocked-before-promotion");
  assert.equal(result.resolved.traceabilityGate.blockedRef, "evolution.trace-driven-skill-evolution.patch");
  assert.deepEqual(result.resolved.traceabilityGate.requiredEvidenceFields, ["trace_id", "trace_uri", "seat_attribution"]);
});
