/**
 * illuci — Write Gate
 *
 * Every model-initiated filesystem mutation must pass through this gate.
 * The operator sees exactly what will change, approves or rejects, and
 * the decision is provenance-stamped.
 *
 * Two modes:
 *   - IDE mode (Electron): proposals sent via IPC to renderer for visual approval
 *   - CLI mode: proposals auto-approved with log (operator is at the terminal)
 *
 * The gate is async — proposeWrite() returns a promise that resolves when
 * the operator decides. It does NOT block the topology runner.
 */

import { readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { logDecision } from "../decisions/logger.js";
import { applyPolicy } from "./policy.js";
import { generateDiff } from "./diff.js";

// ─── PROPOSAL QUEUE ───

let proposalId = 0;
const pending = new Map(); // id → { proposal, resolve, reject, timer }
let onProposalCallback = null; // Set by Electron main process

/**
 * Register a callback for when new proposals arrive.
 * Electron's main.js calls this to bridge proposals to the renderer.
 */
export function onProposal(callback) {
  onProposalCallback = callback;
}

/**
 * Propose a filesystem write. Returns a promise that resolves when approved
 * or rejects when denied/timed out.
 *
 * @param {object} params
 * @param {string} params.operation - 'create' | 'modify' | 'delete' | 'rename'
 * @param {string} params.path - Target file path
 * @param {string} params.content - New content (for create/modify)
 * @param {string} params.newPath - New path (for rename)
 * @param {object} params.source - { model, seat, topology, phase }
 * @param {number} params.timeoutMs - Timeout before auto-reject (default: 300000 = 5min)
 * @param {string} params.groupId - Group related proposals for batch approval
 * @returns {Promise<{ approved: boolean, proposalId: string }>}
 */
export async function proposeWrite(params) {
  const {
    operation, path, content, newPath,
    source = {}, timeoutMs = 300000, groupId = null,
  } = params;

  // ─── Policy check (deny patterns, auto-approve) ───
  const policyResult = applyPolicy(operation, path);
  if (policyResult.denied) {
    logDecision({
      humanStatus: "operator-absent",
      modelStatus: source,
      context: `Write gate: DENIED by policy — ${policyResult.reason}`,
      type: "write-gate",
      decision: `Denied ${operation} on ${path}: ${policyResult.reason}`,
    });
    return { approved: false, proposalId: null, reason: policyResult.reason };
  }

  if (policyResult.autoApproved) {
    // Execute immediately, log it
    executeWrite(operation, path, content, newPath);
    logDecision({
      humanStatus: "operator-approved",
      modelStatus: source,
      context: `Write gate: auto-approved by policy — ${policyResult.reason}`,
      type: "write-gate",
      decision: `Auto-approved ${operation} on ${path}`,
    });
    return { approved: true, proposalId: null, reason: policyResult.reason };
  }

  // ─── Build proposal ───
  const id = `wp-${++proposalId}-${Date.now()}`;
  const originalContent = (operation === "modify" || operation === "delete") && existsSync(path)
    ? readFileSync(path, "utf-8")
    : null;

  const diff = operation === "modify" && originalContent !== null
    ? generateDiff(originalContent, content, path)
    : null;

  const proposal = {
    id,
    timestamp: new Date().toISOString(),
    source,
    operation,
    path,
    content: operation === "create" || operation === "modify" ? content : undefined,
    newPath: operation === "rename" ? newPath : undefined,
    originalContent,
    diff,
    groupId,
  };

  // ─── If no UI is listening (CLI mode), auto-approve ───
  if (!onProposalCallback) {
    executeWrite(operation, path, content, newPath);
    logDecision({
      humanStatus: "operator-initiated",
      modelStatus: source,
      context: `Write gate: auto-approved (CLI mode, no IDE connected)`,
      type: "write-gate",
      decision: `CLI auto-approved ${operation} on ${path}`,
    });
    return { approved: true, proposalId: id };
  }

  // ─── Queue for operator approval ───
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      logDecision({
        humanStatus: "operator-absent",
        modelStatus: source,
        context: `Write gate: TIMEOUT (${timeoutMs}ms) — fail-closed`,
        type: "write-gate",
        decision: `Timed out waiting for approval on ${operation} ${path}`,
      });
      resolve({ approved: false, proposalId: id, reason: "timeout" });
    }, timeoutMs);

    pending.set(id, { proposal, resolve, reject, timer });

    // Notify the UI
    onProposalCallback(proposal);
  });
}

/**
 * Operator decides on a proposal.
 *
 * @param {string} id - Proposal ID
 * @param {boolean} approved
 * @param {string} operator - Who approved (default: "operator")
 * @param {string} reason - Optional rejection reason
 */
export function decide(id, approved, operator = "operator", reason = "") {
  const entry = pending.get(id);
  if (!entry) return { error: "Proposal not found or already decided" };

  clearTimeout(entry.timer);
  pending.delete(id);

  const { proposal, resolve } = entry;

  if (approved) {
    executeWrite(proposal.operation, proposal.path, proposal.content, proposal.newPath);
  }

  logDecision({
    humanStatus: approved ? "operator-approved" : "operator-overridden",
    modelStatus: proposal.source,
    context: `Write gate: ${approved ? "APPROVED" : "REJECTED"} — ${proposal.operation} on ${proposal.path}`,
    type: "write-gate",
    decision: `${approved ? "Approved" : "Rejected"} ${proposal.operation} on ${proposal.path}${reason ? ": " + reason : ""}`,
    metadata: {
      proposalId: id,
      operator,
      operation: proposal.operation,
      path: proposal.path,
    },
  });

  resolve({ approved, proposalId: id, reason });
  return { ok: true };
}

/**
 * Batch approve/reject all proposals in a group.
 */
export function decideGroup(groupId, approved, operator = "operator", reason = "") {
  const results = [];
  for (const [id, entry] of pending.entries()) {
    if (entry.proposal.groupId === groupId) {
      results.push(decide(id, approved, operator, reason));
    }
  }
  return results;
}

/**
 * Get all pending proposals.
 */
export function getPending() {
  return [...pending.values()].map(e => e.proposal);
}

/**
 * Get pending count.
 */
export function getPendingCount() {
  return pending.size;
}

// ─── EXECUTION ───

function executeWrite(operation, path, content, newPath) {
  switch (operation) {
    case "create":
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
      break;
    case "modify":
      writeFileSync(path, content, "utf-8");
      break;
    case "delete":
      if (existsSync(path)) unlinkSync(path);
      break;
    case "rename":
      if (existsSync(path)) renameSync(path, newPath);
      break;
  }
}

// ─── UNDO ───
// Store last N approved writes for undo capability

const undoStack = [];
const MAX_UNDO = 50;

// Wrap executeWrite to capture undo state
const _originalExecute = executeWrite;

function executeWriteWithUndo(operation, path, content, newPath) {
  // Capture state before execution
  const originalContent = existsSync(path) ? readFileSync(path, "utf-8") : null;
  const originalExists = existsSync(path);

  _originalExecute(operation, path, content, newPath);

  undoStack.push({
    operation,
    path,
    newPath,
    originalContent,
    originalExists,
    timestamp: new Date().toISOString(),
  });

  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

/**
 * Undo the last approved write.
 */
export function undo() {
  const last = undoStack.pop();
  if (!last) return { error: "Nothing to undo" };

  switch (last.operation) {
    case "create":
      if (existsSync(last.path)) unlinkSync(last.path);
      break;
    case "modify":
      if (last.originalContent !== null) {
        writeFileSync(last.path, last.originalContent, "utf-8");
      }
      break;
    case "delete":
      if (last.originalContent !== null) {
        writeFileSync(last.path, last.originalContent, "utf-8");
      }
      break;
    case "rename":
      if (existsSync(last.newPath)) {
        renameSync(last.newPath, last.path);
      }
      break;
  }

  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: { model: "system", seat: "undo" },
    context: `Write gate: UNDO — ${last.operation} on ${last.path}`,
    type: "write-gate-undo",
    decision: `Undid ${last.operation} on ${last.path}`,
  });

  return { ok: true, undone: last };
}

export function getUndoCount() {
  return undoStack.length;
}

export default {
  onProposal, proposeWrite, decide, decideGroup,
  getPending, getPendingCount, undo, getUndoCount,
};
