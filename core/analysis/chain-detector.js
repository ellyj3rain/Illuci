/**
 * illuci — Tool Chain Analysis
 *
 * Tracks tool call sequences per session and flags escalation patterns.
 * Detects multi-step attack chains that individually pass gating but
 * collectively constitute privilege escalation or data exfiltration.
 *
 * Flagged patterns:
 *   - read-credential → http_fetch (data exfiltration)
 *   - file_read → file_write → shell_exec (staged code execution)
 *   - clipboard_get → http_fetch (clipboard exfiltration)
 *   - file_read(.env) → any outbound (credential leak)
 *   - process_list → process_kill (process manipulation)
 *   - screenshot → http_fetch (screen exfiltration)
 *
 * Flags are advisory — they log to the decision registry and emit events
 * but do not block execution. The operator reviews flagged chains.
 */

import { logDecision } from "../decisions/logger.js";

// ─── SESSION CHAIN STORAGE ───

const sessionChains = new Map(); // sessionId → [{ tool, args, timestamp, model }]

// ─── ESCALATION PATTERNS ───

const CHAIN_PATTERNS = [
  {
    name: "credential-exfiltration",
    description: "Sensitive file read followed by outbound HTTP",
    severity: "CRITICAL",
    match: (chain) => {
      const credRead = chain.find(c =>
        c.tool === "file_read" &&
        /\.(env|key|pem|credentials|secrets)/i.test(c.args?.path || "")
      );
      const egress = chain.find(c =>
        c.tool === "http_fetch" && c.timestamp > (credRead?.timestamp || 0)
      );
      return credRead && egress ? { trigger: credRead, target: egress } : null;
    },
  },
  {
    name: "staged-code-execution",
    description: "File read → file write → shell exec (staged payload)",
    severity: "HIGH",
    match: (chain) => {
      const read = chain.find(c => c.tool === "file_read");
      const write = chain.find(c =>
        ["file_write", "file_edit"].includes(c.tool) &&
        c.timestamp > (read?.timestamp || 0)
      );
      const exec = chain.find(c =>
        c.tool === "shell_exec" &&
        c.timestamp > (write?.timestamp || 0)
      );
      return read && write && exec ? { trigger: read, middle: write, target: exec } : null;
    },
  },
  {
    name: "clipboard-exfiltration",
    description: "Clipboard read followed by outbound HTTP",
    severity: "HIGH",
    match: (chain) => {
      const clip = chain.find(c => c.tool === "clipboard_get");
      const egress = chain.find(c =>
        c.tool === "http_fetch" && c.timestamp > (clip?.timestamp || 0)
      );
      return clip && egress ? { trigger: clip, target: egress } : null;
    },
  },
  {
    name: "screenshot-exfiltration",
    description: "Screenshot followed by outbound HTTP",
    severity: "HIGH",
    match: (chain) => {
      const shot = chain.find(c => c.tool === "screenshot");
      const egress = chain.find(c =>
        c.tool === "http_fetch" && c.timestamp > (shot?.timestamp || 0)
      );
      return shot && egress ? { trigger: shot, target: egress } : null;
    },
  },
  {
    name: "process-manipulation",
    description: "Process enumeration followed by kill",
    severity: "MEDIUM",
    match: (chain) => {
      const list = chain.find(c => c.tool === "process_list");
      const kill = chain.find(c =>
        c.tool === "process_kill" && c.timestamp > (list?.timestamp || 0)
      );
      return list && kill ? { trigger: list, target: kill } : null;
    },
  },
  {
    name: "gui-credential-theft",
    description: "Window focus followed by keyboard input (potential password entry)",
    severity: "CRITICAL",
    match: (chain) => {
      const focus = chain.find(c => c.tool === "window_focus");
      const type = chain.find(c =>
        ["key_type", "key_press", "key_combo"].includes(c.tool) &&
        c.timestamp > (focus?.timestamp || 0)
      );
      return focus && type ? { trigger: focus, target: type } : null;
    },
  },
];

// ─── PUBLIC API ───

/**
 * Record a tool call in the session chain.
 */
export function recordToolCall(sessionId, tool, args, model) {
  if (!sessionId) return;

  if (!sessionChains.has(sessionId)) {
    sessionChains.set(sessionId, []);
  }

  const chain = sessionChains.get(sessionId);
  chain.push({
    tool,
    args: args ? { path: args.path, command: args.command?.substring(0, 100), url: args.url } : {},
    timestamp: Date.now(),
    model,
  });

  // Keep only last 50 calls per session to bound memory
  if (chain.length > 50) chain.shift();
}

/**
 * Analyze the current session chain for escalation patterns.
 * Returns array of flagged patterns.
 */
export function analyzeChain(sessionId) {
  const chain = sessionChains.get(sessionId);
  if (!chain || chain.length < 2) return [];

  const flags = [];
  for (const pattern of CHAIN_PATTERNS) {
    const match = pattern.match(chain);
    if (match) {
      flags.push({
        name: pattern.name,
        description: pattern.description,
        severity: pattern.severity,
        match,
      });
    }
  }

  // Log any flags to decision registry
  for (const flag of flags) {
    logDecision({
      humanStatus: "operator-absent",
      modelStatus: [{ model: flag.match.trigger?.model || "unknown", seat: "chain-detector" }],
      context: `CHAIN FLAG [${flag.severity}]: ${flag.name} — ${flag.description}`,
      type: "tool-chain-flag",
      decision: `Flagged: ${flag.name} (${flag.severity})`,
      inputs: { pattern: flag.name, chain: chain.slice(-5) },
      metadata: { severity: flag.severity, match: flag.match },
    });
  }

  return flags;
}

/**
 * Clear session chain data.
 */
export function clearChain(sessionId) {
  sessionChains.delete(sessionId);
}

/**
 * Get the current chain for a session (for debugging/audit).
 */
export function getChain(sessionId) {
  return sessionChains.get(sessionId) || [];
}

export default { recordToolCall, analyzeChain, clearChain, getChain };
