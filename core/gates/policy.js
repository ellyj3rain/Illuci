/**
 * illuci — Write Gate Policy
 *
 * Configurable rules for the write gate:
 *   - Deny patterns: always block (secrets, credentials, keys)
 *   - Auto-approve patterns: skip the gate for low-risk files
 *   - Default: require explicit operator approval
 *
 * Conservative defaults — nothing auto-approved out of the box.
 */

import { basename } from "path";

// ─── DEFAULT POLICY ───

const policy = {
  // Files that are NEVER writable by models — hard deny
  denyPatterns: [
    ".env",
    ".env.*",
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    "credentials.*",
    "secrets.*",
    "**/node_modules/**",
    "**/.git/**",
    "envarapi.env",
  ],

  // Files auto-approved without operator prompt (empty by default = approve nothing)
  autoApprovePatterns: [],

  // Maximum pending proposals before blocking new ones
  maxPending: 50,
};

// ─── PATTERN MATCHING ───

function matchesPattern(filePath, pattern) {
  const normalized = filePath.replace(/\\/g, "/");
  const name = basename(normalized);

  // Exact filename match
  if (pattern === name) return true;

  // Glob-style matching
  if (pattern.startsWith("**/")) {
    const suffix = pattern.slice(3);
    if (matchesPattern(normalized, suffix)) return true;
    return normalized.includes("/" + suffix) || normalized.includes("\\" + suffix);
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return normalized.startsWith(prefix) || normalized.includes("/" + prefix);
  }

  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return name.endsWith(ext);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return regex.test(name) || regex.test(normalized);
  }

  return name === pattern || normalized.endsWith("/" + pattern);
}

// ─── POLICY APPLICATION ───

/**
 * Apply policy to a proposed write operation.
 *
 * @param {string} operation - 'create' | 'modify' | 'delete' | 'rename'
 * @param {string} filePath
 * @returns {{ denied: boolean, autoApproved: boolean, reason: string }}
 */
export function applyPolicy(operation, filePath) {
  // Check deny patterns first (highest priority)
  for (const pattern of policy.denyPatterns) {
    if (matchesPattern(filePath, pattern)) {
      return {
        denied: true,
        autoApproved: false,
        reason: `Matches deny pattern: ${pattern}`,
      };
    }
  }

  // Check auto-approve patterns
  for (const pattern of policy.autoApprovePatterns) {
    if (matchesPattern(filePath, pattern)) {
      return {
        denied: false,
        autoApproved: true,
        reason: `Matches auto-approve pattern: ${pattern}`,
      };
    }
  }

  // Default: require approval
  return {
    denied: false,
    autoApproved: false,
    reason: "Requires operator approval",
  };
}

/**
 * Update policy at runtime.
 */
export function updatePolicy(updates) {
  if (updates.denyPatterns) policy.denyPatterns = updates.denyPatterns;
  if (updates.autoApprovePatterns) policy.autoApprovePatterns = updates.autoApprovePatterns;
  if (updates.maxPending !== undefined) policy.maxPending = updates.maxPending;
}

/**
 * Get current policy.
 */
export function getPolicy() {
  return { ...policy };
}

export default { applyPolicy, updatePolicy, getPolicy };
