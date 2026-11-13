/**
 * illuci — Gate Types
 *
 * Type definitions for the gated write decision system.
 * Mirrors the TypeScript interfaces in the architecture spec.
 */

/**
 * Gate levels for different action types
 * @readonly
 */
export const GATE_LEVELS = {
  NONE: 'none',           // Always allowed
  FULL: 'full',           // Requires explicit approval with diff view
  ESCALATED: 'escalated', // Double-confirm for dangerous operations
};

/**
 * Action types that can be gated
 * @readonly
 */
export const GATE_ACTIONS = {
  FILE_WRITE: 'file_write',
  FILE_EDIT: 'file_edit',
  FILE_DELETE: 'file_delete',
  FILE_MOVE: 'file_move',
  FILE_RENAME: 'file_rename',
  SHELL_EXEC: 'shell_exec',
  GIT_PUSH: 'git_push',
  GIT_FORCE_PUSH: 'git_force_push',
  GIT_RESET: 'git_reset',
};

/**
 * Creates a new GateRequest
 * @param {Object} params
 * @returns {GateRequest}
 */
export function createGateRequest({
  sessionId,
  phaseId,
  agentId,
  agentName,
  topologyId,
  action,
  level,
  filePath,
  contentBefore,
  contentAfter,
  diff,
  command,
  workingDirectory,
  timeout = 300000, // 5 minutes default
}) {
  const timestamp = new Date().toISOString();
  const id = `GATE-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

  return {
    id,
    sessionId,
    phaseId,
    agentId,
    agentName,
    topologyId,
    action,
    level,
    filePath,
    contentBefore,
    contentAfter,
    diff,
    command,
    workingDirectory,
    timestamp,
    timeout,
  };
}

/**
 * Creates a new GateDecision
 * @param {Object} params
 * @returns {GateDecision}
 */
export function createGateDecision({
  gateId,
  approved,
  operatorNote,
  modifiedContent,
}) {
  return {
    gateId,
    approved,
    operatorNote,
    modifiedContent,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Gate request state as stored in the pending map
 */
export class PendingGate {
  constructor(request) {
    this.request = request;
    this.resolve = null;
    this.reject = null;
    this.timer = null;
    this.createdAt = Date.now();
  }

  /**
   * Check if this gate has expired
   * @returns {boolean}
   */
  isExpired() {
    return Date.now() - this.createdAt > this.request.timeout;
  }

  /**
   * Get milliseconds remaining before timeout
   * @returns {number}
   */
  getTimeRemaining() {
    const remaining = this.request.timeout - (Date.now() - this.createdAt);
    return Math.max(0, remaining);
  }
}

export default {
  GATE_LEVELS,
  GATE_ACTIONS,
  createGateRequest,
  createGateDecision,
  PendingGate,
};
