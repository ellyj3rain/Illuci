/**
 * Illuci — Approval Context
 *
 * Tracks what the operator has approved and measures new proposals
 * against that approval before they're even presented.
 *
 * When the operator starts a task (council run, direct command, etc.),
 * the system derives an approval scope from the task intent:
 *   - Which files/directories are in play
 *   - What kinds of changes are expected (create, edit, delete)
 *   - What's explicitly off limits
 *
 * In-scope proposals auto-approve with logging.
 * Out-of-scope proposals get the interactive gate prompt.
 * Regressions (overwriting files not related to the task) always gate.
 *
 * The approval context is the operator's trust boundary.
 * Models work freely inside it. They stop at the edge.
 */

import { GATE_LEVELS } from "./gate-types.js";
import { posix, win32 } from "node:path";
import { logDecision } from "../decisions/logger.js";
import { isRoleGovernanceEnabled } from "../roles/config.js";
import { resolveRoleId } from "../roles/role-registry.js";
import { applySubtractiveModifier } from "../roles/role-profiles.js";

// ─── ACTIVE APPROVAL CONTEXT ───

let activeContext = null;

// ─── BUILD WORKSPACE SCOPE (opt-in) ───
// When a build ARMS a workspace root, writes to paths inside that root are in-scope
// (provided the permission level already allows the action). The workspace root is
// the build's trust boundary. Default null = behavior unchanged; only an armed build
// widens scope, and only within that one root. evaluate() still runs DEFAULT_DENIED
// + maturity gating BEFORE this, so locked/denied paths gate even inside a build root.
let buildWorkspaceRoot = null;
export function setApprovalWorkspace(root) { buildWorkspaceRoot = root || null; return buildWorkspaceRoot; }
export function getApprovalWorkspace() { return buildWorkspaceRoot; }

/**
 * Set the approval context for the current execution.
 * Called when the operator starts a task.
 *
 * @param {object} ctx
 * @param {string} ctx.task — the operator's prompt / task description
 * @param {string[]} ctx.allowedPaths — file paths/directories explicitly in scope
 * @param {string[]} ctx.allowedPatterns — glob patterns for in-scope files
 * @param {string[]} ctx.deniedPaths — paths that are always gated regardless
 * @param {string[]} ctx.allowedActions — tool actions allowed (file_write, file_edit, etc.)
 * @param {string} ctx.operator — who approved this context
 * @param {string} ctx.topology — topology being run (if council)
 */
export function setApprovalContext(ctx) {
  activeContext = {
    task: ctx.task || "",
    allowedPaths: ctx.allowedPaths || [],
    allowedPatterns: ctx.allowedPatterns || [],
    deniedPaths: ctx.deniedPaths || DEFAULT_DENIED_PATHS,
    allowedActions: ctx.allowedActions || ["file_read", "search", "glob", "git_log", "git_diff", "git_status"],
    permissionLevel: ctx.permissionLevel || "read-verify",
    operator: ctx.operator || "operator",
    topology: ctx.topology || null,
    createdAt: new Date().toISOString(),
    approvals: [],    // track what's been explicitly approved during this context
    denials: [],      // track what's been explicitly denied
  };
  return activeContext;
}

/**
 * Derive an approval context from a task description.
 * Parses the task for file paths, module names, and intent markers.
 */
// ─── TOPOLOGY PERMISSION PROFILES ───
// The topology determines the permission level, not the prompt text.

const TOPOLOGY_PERMISSIONS = {
  // ═══ DIRECT ═══
  "direct":               "implement",     // operator is explicitly asking for execution

  // ═══ ORIGINAL 6 ═══
  "adversarial-debate":   "read-verify",   // challenge, don't build
  "corporate-hierarchy":  "read-verify",   // executive analysis, not implementation
  "legislature":          "read-verify",   // propose and vote, don't execute
  "judiciary":            "read-verify",   // prosecute/defend/rule, don't modify
  "dev-team":             "implement",     // implementation topology
  "devops-pipeline":      "implement",     // build/test/deploy pipeline

  // ═══ CONVERGENT ═══
  "delphi-panel":         "read-verify",   // blind estimation, convergence — advisory
  "research-swarm":       "read-verify",   // investigate, don't modify
  "triage-funnel":        "read-verify",   // filter and evaluate, don't build
  "tournament-bracket":   "read-verify",   // compete and judge, don't modify

  // ═══ UNIQUE ═══
  "peer-review-ring":     "implement",     // sequential refinement — each model improves code
  "war-room":             "implement",     // co-construct a single artifact — needs writes
  "incident-command":     "implement",     // crisis response — needs to fix things
  "scenario-simulation":  "read-verify",   // explore futures, don't execute
  "apprentice-master":    "read-verify",   // teach and evaluate, don't ship
  "market-auction":       "read-verify",   // bid and assign, execution is separate

  // ═══ SOCIAL / CREATIVE ═══
  "co-operative":         "read-verify",   // consensus-driven collective — advisory
  "commune":              "read-verify",   // creative ideation — advisory
  "cult":                 "read-verify",   // charismatic vision — advisory
  "classroom":            "read-verify",   // learning — advisory
  "seminar":              "read-verify",   // thesis defense — advisory

  // ═══ INTERNAL ═══
  "perception-council":   "read-verify",   // self/peer assessment — identity only
};

// What each permission level allows
const PERMISSION_ACTIONS = {
  "read-verify": [
    "file_read", "search", "glob",
    "git_log", "git_diff", "git_status", "git_branch",
    "shell_exec",  // verification commands only — filtered below
  ],
  "implement": [
    "file_read", "search", "glob",
    "git_log", "git_diff", "git_status", "git_branch",
    "shell_exec",  // all safe commands + build/test
    "file_write", "file_edit",
    "git_add", "git_commit",
  ],
};

// Shell commands allowed in read-verify mode (beyond the default safe list)
const VERIFY_SHELL_COMMANDS = [
  /^node\s+--check\b/,         // syntax check
  /^node\s+-e\b/,              // inline eval for testing
  /^npx\s+tsc\s+--noEmit/,    // typescript check
  /^npm\s+test\b/,             // run tests
  /^npm\s+run\s+test\b/,       // run tests
  /^npx\s+vitest\b/,           // vitest
  /^npx\s+jest\b/,             // jest
  /^npx\s+eslint\b/,           // lint
  /^python\s+-c\b/,            // python check
  /^cargo\s+check\b/,          // rust check
];

export function deriveFromTask(task, options = {}) {
  const paths = [];
  const patterns = [];

  // ─── TOPOLOGY-DRIVEN PERMISSIONS ───
  const topology = options.topology || null;
  const permissionLevel = topology ? (TOPOLOGY_PERMISSIONS[topology] || "read-verify") : null;

  // Extract explicit file paths mentioned in the task
  const pathMatches = task.match(/(?:core|cli|visualizer|electron|data|decisions|library|methodology)\/[\w\-./]+/g);
  if (pathMatches) {
    for (const p of pathMatches) {
      const dir = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : p;
      paths.push(dir);
      paths.push(p);
    }
  }

  // Extract module references
  const moduleKeywords = [
    "context", "dispatch", "bridges", "gates", "topologies", "matrix",
    "agents", "skills", "sessions", "governance", "events", "composition",
    "formation", "tools", "projects", "deploy", "evolve", "visualizer",
  ];

  for (const mod of moduleKeywords) {
    if (task.toLowerCase().includes(mod)) {
      patterns.push(`core/${mod}/**`);
    }
  }

  if (/\bcli\b/i.test(task) || /\bcommand\b/i.test(task) || /\btui\b/i.test(task)) {
    patterns.push("cli/**");
  }

  // ─── DETERMINE ALLOWED ACTIONS ───
  let allowedActions;

  if (permissionLevel) {
    // Topology determines permissions
    allowedActions = [...PERMISSION_ACTIONS[permissionLevel]];
  } else {
    // Fallback: derive from task text (original behavior)
    allowedActions = ["file_read", "search", "glob", "git_log", "git_diff", "git_status", "shell_exec"];
    if (/\b(create|write|build|implement|add)\b/i.test(task)) {
      allowedActions.push("file_write", "file_edit");
    }
    if (/\b(edit|fix|update|modify|patch|refactor)\b/i.test(task)) {
      allowedActions.push("file_edit");
    }
    if (/\b(delete|remove|clean)\b/i.test(task)) {
      allowedActions.push("file_delete");
    }
  }
  if (/\b(run|exec|test|build|install)\b/i.test(task)) {
    allowedActions.push("shell_exec");
  }
  if (/\b(commit)\b/i.test(task)) {
    allowedActions.push("git_add", "git_commit");
  }

  // ─── ROLE-DRIVEN SUBTRACTIVE TIGHTENING (Phase 1, dark) ───
  // Additive net-new: when role governance is ARMED and a roleId is present, the
  // role tightens the derived allowedActions by REMOVING its tightenActions. This
  // only ever shrinks the set — the topology ceiling still bounds it, and a role
  // can only tighten, never widen. Dark by default: flag off (or no role) leaves
  // allowedActions exactly as derived, so behavior is identical to pre-Phase-1.
  let dedupedActions = [...new Set(allowedActions)];
  if (isRoleGovernanceEnabled() && options.roleId) {
    const roleId = resolveRoleId(options.roleId);
    if (roleId) {
      dedupedActions = applySubtractiveModifier(dedupedActions, roleId);
    }
  }

  return setApprovalContext({
    task,
    allowedPaths: [...new Set(paths)],
    allowedPatterns: [...new Set(patterns)],
    allowedActions: dedupedActions,
    permissionLevel: permissionLevel || "read-verify",
    topology: options.topology || null,
    ...options,
  });
}

/**
 * Record that the operator explicitly approved a specific action.
 * Extends the approval context so similar future actions auto-approve.
 */
export function recordApproval(tool, args, { origin = "operator" } = {}) {
  if (!activeContext) return;

  activeContext.approvals.push({
    tool,
    path: args?.path || args?.command,
    origin: origin === "operator" || origin === "classifier" ? origin : "unknown",
    timestamp: new Date().toISOString(),
  });

  // Exact decisions are kept separately from explicitly selected directory scopes.
}

/**
 * Record that the operator explicitly denied an action.
 * Future similar actions will be auto-denied.
 */
export function recordDenial(tool, args, reason) {
  if (!activeContext) return;

  activeContext.denials.push({
    tool,
    path: args?.path || args?.command,
    reason,
    timestamp: new Date().toISOString(),
  });

  // If operator denied a path, add it to denied paths
  if (args?.path) {
    if (!activeContext.deniedPaths.includes(args.path)) {
      activeContext.deniedPaths.push(args.path);
    }
  }
}

/**
 * Evaluate whether a proposed action falls within the approval context.
 *
 * Returns:
 *   - "approved" — in scope, auto-approve
 *   - "denied" — explicitly denied or in denied paths
 *   - "gate" — out of scope, needs operator prompt
 *
 * @param {string} tool — tool name
 * @param {object} args — tool arguments
 * @param {object} source — { model, seat }
 * @returns {{ decision: "approved"|"denied"|"gate", reason: string }}
 */
export function evaluate(tool, args, source) {
  console.log("Evaluating: ", { tool, argsPath: args?.path, activeContextAllowedActions: activeContext?.allowedActions });
  // Read-only tools always pass — models must be able to read to understand
  const readOnlyTools = ["file_read", "search", "glob", "git_log", "git_diff", "git_status",
    "git_branch", "screen_info", "window_list", "process_list", "system_info"];
  if (readOnlyTools.includes(tool)) {
    return { decision: "approved", reason: "Read-only action" };
  }

  // No active context — everything else gets gated
  if (!activeContext) {
    return { decision: "gate", reason: "No approval context set" };
  }

  const filePath = args?.path || args?.from || null;

  // ─── CHECK MATURITY LEVEL FIRST ───

  if (filePath) {
    const maturity = getMaturityLevel(filePath);
    if (maturity === "locked") {
      return { decision: "denied", reason: `File is locked (hardened): ${filePath}` };
    }
    if (maturity === "gated") {
      return { decision: "gate", reason: `File is gated (under review): ${filePath}` };
    }
    // "open" falls through to normal evaluation
  }

  // ─── CHECK DENIALS ───

  // Previously denied path
  if (filePath && activeContext.denials.some(d => d.path === filePath)) {
    return { decision: "denied", reason: "Operator previously denied this path" };
  }

  // Always-denied paths (critical infrastructure)
  if (filePath && activeContext.deniedPaths.some(p => filePath.includes(p))) {
    return { decision: "gate", reason: `Path matches denied pattern: ${filePath}` };
  }

  // ─── CHECK IF ACTION TYPE IS ALLOWED ───

  if (!activeContext.allowedActions.includes(tool)) {
    console.log("evaluate GATING: Action not in allowedActions", { tool });
    return { decision: "gate", reason: `Action '${tool}' not in approved action set` };
  }

  // ─── CHECK IF PATH IS IN SCOPE ───

  if (filePath) {
    // Normalize separators for cross-platform path comparison
    const normalizeScope = value => {
      if (typeof value !== "string" || !value || value.includes("\0")) return null;
      let normalized = /^(?:[a-zA-Z]:|[\\/]{2})/.test(value) || value.includes("\\")
        ? win32.normalize(value).replace(/\\/g, "/") : posix.normalize(value);
      if (normalized.length > 1 && !/^[a-zA-Z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, "");
      return normalized;
    };
    const normFile = normalizeScope(filePath);
    if (normFile === null) return { decision: "gate", reason: "Invalid path in approval scope" };

    // Exact path match
    if (activeContext.allowedPaths.some(p => {
      const normP = normalizeScope(p);
      if (normP === null) return false;
      if (normP === ".") return normFile !== ".." && !normFile.startsWith("../") &&
        !normFile.startsWith("/") && !/^[a-zA-Z]:/.test(normFile);
      const prefix = normP.endsWith("/") ? normP : normP + "/";
      return normFile === normP || normFile.startsWith(prefix);
    })) {
      return { decision: "approved", reason: "Path in approved scope" };
    }

    // Pattern match
    if (activeContext.allowedPatterns.some(pattern => matchGlob(filePath, pattern))) {
      return { decision: "approved", reason: "Path matches approved pattern" };
    }

    // A remembered single-action approval does not grant its parent or siblings.
    const exactApproval = activeContext.approvals.find(a =>
      a.tool === tool && normalizeScope(a.path) === normFile
    );
    if (exactApproval) {
      return { decision: "approved", reason: "Exact action and path previously approved", approvalOrigin: exactApproval.origin || "unknown" };
    }

    // ─── BUILD WORKSPACE SCOPE (opt-in via setApprovalWorkspace) ───
    // A path inside the armed build workspace root is in-scope. The action was already
    // checked against allowedActions above, and DEFAULT_DENIED_PATHS + maturity gated
    // first. Build paths are repo-relative ("src/App.tsx") or absolute under the root;
    // anything that does not escape the root is the build's own territory.
    if (buildWorkspaceRoot) {
      const root = buildWorkspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      const escapes = normFile.split("/").includes("..");
      const inside = !escapes && (
        (!normFile.startsWith("/") && !/^[A-Za-z]:/.test(normFile)) ||   // repo-relative
        normFile === root || normFile.startsWith(root + "/")              // absolute under root
      );
      if (inside) return { decision: "approved", reason: "Path within armed build workspace root" };
    }

    // Path not in any approved scope — gate it
    console.log("evaluate GATING: Path not in approved scope", { filePath, allowedPaths: activeContext?.allowedPaths, allowedPatterns: activeContext?.allowedPatterns });
    return { decision: "gate", reason: `Path '${filePath}' not in approved scope` };
  }

  // Shell commands — tiered approval
  if (tool === "shell_exec" && args?.command) {
    const cmd = args.command.trim();

    // Read-only commands always pass in any context
    const readOnly = /^(ls|cat|head|tail|grep|rg|find|git\s+(log|diff|status|show|branch)|echo|pwd|which|where|dir|type|wc|sort|uniq|diff)\b/;
    if (readOnly.test(cmd)) {
      return { decision: "approved", reason: "Read-only shell command" };
    }

    // Verification commands pass in any council context (read-verify or implement)
    if (VERIFY_SHELL_COMMANDS.some(rx => rx.test(cmd))) {
      return { decision: "approved", reason: "Verification shell command" };
    }

    // Build/run commands pass only in implement permission level
    if (activeContext.permissionLevel === "implement") {
      const buildCommands = /^(node|npm\s+(run|install|test)|npx|python|pip|cargo|go|make|tsc)\b/;
      if (buildCommands.test(cmd)) {
        return { decision: "approved", reason: "Build/run command in implement mode" };
      }
    }
  }

  // Default: gate anything we're not sure about
  return { decision: "gate", reason: "Action not covered by approval context" };
}

/**
 * Get the current approval context.
 */
export function getApprovalContext() {
  return activeContext;
}

/**
 * Clear the approval context (end of task).
 */
export function clearApprovalContext() {
  activeContext = null;
}

// ─── DEFAULT DENIED PATHS ───
// These are always gated regardless of task scope.

const DEFAULT_DENIED_PATHS = [
  "core/matrix/capability-matrix.js",   // learned the hard way
  "core/bridges/index.js",              // model registry
  "core/gates/",                        // the gate system itself
  "core/governance/",                   // governance injection
  "illuci.md",                             // system doctrine
  "hive_mind.md",                       // canonical truth
  "package.json",                       // dependency management
  ".env",                               // secrets
  "envarapi.env",                       // secrets
];

// ─── MATURITY TRACKING ───
// Files graduate: open → gated → locked as they harden.
// Maturity is earned through evidence: build passes, validation passes,
// stability over time, operator sign-off.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __matdir = dirname(fileURLToPath(import.meta.url));
const MATURITY_PATH = resolve(__matdir, "../../data/maturity.json");

let maturityCache = null;

function loadMaturity() {
  if (maturityCache) return maturityCache;
  if (!existsSync(MATURITY_PATH)) {
    maturityCache = { files: {}, modules: {} };
    return maturityCache;
  }
  maturityCache = JSON.parse(readFileSync(MATURITY_PATH, "utf-8"));
  return maturityCache;
}

function saveMaturity() {
  if (!maturityCache) return;
  mkdirSync(dirname(MATURITY_PATH), { recursive: true });
  writeFileSync(MATURITY_PATH, JSON.stringify(maturityCache, null, 2));
}

/**
 * Get the maturity level of a file.
 * Returns: "open" | "gated" | "locked"
 */
export function getMaturityLevel(filePath) {
  const mat = loadMaturity();

  // Check exact file match
  if (mat.files[filePath]) return mat.files[filePath].level;

  // Check module-level maturity (directory prefix)
  for (const [mod, entry] of Object.entries(mat.modules)) {
    if (filePath.startsWith(mod)) return entry.level;
  }

  return "open";
}

/**
 * Set the maturity level of a file or module.
 * @param {string} path — file path or directory prefix
 * @param {"open"|"gated"|"locked"} level
 * @param {object} evidence — why this level was assigned
 */
export function setMaturityLevel(path, level, evidence = {}) {
  const mat = loadMaturity();
  const isModule = path.endsWith("/");

  const entry = {
    level,
    setAt: new Date().toISOString(),
    setBy: evidence.setBy || "operator",
    reason: evidence.reason || null,
    cdcPasses: evidence.cdcPasses || 0,
    cacPasses: evidence.cacPasses || 0,
    stableRuns: evidence.stableRuns || 0,
  };

  if (isModule) {
    mat.modules[path] = entry;
  } else {
    mat.files[path] = entry;
  }

  maturityCache = mat;
  saveMaturity();
}

/**
 * Record a successful council pass for a file.
 * Automatically graduates maturity when thresholds are met.
 */
export function recordCouncilPass(filePath, type = "cdc") {
  const mat = loadMaturity();
  if (!mat.files[filePath]) {
    mat.files[filePath] = {
      level: "open", setAt: new Date().toISOString(),
      cdcPasses: 0, cacPasses: 0, stableRuns: 0,
    };
  }

  const entry = mat.files[filePath];
  if (type === "cdc") entry.cdcPasses = (entry.cdcPasses || 0) + 1;
  if (type === "cac") entry.cacPasses = (entry.cacPasses || 0) + 1;
  entry.stableRuns = (entry.stableRuns || 0) + 1;

  // Auto-graduation thresholds
  if (entry.level === "open" && entry.cdcPasses >= 1 && entry.cacPasses >= 1) {
    entry.level = "gated";
    entry.graduatedAt = new Date().toISOString();
    entry.graduationReason = "Passed build + validation review";
  }

  if (entry.level === "gated" && entry.stableRuns >= 5 && entry.cacPasses >= 2) {
    entry.level = "locked";
    entry.lockedAt = new Date().toISOString();
    entry.lockReason = "Stable across 5+ runs with 2+ validation passes";
  }

  maturityCache = mat;
  saveMaturity();
}

/**
 * Temporarily unlock a locked file for a specific operation.
 * Returns a function to re-lock when done.
 */
export function temporaryUnlock(filePath, reason) {
  const mat = loadMaturity();
  const entry = mat.files[filePath];
  if (!entry || entry.level !== "locked") return () => {};

  const previousLevel = entry.level;
  entry.level = "gated"; // downgrade to gated, not open
  entry.temporaryUnlock = { reason, at: new Date().toISOString() };
  maturityCache = mat;
  saveMaturity();

  // Return re-lock function
  return () => {
    entry.level = previousLevel;
    delete entry.temporaryUnlock;
    maturityCache = mat;
    saveMaturity();
  };
}

/**
 * List all files with their maturity levels.
 */
export function listMaturity() {
  const mat = loadMaturity();
  return { files: mat.files, modules: mat.modules };
}

// ─── HELPERS ───

function matchGlob(filePath, pattern) {
  const regex = new RegExp(
    "^" + pattern
      .replace(/\*\*/g, "<<<GLOBSTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<GLOBSTAR>>>/g, ".*")
    + "$"
  );
  return regex.test(filePath);
}

// ─── PERMISSION TABLE EXPORTS (additive — DR-classifier TIER 0) ───
// The action classifier's TIER 0 veto needs the categorical set a permission
// LEVEL may EVER perform (PERMISSION_ACTIONS[level]). That is distinct from a
// per-context activeContext.allowedActions (which evaluate() already gates on):
// it is the hard "this level can never do this" ceiling. Exported read-only so
// the classifier reads the single source of truth here instead of mirroring it.
export { PERMISSION_ACTIONS, TOPOLOGY_PERMISSIONS };

export default {
  setApprovalContext, deriveFromTask, setApprovalWorkspace, getApprovalWorkspace,
  recordApproval, recordDenial,
  evaluate, getApprovalContext, clearApprovalContext,
  getMaturityLevel, setMaturityLevel, recordCouncilPass,
  temporaryUnlock, listMaturity,
  PERMISSION_ACTIONS, TOPOLOGY_PERMISSIONS,
};
