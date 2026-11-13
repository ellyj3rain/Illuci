/**
 * illuci — Action Classifier · Feature Extractor
 *
 * buildFeatureContext(params, evaluation) assembles the REAL, validated signal
 * the arbiter judges on. No invented fields — every value traces to a concrete
 * source that exists today:
 *
 *   - params.tool            — the tool name being gated
 *   - params.args            — target path / command
 *   - params.source          — { model, seat, topology, phase }
 *   - getApprovalContext()   — allowedActions, permissionLevel,
 *                              allowedPaths/Patterns/deniedPaths (the active
 *                              trust boundary set by the operator)
 *   - workspaceRoot          — getWorkspaceRoot() (the contained root)
 *   - seat sandbox workdir   — getSandbox(source.seat)?.workdir (the seat's
 *                              intended worktree, when seated)
 *   - target git worktree    — getGitInfo(targetPath) (the worktree that
 *                              actually OWNS the target path)
 *
 * Validation is strict: a misconfigured / absent context throws. The single
 * caller (gate-controller) wraps this in try/catch and FAILS CLOSED (deny) on
 * any throw — so a misconfiguration can never silently widen permission.
 *
 * @module core/gates/classifier/feature-extractor
 */

import { getApprovalContext } from "../approval-context.js";
import { getWorkspaceRoot } from "../../bridges/tools.js";
import { getSandbox } from "../../sandbox/workspace.js";
import { getGitInfo } from "./utils/getGitInfo.js";

/**
 * Pull the target path from tool args. file_move uses `from`/`source`; the
 * approval-context evaluator already treats `args.path || args.from` as the
 * subject path, so mirror that, plus `source` for file_move.
 *
 * @param {object} args
 * @returns {string|null}
 */
function targetPathOf(args) {
  if (!args || typeof args !== "object") return null;
  return args.path || args.from || args.source || args.destination || null;
}

/**
 * @typedef {object} FeatureContext
 * @property {string} tool
 * @property {object} args
 * @property {string|null} targetPath
 * @property {string|null} command
 * @property {object} source — { model, seat, topology, phase }
 * @property {string|null} seatId
 * @property {string} permissionLevel
 * @property {string[]} allowedActions
 * @property {string[]} allowedPaths
 * @property {string[]} allowedPatterns
 * @property {string[]} deniedPaths
 * @property {string|null} workspaceRoot
 * @property {string|null} seatWorktreeRoot — the seat sandbox .workdir (intended worktree)
 * @property {object} targetGit — { worktreeRoot, normalizedRoot, queryDir } from getGitInfo
 * @property {object} evaluation — the upstream evaluate() result that produced "gate"
 */

/**
 * Build the validated feature context for a gate decision.
 *
 * @param {object} params — the gate-controller params ({ tool, args, source, ... })
 * @param {object} evaluation — the upstream evaluate() verdict ({ decision, reason })
 * @returns {Promise<FeatureContext>}
 * @throws {Error} on misconfiguration (no tool, no active approval context, etc.)
 */
export async function buildFeatureContext(params, evaluation) {
  if (!params || typeof params !== "object") {
    throw new Error("classifier: params missing or not an object");
  }
  if (typeof params.tool !== "string" || params.tool.length === 0) {
    throw new Error("classifier: params.tool missing");
  }

  const ctx = getApprovalContext();
  if (!ctx) {
    // No active approval context = no permission level to judge against. The
    // classifier must not guess; fail closed via the caller.
    throw new Error("classifier: no active approval context");
  }
  if (typeof ctx.permissionLevel !== "string" || ctx.permissionLevel.length === 0) {
    throw new Error("classifier: approval context has no permissionLevel");
  }
  if (!Array.isArray(ctx.allowedActions)) {
    throw new Error("classifier: approval context allowedActions is not an array");
  }

  const args = params.args && typeof params.args === "object" ? params.args : {};
  const source = params.source && typeof params.source === "object" ? params.source : {};
  const targetPath = targetPathOf(args);
  const command = typeof args.command === "string" ? args.command : null;

  const seatId = typeof source.seat === "string" ? source.seat : null;
  const sandbox = seatId ? getSandbox(seatId) : null;
  const seatWorktreeRoot = sandbox && typeof sandbox.workdir === "string" ? sandbox.workdir : null;

  let workspaceRoot = null;
  try {
    workspaceRoot = getWorkspaceRoot() || null;
  } catch {
    workspaceRoot = null;
  }

  // Resolve the target's OWNING git worktree. Only meaningful for path-bearing
  // tools; for command-only tools (shell_exec without a path) there is no path
  // to attribute, so leave it unresolved (null root, treated safely downstream).
  const targetGit = targetPath
    ? getGitInfo(targetPath)
    : { worktreeRoot: null, normalizedRoot: null, queryDir: "" };

  return {
    tool: params.tool,
    args,
    targetPath,
    command,
    source,
    seatId,
    permissionLevel: ctx.permissionLevel,
    allowedActions: ctx.allowedActions,
    allowedPaths: Array.isArray(ctx.allowedPaths) ? ctx.allowedPaths : [],
    allowedPatterns: Array.isArray(ctx.allowedPatterns) ? ctx.allowedPatterns : [],
    deniedPaths: Array.isArray(ctx.deniedPaths) ? ctx.deniedPaths : [],
    workspaceRoot,
    seatWorktreeRoot,
    targetGit,
    evaluation: evaluation || null,
  };
}

export default { buildFeatureContext };
