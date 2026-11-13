/**
 * Illuci — TUI Gate Transport
 *
 * Bridge between gate-controller and TUI for operator approvals.
 * Stores pending gate resolvers that the TUI can resolve via keypress.
 */

// Map of pending gate requests: gateId -> { resolve, reject, params, timestamp }
const pendingGates = new Map();

let gateIdCounter = 0;

/**
 * Request approval via TUI transport.
 * Called by gate-controller when MODE === "tui".
 * Returns a promise that resolves when the operator approves/denies via TUI.
 *
 * @param {object} params - Gate parameters from gate-controller
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
export function requestTUIApproval(params) {
  return new Promise((resolve, reject) => {
    const gateId = ++gateIdCounter;
    const gateInfo = {
      resolve,
      reject,
      params,
      timestamp: Date.now(),
      gateId,
    };
    
    pendingGates.set(gateId, gateInfo);
    
    // Auto-reject after 5 minutes to prevent indefinite hanging
    setTimeout(() => {
      if (pendingGates.has(gateId)) {
        pendingGates.delete(gateId);
        reject(new Error("Gate approval timeout (5 minutes)"));
      }
    }, 5 * 60 * 1000);
  });
}

/**
 * Resolve a pending gate request.
 * Called by TUI when operator presses Y/N keys.
 *
 * @param {object} result - { approved: boolean, reason?: string }
 * @returns {boolean} - true if a gate was resolved
 */
export function resolveGate(result) {
  // Find the oldest pending gate
  const entries = Array.from(pendingGates.entries());
  if (entries.length === 0) {
    return false;
  }
  
  // Sort by timestamp and take oldest
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  const [gateId, gateInfo] = entries[0];
  
  pendingGates.delete(gateId);
  gateInfo.resolve(result);
  return true;
}

/**
 * Get the oldest pending gate for display in TUI.
 * Returns null if no gates pending.
 *
 * @returns {object|null} - Gate display params or null
 */
export function getPendingGate() {
  const entries = Array.from(pendingGates.entries());
  if (entries.length === 0) {
    return null;
  }
  
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  const [gateId, gateInfo] = entries[0];
  
  return {
    gateId,
    model: gateInfo.params.source?.model || "unknown",
    seat: gateInfo.params.source?.seat || "?",
    tool: gateInfo.params.tool,
    description: gateInfo.params.context || `Approve ${gateInfo.params.tool}?`,
    diff: gateInfo.params.diff,
    level: gateInfo.params.level,
    timestamp: gateInfo.timestamp,
  };
}

/**
 * Check if there are any pending gates.
 *
 * @returns {boolean}
 */
export function hasPendingGates() {
  return pendingGates.size > 0;
}

/**
 * Clear all pending gates (used on shutdown).
 */
export function clearPendingGates() {
  for (const [gateId, gateInfo] of pendingGates) {
    gateInfo.resolve({ approved: false, reason: "TUI shutdown" });
  }
  pendingGates.clear();
}

export default {
  requestTUIApproval,
  resolveGate,
  getPendingGate,
  hasPendingGates,
  clearPendingGates,
};
