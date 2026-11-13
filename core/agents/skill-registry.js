/**
 * Illuci — Skill Framework Registry
 *
 * Purpose
 * -------
 * Skills are cognitive heuristic frameworks that shape HOW a model uses
 * universal tools within a specific domain. A Skill is NOT a tool — tools
 * are raw environment affordances (bash, edit_file, grep). A Skill dictates
 * how effectively and in what manner a model utilizes those tools.
 *
 * Skills attach to Presets (behavioral dispositions). When a Preset is
 * assigned to a Seat, its Skills come with it. Skills can also declare
 * Bridge attachments — MCP servers, REST APIs, CLI wrappers — that provide
 * additional execution surface beyond the universal harness.
 *
 * Domain Model Position
 * ---------------------
 *   Structural Layer:  Topology → Seat
 *   Engine Layer:      Model
 *   Behavioral Layer:  Disposition (Disposition Presets)
 *   Functional Layer:  Skill → Role (curated bundles of Skills)
 *                      ↳ Bridge attachments (MCP, REST, CLI, SDK)
 *
 * The Functional Layer impacts the Behavioral Layer: assigning a Skill
 * exerts gravitational pull on the base disposition preset
 * vectors (e.g., a security-audit skill skews toward higher
 * conscientiousness and skepticism).
 *
 * @module core/agents/skill-registry
 */

// ═══════════════════════════════════════════════════════════════════
// SKILL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

export const SKILLS = {

  "code-review": {
    id: "code-review",
    name: "Code Review",
    description: "Systematic evaluation of code changes for correctness, style, performance, and security. Reads diffs structurally, not line-by-line.",
    domain: "engineering",

    heuristics: [
      "Read the full diff before commenting on any individual line",
      "Distinguish between blocking issues and suggestions",
      "Check for regression risk — does this change break existing behavior?",
      "Evaluate naming, abstraction boundaries, and test coverage",
      "Flag security implications explicitly when present",
    ],

    toolWeights: {
      "grep_search": 0.9,
      "read_file": 0.9,
      "bash": 0.5,       // for running tests
      "edit_file": 0.1,  // review, not implementation
    },

    invariants: [
      "All flagged issues include a severity (blocking / suggestion)",
      "Review references specific lines or ranges, not vague descriptions",
    ],

    autonomy: {
      requiresIntrospector: false,
      maxDepth: 0,
      maxBudgetTokens: 30000,
      sandboxRequired: false,
    },

    dispositionPull: {
      conscientiousness: 0.15,
      agreeableness: -0.10,  // reviewers should push back
    },

    bridges: [],
  },

  "ast-refactoring": {
    id: "ast-refactoring",
    name: "AST-Aware Refactoring",
    description: "Structural code transformation that preserves semantics. Parses before modifying, validates type signatures, maintains test coverage.",
    domain: "engineering",

    heuristics: [
      "Parse the AST conceptually before modifying source",
      "Preserve all existing test coverage",
      "Validate the transform against the original's type signature",
      "Make the smallest change that achieves the goal",
      "Run tests after every structural change",
    ],

    toolWeights: {
      "edit_file": 0.95,
      "grep_search": 0.8,
      "bash": 0.8,       // for running tests and type checks
      "read_file": 0.7,
    },

    invariants: [
      "All tests pass after transform",
      "No new lint violations introduced",
      "Type signatures remain compatible",
    ],

    autonomy: {
      requiresIntrospector: false,
      maxDepth: 0,
      maxBudgetTokens: 50000,
      sandboxRequired: true,
    },

    dispositionPull: {
      conscientiousness: 0.20,
      openness: -0.10,  // disciplined, not creative
    },

    bridges: [],
  },

  "security-audit": {
    id: "security-audit",
    name: "Security Audit",
    description: "Adversarial analysis of codebases and configurations for vulnerabilities, misconfigurations, and attack surface. Thinks like an attacker.",
    domain: "security",

    heuristics: [
      "Enumerate the attack surface before diving into specifics",
      "Check authentication, authorization, and input validation first",
      "Look for secrets, hardcoded credentials, and leaked keys",
      "Evaluate dependency versions against known CVE databases",
      "Classify findings by severity (critical / high / medium / low)",
    ],

    toolWeights: {
      "grep_search": 0.95,
      "read_file": 0.9,
      "bash": 0.7,       // for dependency checks, scanning
      "edit_file": 0.1,  // audit, not fix
    },

    invariants: [
      "Every finding includes a severity classification",
      "Critical findings include a remediation recommendation",
      "No false positives from pattern-matching alone — validate context",
    ],

    autonomy: {
      requiresIntrospector: true,
      maxDepth: 1,
      maxBudgetTokens: 80000,
      sandboxRequired: true,
    },

    dispositionPull: {
      conscientiousness: 0.20,
      agreeableness: -0.25,  // adversarial mindset
      neuroticism: 0.10,     // heightened vigilance
    },

    bridges: [
      { bridgeId: "snyk-cli", required: false, toolSubset: null },
    ],
  },

  "system-design": {
    id: "system-design",
    name: "System Design",
    description: "Architectural reasoning about component boundaries, data flow, scalability, and trade-offs. Thinks in systems, not features.",
    domain: "architecture",

    heuristics: [
      "Identify the core entities and their relationships first",
      "Define the API contract before the implementation",
      "Consider failure modes and degradation strategies",
      "Evaluate trade-offs explicitly — latency vs throughput, consistency vs availability",
      "Document decisions with rationale, not just conclusions",
    ],

    toolWeights: {
      "read_file": 0.8,
      "grep_search": 0.7,
      "edit_file": 0.5,  // writing specs, not code
      "bash": 0.3,
    },

    invariants: [
      "Design includes component boundary diagram (textual or mermaid)",
      "All trade-offs are stated explicitly",
      "Failure modes are addressed",
    ],

    autonomy: {
      requiresIntrospector: false,
      maxDepth: 0,
      maxBudgetTokens: 40000,
      sandboxRequired: false,
    },

    dispositionPull: {
      openness: 0.15,
      conscientiousness: 0.10,
    },

    bridges: [],
  },

  "test-generation": {
    id: "test-generation",
    name: "Test Generation",
    description: "Systematic creation of test cases that cover edge cases, error paths, and behavioral contracts. Thinks in inputs and expected outputs.",
    domain: "engineering",

    heuristics: [
      "Read the implementation to understand the behavioral contract",
      "Cover the happy path first, then edge cases, then error paths",
      "Each test should test one thing and be independently runnable",
      "Use descriptive test names that read as behavioral specifications",
      "Mock external dependencies, never network calls in unit tests",
    ],

    toolWeights: {
      "read_file": 0.9,
      "edit_file": 0.9,
      "bash": 0.8,       // for running tests
      "grep_search": 0.6,
    },

    invariants: [
      "All generated tests pass on the current codebase",
      "Test names describe behavior, not implementation",
      "No test depends on another test's side effects",
    ],

    autonomy: {
      requiresIntrospector: false,
      maxDepth: 0,
      maxBudgetTokens: 40000,
      sandboxRequired: true,
    },

    dispositionPull: {
      conscientiousness: 0.20,
      neuroticism: 0.10,  // think about what can go wrong
    },

    bridges: [],
  },

  "project-management": {
    id: "project-management",
    name: "Project Management",
    description: "Organizational oversight — tracking tasks, managing priorities, maintaining architectural invariants, and coordinating work across agents.",
    domain: "management",

    heuristics: [
      "Decompose large goals into discrete, assignable tasks",
      "Track dependencies between tasks explicitly",
      "Maintain a living priority list — re-evaluate on each cycle",
      "Verify completed work against the original acceptance criteria",
      "Escalate blockers immediately rather than working around them",
    ],

    toolWeights: {
      "read_file": 0.7,
      "grep_search": 0.5,
      "bash": 0.3,
      "edit_file": 0.3,
    },

    invariants: [
      "Every task has an owner, a status, and acceptance criteria",
      "No task is marked complete without verification",
    ],

    autonomy: {
      requiresIntrospector: true,
      maxDepth: 2,
      maxBudgetTokens: 100000,
      sandboxRequired: false,
    },

    dispositionPull: {
      conscientiousness: 0.25,
      extraversion: 0.10,   // coordination requires communication
      agreeableness: 0.05,
    },

    bridges: [],
  },
};

// ═══════════════════════════════════════════════════════════════════
// ROLE DEFINITIONS (curated bundles of Skills)
// ═══════════════════════════════════════════════════════════════════

export const ROLES = {

  "lead-architect": {
    id: "lead-architect",
    name: "Lead Architect",
    description: "Designs systems, reviews implementations, and maintains architectural invariants across the project.",
    skills: ["system-design", "code-review"],
    dispositionOverride: {
      conscientiousness: 0.10,
      openness: 0.10,
    },
  },

  "senior-engineer": {
    id: "senior-engineer",
    name: "Senior Engineer",
    description: "Implements features with structural awareness, writes tests, and refactors with precision.",
    skills: ["ast-refactoring", "test-generation", "code-review"],
    dispositionOverride: {
      conscientiousness: 0.15,
    },
  },

  "security-engineer": {
    id: "security-engineer",
    name: "Security Engineer",
    description: "Audits code and infrastructure for vulnerabilities, enforces security invariants, thinks adversarially.",
    skills: ["security-audit", "code-review"],
    dispositionOverride: {
      agreeableness: -0.20,
      conscientiousness: 0.20,
    },
  },

  "tech-lead": {
    id: "tech-lead",
    name: "Tech Lead",
    description: "Manages engineering work — decomposes tasks, coordinates agents, verifies output, maintains project health.",
    skills: ["project-management", "system-design", "code-review"],
    dispositionOverride: {
      conscientiousness: 0.15,
      extraversion: 0.10,
    },
  },
};

// ═══════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════

/** Retrieve a skill by id. Throws on unknown id. */
export function getSkill(id) {
  const s = SKILLS[id];
  if (!s) throw new Error(`Unknown skill: ${id}. Available: ${listSkills().join(", ")}`);
  return s;
}

/** List all available skill ids. */
export function listSkills() {
  return Object.keys(SKILLS);
}

/** Retrieve a role by id. Throws on unknown id. */
export function getRole(id) {
  const r = ROLES[id];
  if (!r) throw new Error(`Unknown role: ${id}. Available: ${listRoles().join(", ")}`);
  return r;
}

/** List all available role ids. */
export function listRoles() {
  return Object.keys(ROLES);
}

/** Resolve a role to its constituent skills. */
export function resolveRoleSkills(roleId) {
  const role = getRole(roleId);
  return role.skills.map(getSkill);
}

/** Merge disposition pulls from multiple skills (sum + clamp to [-1, 1]). */
export function mergeDispositionPulls(skills) {
  const merged = {};
  for (const skill of skills) {
    if (!skill.dispositionPull) continue;
    for (const [key, value] of Object.entries(skill.dispositionPull)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  // Clamp all values to [-1, 1]
  for (const key of Object.keys(merged)) {
    merged[key] = Math.max(-1, Math.min(1, merged[key]));
  }
  return merged;
}

/** Merge tool weights from multiple skills (max wins). */
export function mergeToolWeights(skills) {
  const merged = {};
  for (const skill of skills) {
    if (!skill.toolWeights) continue;
    for (const [tool, weight] of Object.entries(skill.toolWeights)) {
      merged[tool] = Math.max(merged[tool] ?? 0, weight);
    }
  }
  return merged;
}

/** Collect all bridge attachments from multiple skills (deduplicated). */
export function collectBridges(skills) {
  const seen = new Set();
  const bridges = [];
  for (const skill of skills) {
    if (!skill.bridges) continue;
    for (const b of skill.bridges) {
      if (!seen.has(b.bridgeId)) {
        seen.add(b.bridgeId);
        bridges.push(b);
      }
    }
  }
  return bridges;
}
