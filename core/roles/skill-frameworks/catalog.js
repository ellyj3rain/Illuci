/**
 * Source-owned skill-framework graph catalog.
 *
 * Skill frameworks are graph records: a framework node uses atomic skill nodes,
 * references role and specialist-role nodes, and carries permission-boundary
 * refs as audit metadata. They are reusable outside role/topology context, and
 * each atomic skill carries granular action and tool-channel controls.
 */

import { defineResolutionRecord } from "../../composition/resolution-record.js";
import { normalizeGraphPreset, validateGraphPreset } from "../../composition/graph-preset.js";

function freeze(value) {
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) value[key] = freeze(child);
    return Object.freeze(value);
  }
  return value;
}

function control(actionRef, toolChannel, boundaryRefs, options = {}) {
  return {
    actionRef,
    toolChannel,
    boundaryRefs,
    default: options.default || "enabled",
    posture: options.posture || "allowed-by-framework-control",
    requiresExplicitGrant: options.requiresExplicitGrant === true,
  };
}

const GITOPS_REVIEW_GRAPH = freeze({
  id: "gitops-review",
  version: 2,
  status: "resolvable",
  presentation: {
    label: "GitOps Review",
    publicLabel: "GitOps Review",
    visibility: "default",
    status: "active",
  },
  nodes: [
    {
      id: "framework.gitops-review",
      type: "skill-framework",
      ref: "gitops-review",
      label: "GitOps Review Framework",
      metadata: {
        domain: "gitops",
        layer: "roles.skill-frameworks.specialties",
        atomic: true,
        reusableOutsideRole: true,
        capabilitySkillIds: ["code-review", "test-generation", "security-audit", "project-management"],
        toolChannels: ["filesystem", "git", "github", "mcp", "shell"],
      },
    },
    {
      id: "skill.pr-diff-review",
      type: "skill",
      ref: "gitops.pr-diff-review",
      label: "Pull Request Diff Review",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["code-review"],
        focus: "read changed files, identify blocking regressions, and separate findings from preferences",
        toolChannels: ["filesystem", "git", "github", "mcp"],
        permissionControls: [
          control("file_read", "filesystem", ["gitops-read"]),
          control("search", "filesystem", ["gitops-read"]),
          control("glob", "filesystem", ["gitops-read"]),
          control("git_diff", "git", ["gitops-read"]),
          control("git_status", "git", ["gitops-read"]),
          control("github_pr_read", "github", ["gitops-read"]),
          control("mcp_resource_read", "mcp", ["gitops-read"]),
          control("github_review_comment", "github", ["gitops-read"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "write-shaped review evidence; caller must grant explicitly",
          }),
        ],
      },
    },
    {
      id: "skill.check-evidence",
      type: "skill",
      ref: "gitops.check-evidence",
      label: "Check Evidence Validation",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["test-generation", "code-review"],
        focus: "read CI status, understand failed checks, and map evidence to merge readiness",
        toolChannels: ["filesystem", "git", "github", "mcp", "shell"],
        permissionControls: [
          control("file_read", "filesystem", ["gitops-read"]),
          control("git_status", "git", ["gitops-read"]),
          control("github_checks_read", "github", ["gitops-read"]),
          control("github_actions_log_read", "github", ["gitops-read"]),
          control("mcp_tool_read", "mcp", ["gitops-read"]),
          control("shell_exec", "shell", ["gitops-verify"], { posture: "verification commands only" }),
        ],
      },
    },
    {
      id: "skill.branch-protection",
      type: "skill",
      ref: "gitops.branch-protection",
      label: "Branch Protection Audit",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["security-audit", "system-design"],
        focus: "verify repository gates, required checks, and permission boundaries without weakening them",
        toolChannels: ["git", "github", "mcp", "shell"],
        permissionControls: [
          control("git_branch", "git", ["gitops-read"]),
          control("git_status", "git", ["gitops-read"]),
          control("github_branch_protection_read", "github", ["gitops-read"]),
          control("github_ruleset_read", "github", ["gitops-read"]),
          control("mcp_tool_read", "mcp", ["gitops-read"]),
          control("shell_exec", "shell", ["gitops-verify"], { posture: "verification commands only" }),
        ],
      },
    },
    {
      id: "skill.merge-provenance",
      type: "skill",
      ref: "gitops.merge-provenance",
      label: "Merge Provenance",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["project-management", "code-review"],
        focus: "confirm FIFO order, ledger evidence, version movement, and ready-to-merge state",
        toolChannels: ["filesystem", "git", "github", "mcp"],
        permissionControls: [
          control("file_read", "filesystem", ["gitops-read"]),
          control("git_log", "git", ["gitops-read"]),
          control("git_status", "git", ["gitops-read"]),
          control("github_pr_read", "github", ["gitops-read"]),
          control("github_check_read", "github", ["gitops-read"]),
          control("mcp_resource_read", "mcp", ["gitops-read"]),
          control("github_pr_merge", "github", ["gitops-read"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "merge mutation; caller must grant explicitly and satisfy repository gates",
          }),
          control("github_branch_delete", "github", ["gitops-read"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "branch mutation; caller must grant explicitly and satisfy repository gates",
          }),
        ],
      },
    },
    {
      id: "role.reviewer",
      type: "role",
      ref: "reviewer",
      label: "Reviewer Role",
    },
    {
      id: "role.governor",
      type: "role",
      ref: "governor",
      label: "Governor Role",
    },
    {
      id: "specialist.github-pr-reviewer",
      type: "specialist-role",
      ref: "github/pr-reviewer",
      label: "GitHub PR Reviewer Specialty",
    },
    {
      id: "specialist.github-checks-validator",
      type: "specialist-role",
      ref: "github/checks-validator",
      label: "GitHub Checks Validator Specialty",
    },
    {
      id: "specialist.github-merge-steward",
      type: "specialist-role",
      ref: "github/merge-steward",
      label: "GitHub Merge Steward Specialty",
    },
    {
      id: "specialist.github-provenance-auditor",
      type: "specialist-role",
      ref: "github/provenance-auditor",
      label: "GitHub Provenance Auditor Specialty",
    },
    {
      id: "boundary.gitops-read",
      type: "permission-boundary",
      ref: "gitops-read",
      label: "GitOps Read Boundary",
      spec: {
        actions: ["file_read", "search", "glob", "git_log", "git_diff", "git_status", "git_branch"],
        toolChannels: ["filesystem", "git", "github", "mcp"],
        controlsAreGranular: true,
      },
    },
    {
      id: "boundary.gitops-verify",
      type: "permission-boundary",
      ref: "gitops-verify",
      label: "GitOps Verification Boundary",
      spec: {
        actions: ["shell_exec"],
        toolChannels: ["shell"],
        controlsAreGranular: true,
        posture: "verification commands only",
      },
    },
  ],
  edges: [
    { from: "framework.gitops-review", to: "skill.pr-diff-review", type: "uses" },
    { from: "framework.gitops-review", to: "skill.check-evidence", type: "uses" },
    { from: "framework.gitops-review", to: "skill.branch-protection", type: "uses" },
    { from: "framework.gitops-review", to: "skill.merge-provenance", type: "uses" },
    { from: "role.reviewer", to: "framework.gitops-review", type: "assigns" },
    { from: "role.governor", to: "framework.gitops-review", type: "assigns" },
    { from: "specialist.github-pr-reviewer", to: "framework.gitops-review", type: "uses" },
    { from: "specialist.github-checks-validator", to: "framework.gitops-review", type: "uses" },
    { from: "specialist.github-merge-steward", to: "framework.gitops-review", type: "uses" },
    { from: "specialist.github-provenance-auditor", to: "framework.gitops-review", type: "uses" },
    { from: "framework.gitops-review", to: "boundary.gitops-read", type: "constrains" },
    { from: "framework.gitops-review", to: "boundary.gitops-verify", type: "constrains" },
  ],
  provenance: {
    source: "canon",
    createdBy: "illuci",
    referenceBasis: "A4.11 GitOps skill-framework graph substrate; A4.12 atomic controls hardening.",
  },
  governance: {
    auditable: true,
    dynamic: true,
    stability: "resolvable",
  },
});

const HOSTED_INFRASTRUCTURE_OPERATIONS_GRAPH = freeze({
  id: "hosted-infrastructure-operations",
  version: 1,
  status: "resolvable",
  presentation: {
    label: "Hosted Infrastructure Operations",
    publicLabel: "Hosted Infrastructure Operations",
    visibility: "default",
    status: "active",
  },
  nodes: [
    {
      id: "framework.hosted-infrastructure-operations",
      type: "skill-framework",
      ref: "hosted-infrastructure-operations",
      label: "Hosted Infrastructure Operations Framework",
      metadata: {
        domain: "devops-infrastructure",
        layer: "roles.skill-frameworks.specialties",
        atomic: true,
        reusableOutsideRole: true,
        platformFamilies: ["gitops", "deployment-hosting", "managed-data-platform", "knowledge-vault"],
        adapterTargets: ["github", "gitlab", "vercel", "supabase", "obsidian"],
        capabilitySkillIds: ["system-design", "security-audit", "project-management", "test-generation"],
        toolChannels: ["filesystem", "git", "github", "http", "browser", "mcp", "shell"],
      },
    },
    {
      id: "skill.infrastructure-account-posture",
      type: "skill",
      ref: "infrastructure.account-posture",
      label: "Infrastructure Account Posture",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["system-design", "security-audit"],
        focus: "classify account, entitlement, quota, feature, and frontend-verification posture before attributing failures to source code",
        toolChannels: ["github", "http", "browser", "mcp"],
        permissionControls: [
          control("github_account_read", "github", ["infrastructure-read"]),
          control("github_actions_billing_read", "github", ["infrastructure-read"]),
          control("gitlab_account_read", "http", ["infrastructure-read"]),
          control("gitlab_version_read", "http", ["infrastructure-read"]),
          control("gitlab_license_read", "http", ["infrastructure-read"]),
          control("gitlab_runner_read", "http", ["infrastructure-read"]),
          control("vercel_account_read", "http", ["infrastructure-read"]),
          control("supabase_account_read", "http", ["infrastructure-read"]),
          control("browser_frontend_read", "browser", ["infrastructure-verify"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "logged-in frontend/account inspection; caller must grant explicitly",
          }),
          control("mcp_tool_read", "mcp", ["infrastructure-read"]),
        ],
      },
    },
    {
      id: "skill.infrastructure-execution-substrate",
      type: "skill",
      ref: "infrastructure.execution-substrate",
      label: "Infrastructure Execution Substrate",
      metadata: {
        atomic: true,
        adapterTargets: ["gitlab"],
        capabilitySkillIds: ["system-design", "test-generation", "security-audit"],
        focus: "inspect CI execution substrate, runner visibility, pipeline readiness, and self-managed runner evidence without treating one provider as the framework boundary",
        toolChannels: ["filesystem", "git", "http", "browser", "shell"],
        permissionControls: [
          control("file_read", "filesystem", ["infrastructure-read"]),
          control("git_status", "git", ["infrastructure-read"]),
          control("gitlab_project_read", "http", ["infrastructure-read"]),
          control("gitlab_pipeline_read", "http", ["infrastructure-read"]),
          control("gitlab_runner_read", "http", ["infrastructure-read"]),
          control("shell_exec", "shell", ["infrastructure-verify"], { posture: "verification commands only" }),
          control("browser_frontend_read", "browser", ["infrastructure-verify"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "logged-in runner or admin frontend inspection; caller must grant explicitly",
          }),
        ],
      },
    },
    {
      id: "skill.deployment-hosting",
      type: "skill",
      ref: "infrastructure.deployment-hosting",
      label: "Deployment Hosting Operations",
      metadata: {
        atomic: true,
        adapterTargets: ["vercel"],
        capabilitySkillIds: ["system-design", "project-management"],
        focus: "inspect projects, deployments, domains, usage, plan, and build/runtime posture for deployment-hosting providers",
        toolChannels: ["filesystem", "git", "http", "browser", "shell"],
        permissionControls: [
          control("file_read", "filesystem", ["infrastructure-read"]),
          control("git_status", "git", ["infrastructure-read"]),
          control("vercel_project_read", "http", ["infrastructure-read"]),
          control("vercel_deployment_read", "http", ["infrastructure-read"]),
          control("vercel_usage_read", "http", ["infrastructure-read"]),
          control("shell_exec", "shell", ["infrastructure-verify"], { posture: "verification commands only" }),
          control("vercel_project_mutate", "http", ["infrastructure-mutate"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "deployment-hosting mutation; caller must grant explicitly",
          }),
        ],
      },
    },
    {
      id: "skill.managed-data-platform",
      type: "skill",
      ref: "infrastructure.managed-data-platform",
      label: "Managed Data Platform Operations",
      metadata: {
        atomic: true,
        adapterTargets: ["supabase"],
        capabilitySkillIds: ["security-audit", "system-design"],
        focus: "inspect organization, project, database, auth, storage, edge-function, usage, and billing posture for managed data platforms",
        toolChannels: ["filesystem", "http", "browser", "mcp", "shell"],
        permissionControls: [
          control("file_read", "filesystem", ["infrastructure-read"]),
          control("supabase_project_read", "http", ["infrastructure-read"]),
          control("supabase_org_read", "http", ["infrastructure-read"]),
          control("supabase_usage_read", "http", ["infrastructure-read"]),
          control("mcp_tool_read", "mcp", ["infrastructure-read"]),
          control("shell_exec", "shell", ["infrastructure-verify"], { posture: "verification commands only" }),
          control("supabase_project_mutate", "http", ["infrastructure-mutate"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "managed-data mutation; caller must grant explicitly",
          }),
        ],
      },
    },
    {
      id: "skill.knowledge-vault-substrate",
      type: "skill",
      ref: "infrastructure.knowledge-vault-substrate",
      label: "Knowledge Vault Substrate",
      metadata: {
        atomic: true,
        adapterTargets: ["obsidian"],
        capabilitySkillIds: ["project-management", "system-design"],
        focus: "inspect local vault, sync, publish, plugin, and MCP posture for knowledge-vault substrates without treating local files as cloud account truth",
        toolChannels: ["filesystem", "browser", "mcp", "http"],
        permissionControls: [
          control("file_read", "filesystem", ["infrastructure-read"]),
          control("obsidian_vault_read", "filesystem", ["infrastructure-read"]),
          control("obsidian_local_rest_read", "http", ["infrastructure-read"]),
          control("mcp_resource_read", "mcp", ["infrastructure-read"]),
          control("browser_frontend_read", "browser", ["infrastructure-verify"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "frontend account or plugin inspection; caller must grant explicitly",
          }),
          control("obsidian_vault_write", "filesystem", ["infrastructure-mutate"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "vault mutation; caller must grant explicitly",
          }),
        ],
      },
    },
    {
      id: "role.operator",
      type: "role",
      ref: "operator",
      label: "Operator Role",
    },
    {
      id: "role.governor",
      type: "role",
      ref: "governor",
      label: "Governor Role",
    },
    {
      id: "specialist.infrastructure-account-auditor",
      type: "specialist-role",
      ref: "infrastructure/account-auditor",
      label: "Infrastructure Account Auditor Specialty",
    },
    {
      id: "specialist.infrastructure-deployment-hosting",
      type: "specialist-role",
      ref: "infrastructure/deployment-hosting",
      label: "Infrastructure Deployment Hosting Specialty",
    },
    {
      id: "specialist.infrastructure-managed-data",
      type: "specialist-role",
      ref: "infrastructure/managed-data",
      label: "Infrastructure Managed Data Specialty",
    },
    {
      id: "specialist.infrastructure-knowledge-vault",
      type: "specialist-role",
      ref: "infrastructure/knowledge-vault",
      label: "Infrastructure Knowledge Vault Specialty",
    },
    {
      id: "boundary.infrastructure-read",
      type: "permission-boundary",
      ref: "infrastructure-read",
      label: "Infrastructure Read Boundary",
      spec: {
        actions: ["file_read", "git_status", "github_account_read", "github_actions_billing_read", "gitlab_account_read", "gitlab_version_read", "gitlab_license_read", "gitlab_project_read", "gitlab_pipeline_read", "gitlab_runner_read", "vercel_account_read", "vercel_project_read", "vercel_deployment_read", "vercel_usage_read", "supabase_account_read", "supabase_project_read", "supabase_org_read", "supabase_usage_read", "obsidian_vault_read", "obsidian_local_rest_read", "mcp_tool_read", "mcp_resource_read"],
        toolChannels: ["filesystem", "git", "github", "http", "mcp"],
        controlsAreGranular: true,
      },
    },
    {
      id: "boundary.infrastructure-verify",
      type: "permission-boundary",
      ref: "infrastructure-verify",
      label: "Infrastructure Verification Boundary",
      spec: {
        actions: ["shell_exec", "browser_frontend_read"],
        toolChannels: ["shell", "browser"],
        controlsAreGranular: true,
        posture: "verification and logged-in frontend inspection only",
      },
    },
    {
      id: "boundary.infrastructure-mutate",
      type: "permission-boundary",
      ref: "infrastructure-mutate",
      label: "Infrastructure Mutation Boundary",
      spec: {
        actions: ["vercel_project_mutate", "supabase_project_mutate", "obsidian_vault_write"],
        toolChannels: ["http", "filesystem"],
        controlsAreGranular: true,
        posture: "disabled by default; explicit operator grant required",
      },
    },
  ],
  edges: [
    { from: "framework.hosted-infrastructure-operations", to: "skill.infrastructure-account-posture", type: "uses" },
    { from: "framework.hosted-infrastructure-operations", to: "skill.infrastructure-execution-substrate", type: "uses" },
    { from: "framework.hosted-infrastructure-operations", to: "skill.deployment-hosting", type: "uses" },
    { from: "framework.hosted-infrastructure-operations", to: "skill.managed-data-platform", type: "uses" },
    { from: "framework.hosted-infrastructure-operations", to: "skill.knowledge-vault-substrate", type: "uses" },
    { from: "role.operator", to: "framework.hosted-infrastructure-operations", type: "assigns" },
    { from: "role.governor", to: "framework.hosted-infrastructure-operations", type: "assigns" },
    { from: "specialist.infrastructure-account-auditor", to: "framework.hosted-infrastructure-operations", type: "uses" },
    { from: "specialist.infrastructure-deployment-hosting", to: "framework.hosted-infrastructure-operations", type: "uses" },
    { from: "specialist.infrastructure-managed-data", to: "framework.hosted-infrastructure-operations", type: "uses" },
    { from: "specialist.infrastructure-knowledge-vault", to: "framework.hosted-infrastructure-operations", type: "uses" },
    { from: "framework.hosted-infrastructure-operations", to: "boundary.infrastructure-read", type: "constrains" },
    { from: "framework.hosted-infrastructure-operations", to: "boundary.infrastructure-verify", type: "constrains" },
    { from: "framework.hosted-infrastructure-operations", to: "boundary.infrastructure-mutate", type: "constrains" },
  ],
  provenance: {
    source: "canon",
    createdBy: "illuci",
    referenceBasis: "A15.4.13 hosted infrastructure account-posture and adapter substrate.",
  },
  governance: {
    auditable: true,
    dynamic: true,
    stability: "resolvable",
  },
});

const EVOLVING_SKILL_FRAMEWORKS_GRAPH = freeze({
  id: "evolving-skill-frameworks",
  version: 1,
  status: "resolvable",
  presentation: {
    label: "Evolving Skill Frameworks",
    publicLabel: "Evolving Skill Frameworks",
    visibility: "default",
    status: "draft-active",
  },
  nodes: [
    {
      id: "framework.evolving-skill-frameworks",
      type: "skill-framework",
      ref: "evolving-skill-frameworks",
      label: "Evolving Skill Frameworks",
      metadata: {
        domain: "agentic-self-improvement",
        layer: "roles.skill-frameworks.evolution",
        atomic: true,
        reusableOutsideRole: true,
        headOrchestrator: "Illuci",
        optionalSubOrchestrator: "ReviewCoordinator",
        orchestratorLoop: "Illuci and ReviewCoordinator are not seated; they coordinate above topology seats with shared trace awareness.",
        concurrentImprovementMode: "head-orchestrator plus optional secondary sub-orchestrator can critique, iterate, and improve each other with shared trace awareness while preserving topology-seat context.",
        behaviorContract: {
          schema: "illuci.evolving-skill.behavior-contract/1",
          status: "promoted-from-live-dogfood",
          source: "A22.4.1 live behavioral campaign",
          purpose: "emit falsifiable orchestration records, not prose-only reflection",
          orchestrationStandard: "Illuci and ReviewCoordinator act as expert orchestration bodies for deliberation, task architecture, delegation, management, review, and re-litigation.",
          requiredOutputFields: ["seat", "candidate", "parent", "delegation", "gate", "loopback", "reject_if", "root_exception"],
          conditionalOutputFields: [
            {
              field: "review-coordinator_loopback",
              when: "ReviewCoordinator is active or secondary-orchestrator critique is invoked",
              requirement: "record ReviewCoordinator challenge, acceptance, or absence instead of implying it through prose",
            },
          ],
          rootExceptionPolicy: "root_exception is allowed only when documented, bounded, traceable, and operator-ratified; otherwise parent must reference a prior candidate, trace, or framework atom.",
        },
        traceabilityGate: {
          status: "blocked-before-promotion",
          blockedRef: "evolution.trace-driven-skill-evolution.patch",
          requiredEvidenceFields: ["trace_id", "trace_uri", "seat_attribution"],
          requirement: "Do not promote trace-driven skill patches until each candidate carries trace id, trace URI, and seat attribution.",
        },
        researchBasis: ["Hermes Agent", "Hermes Agent Self-Evolution", "GEPA", "Self-Refine", "Voyager", "SAGE", "SiriuS", "RAGEN", "Darwin Godel Machine"],
        capabilitySkillIds: ["system-design", "code-review", "test-generation", "project-management"],
        toolChannels: ["runtime", "mcp", "filesystem", "git", "shell"],
      },
    },
    {
      id: "skill.self-reflection-checkpoint",
      type: "skill",
      ref: "evolution.self-reflection-checkpoint",
      label: "Self-Reflection Checkpoint",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["project-management", "code-review"],
        focus: "emit bounded agent and seat reflections after meaningful action without turning reflection into persistent mutation",
        toolChannels: ["runtime", "mcp"],
        permissionControls: [
          control("trace_read", "runtime", ["evolution-read"]),
          control("seat_context_read", "runtime", ["evolution-read"]),
          control("agent_reflection_emit", "runtime", ["evolution-propose"]),
          control("seat_reflection_emit", "runtime", ["evolution-propose"]),
          control("mcp_resource_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "skill.experience-library-curation",
      type: "skill",
      ref: "evolution.experience-library-curation",
      label: "Experience Library Curation",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["project-management", "system-design"],
        focus: "separate reusable successful trajectories and repaired failures from raw trace hoarding",
        toolChannels: ["runtime", "filesystem", "mcp"],
        permissionControls: [
          control("trace_read", "runtime", ["evolution-read"]),
          control("experience_library_read", "runtime", ["evolution-read"]),
          control("experience_candidate_propose", "runtime", ["evolution-propose"]),
          control("experience_library_stage", "filesystem", ["evolution-stage"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "persistent experience-library write; caller must grant explicitly",
          }),
          control("mcp_resource_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "skill.trace-driven-skill-evolution",
      type: "skill",
      ref: "evolution.trace-driven-skill-evolution",
      label: "Trace-Driven Skill Evolution",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["system-design", "test-generation", "code-review"],
        focus: "convert repeated workflow lessons into patch-shaped skill or framework delta candidates with test evidence",
        toolChannels: ["runtime", "filesystem", "git", "shell"],
        permissionControls: [
          control("trace_read", "runtime", ["evolution-read"]),
          control("improvement_candidate_propose", "runtime", ["evolution-propose"]),
          control("skill_delta_candidate_stage", "filesystem", ["evolution-stage"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "write-shaped skill delta staging; caller must grant explicitly",
          }),
          control("git_diff", "git", ["evolution-read"]),
          control("shell_exec", "shell", ["evolution-verify"], { posture: "verification commands only" }),
        ],
      },
    },
    {
      id: "skill.pareto-framework-selection",
      type: "skill",
      ref: "evolution.pareto-framework-selection",
      label: "Pareto Framework Selection",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["system-design", "test-generation"],
        focus: "retain candidate improvements that trade off reliability, cost, speed, creativity, and safety instead of collapsing to one scalar score",
        toolChannels: ["runtime", "mcp"],
        permissionControls: [
          control("candidate_set_read", "runtime", ["evolution-read"]),
          control("evaluation_result_read", "runtime", ["evolution-read"]),
          control("pareto_selection_emit", "runtime", ["evolution-propose"]),
          control("mcp_tool_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "skill.review-coordinator-alignment-challenge",
      type: "skill",
      ref: "evolution.review-coordinator-alignment-challenge",
      label: "ReviewCoordinator Alignment Challenge",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["security-audit", "system-design", "project-management"],
        focus: "let ReviewCoordinator, as an optional secondary sub-orchestrator rather than a topology seat, challenge overfitting, ontology flattening, metric gaming, and user-misaligned improvements before promotion",
        partnerLayer: "optional-secondary-sub-orchestrator",
        partnerModel: "ReviewCoordinator",
        toolChannels: ["runtime", "mcp"],
        permissionControls: [
          control("topology_experience_read", "runtime", ["evolution-read"]),
          control("ontology_boundary_check", "runtime", ["evolution-propose"]),
          control("review-coordinator_challenge_emit", "runtime", ["evolution-propose"]),
          control("mcp_resource_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "skill.semantic-preservation-gate",
      type: "skill",
      ref: "evolution.semantic-preservation-gate",
      label: "Semantic Preservation Gate",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["code-review", "security-audit", "test-generation"],
        focus: "prove that an evolved skill keeps its original purpose and does not widen tools, channels, or permission boundaries",
        toolChannels: ["runtime", "filesystem", "git", "shell"],
        permissionControls: [
          control("skill_delta_read", "filesystem", ["evolution-read"]),
          control("permission_boundary_read", "runtime", ["evolution-read"]),
          control("semantic_gate_decision_emit", "runtime", ["evolution-propose"]),
          control("git_diff", "git", ["evolution-read"]),
          control("shell_exec", "shell", ["evolution-verify"], { posture: "verification commands only" }),
        ],
      },
    },
    {
      id: "skill.runtime-overlay-incubation",
      type: "skill",
      ref: "evolution.runtime-overlay-incubation",
      label: "Runtime Overlay Incubation",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["system-design", "test-generation"],
        focus: "try candidate improvements as reversible runtime overlays before source-owned promotion",
        toolChannels: ["runtime", "filesystem", "mcp"],
        permissionControls: [
          control("runtime_overlay_read", "runtime", ["evolution-read"]),
          control("runtime_overlay_candidate_propose", "runtime", ["evolution-propose"]),
          control("runtime_overlay_stage", "filesystem", ["evolution-stage"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "runtime overlay write; caller must grant explicitly",
          }),
          control("runtime_overlay_activate", "runtime", ["evolution-promote"], {
            default: "disabled",
            requiresExplicitGrant: true,
            posture: "runtime behavior activation; caller must grant explicitly",
          }),
          control("mcp_tool_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "skill.evolution-backpressure",
      type: "skill",
      ref: "evolution.evolution-backpressure",
      label: "Evolution Backpressure",
      metadata: {
        atomic: true,
        capabilitySkillIds: ["system-design", "project-management"],
        focus: "throttle self-improvement attempts when traces are noisy, evals are weak, or provider pressure is high",
        toolChannels: ["runtime", "mcp"],
        permissionControls: [
          control("trace_quality_read", "runtime", ["evolution-read"]),
          control("provider_pressure_read", "runtime", ["evolution-read"]),
          control("evolution_throttle_emit", "runtime", ["evolution-propose"]),
          control("mcp_tool_read", "mcp", ["evolution-read"]),
        ],
      },
    },
    {
      id: "role.operator",
      type: "role",
      ref: "operator",
      label: "Operator Role",
    },
    {
      id: "role.governor",
      type: "role",
      ref: "governor",
      label: "Governor Role",
    },
    {
      id: "role.reviewer",
      type: "role",
      ref: "reviewer",
      label: "Reviewer Role",
    },
    {
      id: "boundary.evolution-read",
      type: "permission-boundary",
      ref: "evolution-read",
      label: "Evolution Read Boundary",
      spec: {
        actions: ["trace_read", "seat_context_read", "experience_library_read", "candidate_set_read", "evaluation_result_read", "topology_experience_read", "skill_delta_read", "permission_boundary_read", "runtime_overlay_read", "trace_quality_read", "provider_pressure_read", "git_diff", "mcp_resource_read", "mcp_tool_read"],
        toolChannels: ["runtime", "filesystem", "git", "mcp"],
        controlsAreGranular: true,
      },
    },
    {
      id: "boundary.evolution-propose",
      type: "permission-boundary",
      ref: "evolution-propose",
      label: "Evolution Proposal Boundary",
      spec: {
        actions: ["agent_reflection_emit", "seat_reflection_emit", "experience_candidate_propose", "improvement_candidate_propose", "pareto_selection_emit", "ontology_boundary_check", "review-coordinator_challenge_emit", "semantic_gate_decision_emit", "runtime_overlay_candidate_propose", "evolution_throttle_emit"],
        toolChannels: ["runtime"],
        controlsAreGranular: true,
        posture: "proposal and challenge records only; no persistent mutation",
      },
    },
    {
      id: "boundary.evolution-verify",
      type: "permission-boundary",
      ref: "evolution-verify",
      label: "Evolution Verification Boundary",
      spec: {
        actions: ["shell_exec"],
        toolChannels: ["shell"],
        controlsAreGranular: true,
        posture: "verification commands only",
      },
    },
    {
      id: "boundary.evolution-stage",
      type: "permission-boundary",
      ref: "evolution-stage",
      label: "Evolution Staging Boundary",
      spec: {
        actions: ["experience_library_stage", "skill_delta_candidate_stage", "runtime_overlay_stage"],
        toolChannels: ["filesystem"],
        controlsAreGranular: true,
        posture: "disabled by default; explicit operator grant required",
      },
    },
    {
      id: "boundary.evolution-promote",
      type: "permission-boundary",
      ref: "evolution-promote",
      label: "Evolution Promotion Boundary",
      spec: {
        actions: ["runtime_overlay_activate"],
        toolChannels: ["runtime"],
        controlsAreGranular: true,
        posture: "disabled by default; explicit operator grant required",
      },
    },
  ],
  edges: [
    { from: "framework.evolving-skill-frameworks", to: "skill.self-reflection-checkpoint", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.experience-library-curation", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.trace-driven-skill-evolution", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.pareto-framework-selection", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.review-coordinator-alignment-challenge", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.semantic-preservation-gate", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.runtime-overlay-incubation", type: "uses" },
    { from: "framework.evolving-skill-frameworks", to: "skill.evolution-backpressure", type: "uses" },
    { from: "role.operator", to: "framework.evolving-skill-frameworks", type: "assigns" },
    { from: "role.governor", to: "framework.evolving-skill-frameworks", type: "assigns" },
    { from: "role.reviewer", to: "framework.evolving-skill-frameworks", type: "assigns" },
    { from: "framework.evolving-skill-frameworks", to: "boundary.evolution-read", type: "constrains" },
    { from: "framework.evolving-skill-frameworks", to: "boundary.evolution-propose", type: "constrains" },
    { from: "framework.evolving-skill-frameworks", to: "boundary.evolution-verify", type: "constrains" },
    { from: "framework.evolving-skill-frameworks", to: "boundary.evolution-stage", type: "constrains" },
    { from: "framework.evolving-skill-frameworks", to: "boundary.evolution-promote", type: "constrains" },
  ],
  provenance: {
    source: "canon",
    createdBy: "illuci",
    referenceBasis: "A22.4 topology dogfood plus Hermes/GEPA/Self-Refine/Voyager/SAGE/SiriuS/RAGEN/DGM self-improvement research synthesis.",
  },
  governance: {
    auditable: true,
    dynamic: true,
    stability: "resolvable",
  },
});

export const SKILL_FRAMEWORK_GRAPHS = freeze({
  "gitops-review": GITOPS_REVIEW_GRAPH,
  "hosted-infrastructure-operations": HOSTED_INFRASTRUCTURE_OPERATIONS_GRAPH,
  "evolving-skill-frameworks": EVOLVING_SKILL_FRAMEWORKS_GRAPH,
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function graphFor(id) {
  if (typeof id !== "string") return null;
  return SKILL_FRAMEWORK_GRAPHS[id.trim()] || null;
}

function normalizedGraph(id) {
  const raw = graphFor(id);
  return raw ? normalizeGraphPreset(raw, { source: "canon" }) : null;
}

function cleanStringList(input) {
  return Array.isArray(input) ? input.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()) : [];
}

function skillNodes(graph) {
  return (graph?.nodes || []).filter((node) => node.type === "skill");
}

function boundaryNodes(graph) {
  return (graph?.nodes || []).filter((node) => node.type === "permission-boundary");
}

function frameworkNode(graph) {
  return (graph?.nodes || []).find((node) => node.type === "skill-framework") || null;
}

function normalizeConditionalFields(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const field = typeof entry.field === "string" ? entry.field.trim() : "";
      if (!field) return null;
      return {
        field,
        when: typeof entry.when === "string" && entry.when.trim() ? entry.when.trim() : null,
        requirement: typeof entry.requirement === "string" && entry.requirement.trim() ? entry.requirement.trim() : null,
      };
    })
    .filter(Boolean);
}

function normalizeBehaviorContract(raw) {
  if (!raw || typeof raw !== "object") return null;
  const schema = typeof raw.schema === "string" ? raw.schema.trim() : "";
  return {
    schema: schema || null,
    status: typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : null,
    source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : null,
    purpose: typeof raw.purpose === "string" && raw.purpose.trim() ? raw.purpose.trim() : null,
    orchestrationStandard: typeof raw.orchestrationStandard === "string" && raw.orchestrationStandard.trim()
      ? raw.orchestrationStandard.trim()
      : null,
    requiredOutputFields: cleanStringList(raw.requiredOutputFields),
    conditionalOutputFields: normalizeConditionalFields(raw.conditionalOutputFields),
    rootExceptionPolicy: typeof raw.rootExceptionPolicy === "string" && raw.rootExceptionPolicy.trim()
      ? raw.rootExceptionPolicy.trim()
      : null,
  };
}

function normalizeTraceabilityGate(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    status: typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : null,
    blockedRef: typeof raw.blockedRef === "string" && raw.blockedRef.trim() ? raw.blockedRef.trim() : null,
    requiredEvidenceFields: cleanStringList(raw.requiredEvidenceFields),
    requirement: typeof raw.requirement === "string" && raw.requirement.trim() ? raw.requirement.trim() : null,
  };
}

function controlDefaultEnabled(controlSpec) {
  if (controlSpec.defaultEnabled === false) return false;
  if (controlSpec.enabled === false) return false;
  if (controlSpec.default === "disabled") return false;
  return true;
}

function normalizePermissionControl(raw, skillNode) {
  if (!raw || typeof raw !== "object") return null;
  const actionRef = typeof raw.actionRef === "string" ? raw.actionRef.trim() : "";
  if (!actionRef) return null;
  const toolChannel = typeof raw.toolChannel === "string" && raw.toolChannel.trim() ? raw.toolChannel.trim() : "runtime";
  return {
    actionRef,
    toolChannel,
    defaultEnabled: controlDefaultEnabled(raw),
    enabled: controlDefaultEnabled(raw),
    requiresExplicitGrant: raw.requiresExplicitGrant === true,
    posture: typeof raw.posture === "string" ? raw.posture : null,
    boundaryRefs: cleanStringList(raw.boundaryRefs),
    skillRef: skillNode.ref || skillNode.id,
    skillNodeId: skillNode.id,
  };
}

function controlsForSkillNode(skillNode) {
  const controls = Array.isArray(skillNode.metadata?.permissionControls)
    ? skillNode.metadata.permissionControls.map((entry) => normalizePermissionControl(entry, skillNode)).filter(Boolean)
    : [];
  if (controls.length > 0) return controls;

  const fallback = cleanStringList(skillNode.metadata?.actionRefs);
  return fallback.map((actionRef) => ({
    actionRef,
    toolChannel: "runtime",
    defaultEnabled: true,
    enabled: true,
    requiresExplicitGrant: false,
    posture: null,
    boundaryRefs: [],
    skillRef: skillNode.ref || skillNode.id,
    skillNodeId: skillNode.id,
  }));
}

function summarizeSkillNode(skillNode) {
  return {
    id: skillNode.id,
    ref: skillNode.ref || skillNode.id,
    label: skillNode.label,
    atomic: skillNode.metadata?.atomic === true,
    capabilitySkillIds: cleanStringList(skillNode.metadata?.capabilitySkillIds),
    toolChannels: cleanStringList(skillNode.metadata?.toolChannels),
    permissionControls: controlsForSkillNode(skillNode),
  };
}

function selectedSkillNodes(graph, skillRefs = []) {
  const skills = skillNodes(graph);
  const requested = new Set(cleanStringList(skillRefs));
  if (requested.size === 0) return skills;
  return skills.filter((node) => requested.has(node.id) || requested.has(node.ref));
}

function buildToggleMap(entries = [], idKeys = ["id"]) {
  const map = new Map();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      map.set(entry.trim(), true);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const id = idKeys.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim());
    if (!id) continue;
    map.set(id.trim(), entry.enabled !== false);
  }
  return map;
}

function mergeActionToggles(options = {}) {
  const map = buildToggleMap(options.actionToggles, ["actionRef", "action", "id"]);
  for (const actionRef of cleanStringList(options.enabledActions)) map.set(actionRef, true);
  for (const actionRef of cleanStringList(options.disabledActions)) map.set(actionRef, false);
  return map;
}

function mergeToolToggles(options = {}) {
  const map = buildToggleMap(options.toolChannelToggles || options.toolToggles, ["toolChannel", "channel", "id"]);
  for (const toolChannel of cleanStringList(options.enabledToolChannels)) map.set(toolChannel, true);
  for (const toolChannel of cleanStringList(options.disabledToolChannels)) map.set(toolChannel, false);
  return map;
}

function mergeControls(controls) {
  const byAction = new Map();
  for (const control of controls) {
    const existing = byAction.get(control.actionRef) || {
      actionRef: control.actionRef,
      toolChannel: control.toolChannel,
      toolChannels: [],
      defaultEnabled: false,
      enabled: false,
      requiresExplicitGrant: false,
      boundaryRefs: [],
      skillRefs: [],
      skillNodeIds: [],
      postures: [],
    };
    existing.defaultEnabled = existing.defaultEnabled || control.defaultEnabled;
    existing.enabled = existing.enabled || control.enabled;
    existing.requiresExplicitGrant = existing.requiresExplicitGrant || control.requiresExplicitGrant;
    existing.toolChannels = unique([...existing.toolChannels, control.toolChannel]);
    existing.boundaryRefs = unique([...existing.boundaryRefs, ...control.boundaryRefs]);
    existing.skillRefs = unique([...existing.skillRefs, control.skillRef]);
    existing.skillNodeIds = unique([...existing.skillNodeIds, control.skillNodeId]);
    existing.postures = unique([...existing.postures, control.posture]);
    byAction.set(control.actionRef, existing);
  }
  return [...byAction.values()];
}

function applyToggles(actionControls, options = {}) {
  const actionToggles = mergeActionToggles(options);
  const toolToggles = mergeToolToggles(options);
  const availableActions = new Set(actionControls.map((control) => control.actionRef));
  const availableTools = new Set(actionControls.flatMap((control) => control.toolChannels));

  const toolChannelControls = [...availableTools].sort().map((toolChannel) => ({
    toolChannel,
    enabled: toolToggles.has(toolChannel) ? toolToggles.get(toolChannel) : true,
    source: toolToggles.has(toolChannel) ? "toggle" : "default",
  }));
  const toolEnabled = new Map(toolChannelControls.map((control) => [control.toolChannel, control.enabled]));

  const permissionControls = actionControls.map((control) => {
    const actionOverride = actionToggles.has(control.actionRef) ? actionToggles.get(control.actionRef) : null;
    const channelsEnabled = control.toolChannels.every((toolChannel) => toolEnabled.get(toolChannel) !== false);
    const enabled = channelsEnabled && (actionOverride === null ? control.defaultEnabled : actionOverride);
    return {
      ...control,
      enabled,
      source: actionOverride === null ? "default" : "toggle",
      disabledByToolChannel: !channelsEnabled,
    };
  });

  return {
    permissionControls,
    toolChannelControls,
    enabledActionRefs: permissionControls.filter((control) => control.enabled).map((control) => control.actionRef),
    enabledToolChannels: toolChannelControls.filter((control) => control.enabled).map((control) => control.toolChannel),
    ignoredActionToggles: [...actionToggles.keys()].filter((actionRef) => !availableActions.has(actionRef)),
    ignoredToolChannelToggles: [...toolToggles.keys()].filter((toolChannel) => !availableTools.has(toolChannel)),
  };
}

export function listSkillFrameworkIds() {
  return Object.keys(SKILL_FRAMEWORK_GRAPHS);
}

export function getSkillFrameworkGraph(id) {
  return normalizedGraph(id);
}

export function validateSkillFrameworkGraph(id) {
  const raw = graphFor(id);
  return raw
    ? validateGraphPreset(raw)
    : { valid: false, preset: null, status: "draft", errors: [`unknown skill framework: ${id}`], warnings: [] };
}

export function skillAtomsForFrameworkRef(id) {
  const graph = normalizedGraph(id);
  if (!graph) return [];
  return skillNodes(graph).map(summarizeSkillNode);
}

export function permissionControlsForFrameworkRef(id, options = {}) {
  const graph = normalizedGraph(id);
  if (!graph) return [];
  return mergeControls(selectedSkillNodes(graph, options.skillRefs).flatMap(controlsForSkillNode));
}

export function toolChannelControlsForFrameworkRef(id, options = {}) {
  const controls = permissionControlsForFrameworkRef(id, options);
  return applyToggles(controls, options).toolChannelControls;
}

export function skillIdsForFrameworkRef(id) {
  const graph = normalizedGraph(id);
  if (!graph) return [];
  return unique(skillNodes(graph).flatMap((node) => node.metadata?.capabilitySkillIds || []));
}

export function skillIdsForFrameworkRefs(ids = []) {
  return unique(ids.flatMap((id) => skillIdsForFrameworkRef(id)));
}

export function permissionBoundaryRefsForFrameworkRef(id) {
  const graph = normalizedGraph(id);
  if (!graph) return [];
  return unique(boundaryNodes(graph).map((node) => node.ref || node.id));
}

export function permissionBoundaryRefsForFrameworkRefs(ids = []) {
  return unique(ids.flatMap((id) => permissionBoundaryRefsForFrameworkRef(id)));
}

export function resolveSkillFrameworkUse(input = {}) {
  const options = typeof input === "string" ? { frameworkId: input } : input || {};
  const rawQuery = typeof options.frameworkId === "string" ? options.frameworkId.trim() : "";
  const graph = normalizedGraph(rawQuery);
  const candidates = listSkillFrameworkIds().map((id) => ({
    id,
    confidence: id === rawQuery ? 1 : id.includes(rawQuery) && rawQuery ? 0.6 : 0,
  })).filter((candidate) => candidate.confidence > 0);

  if (!graph) {
    return defineResolutionRecord({
      layer: "role.skill-framework.use",
      query: rawQuery,
      resolved: null,
      candidates,
      confidence: candidates[0]?.confidence || 0,
      resolver: "skill-framework-use-resolver-v1",
      status: candidates.length ? "candidates-below-threshold" : "unresolved",
      telemetry: {
        totalFrameworks: listSkillFrameworkIds().length,
      },
      governance: {
        layerBoundary: "skill-framework use resolver; no role or topology required",
      },
      provenance: {
        basis: "core/roles/skill-frameworks",
      },
    });
  }

  const selectedNodes = selectedSkillNodes(graph, options.skillRefs || options.skills || options.skillIds);
  const skillAtoms = selectedNodes.map(summarizeSkillNode);
  const actionControls = mergeControls(selectedNodes.flatMap(controlsForSkillNode));
  const toggled = applyToggles(actionControls, options);
  const selectedSkillRefs = skillAtoms.map((skill) => skill.ref);
  const permissionBoundaryRefs = unique(toggled.permissionControls.flatMap((control) => control.boundaryRefs));
  const rootFramework = frameworkNode(graph);

  return defineResolutionRecord({
    layer: "role.skill-framework.use",
    query: rawQuery,
    resolved: {
      frameworkId: rawQuery,
      graphId: graph.id,
      behaviorContract: normalizeBehaviorContract(rootFramework?.metadata?.behaviorContract),
      traceabilityGate: normalizeTraceabilityGate(rootFramework?.metadata?.traceabilityGate),
      selectedSkillRefs,
      skillAtoms,
      permissionControls: toggled.permissionControls,
      toolChannelControls: toggled.toolChannelControls,
      enabledActionRefs: toggled.enabledActionRefs,
      enabledToolChannels: toggled.enabledToolChannels,
      permissionBoundaryRefs,
      context: {
        roleId: typeof options.roleId === "string" ? options.roleId : null,
        topology: typeof options.topology === "string" ? options.topology : null,
      },
    },
    candidates,
    confidence: 1,
    resolver: "skill-framework-use-resolver-v1",
    status: "resolved",
    telemetry: {
      totalFrameworks: listSkillFrameworkIds().length,
      selectedSkillCount: selectedSkillRefs.length,
      enabledActionCount: toggled.enabledActionRefs.length,
      enabledToolChannelCount: toggled.enabledToolChannels.length,
      ignoredActionToggles: toggled.ignoredActionToggles,
      ignoredToolChannelToggles: toggled.ignoredToolChannelToggles,
    },
    governance: {
      layerBoundary: "skill-framework graph -> atomic skill nodes -> granular permission/tool controls",
      roleRequired: false,
      topologyRequired: false,
      permissionsAreControls: true,
      actualExecutionStillRequiresGateIntersection: true,
    },
    provenance: {
      basis: "core/roles/skill-frameworks",
    },
  });
}

export function resolveSkillFramework(query) {
  const rawQuery = typeof query === "string" ? query.trim() : "";
  const graph = normalizedGraph(rawQuery);
  const candidates = listSkillFrameworkIds().map((id) => ({
    id,
    confidence: id === rawQuery ? 1 : id.includes(rawQuery) && rawQuery ? 0.6 : 0,
  })).filter((candidate) => candidate.confidence > 0);

  return defineResolutionRecord({
    layer: "role.skill-framework",
    query: rawQuery,
    resolved: graph,
    candidates,
    confidence: graph ? 1 : candidates[0]?.confidence || 0,
    resolver: "skill-framework-graph-catalog-v1",
    status: graph ? "resolved" : candidates.length ? "candidates-below-threshold" : "unresolved",
    telemetry: {
      totalFrameworks: listSkillFrameworkIds().length,
      skillIds: graph ? skillIdsForFrameworkRef(rawQuery) : [],
      permissionBoundaryRefs: graph ? permissionBoundaryRefsForFrameworkRef(rawQuery) : [],
      atomicSkillRefs: graph ? skillAtomsForFrameworkRef(rawQuery).map((skill) => skill.ref) : [],
      toolChannels: graph ? resolveSkillFrameworkUse(rawQuery).resolved.enabledToolChannels : [],
    },
    governance: {
      layerBoundary: "role -> skill-framework graph -> atomic skill nodes + permission-boundary refs",
    },
    provenance: {
      basis: "core/roles/skill-frameworks",
    },
  });
}

export default {
  SKILL_FRAMEWORK_GRAPHS,
  listSkillFrameworkIds,
  getSkillFrameworkGraph,
  validateSkillFrameworkGraph,
  skillAtomsForFrameworkRef,
  permissionControlsForFrameworkRef,
  toolChannelControlsForFrameworkRef,
  skillIdsForFrameworkRef,
  skillIdsForFrameworkRefs,
  permissionBoundaryRefsForFrameworkRef,
  permissionBoundaryRefsForFrameworkRefs,
  resolveSkillFramework,
  resolveSkillFrameworkUse,
};
