/**
 * Illuci — Bridge Gate Transport
 *
 * Gate approval for a programmatic driver (e.g. the OTL IDE) that spawns
 * `illuci run` as a child process. The operator is not at illuci's TTY; they are in
 * the driver's UI. So the gate request is written as a single NDJSON line on
 * stdout, and the decision is read back as a single NDJSON line on stdin.
 *
 * Wire protocol (one JSON object per line):
 *   illuci    -> driver:  {"type":"gate_request","id":"<uuid>","tool":...,"args":...,
 *                       "level":...,"source":...,"diff":...,"summary":...}
 *   driver -> illuci:     {"type":"gate_decision","id":"<uuid>","approved":true|false,
 *                       "reason":"...","modifiedContent":"..."}
 *
 * Activated by ILLUCI_GATE_MODE=bridge (see gate-controller.js). Read operations
 * never reach here (gate-controller passes NONE-level actions straight through).
 *
 * @module core/gates/bridge-gate
 */

import readline from "readline";
import { randomUUID } from "crypto";
import { logDecision } from "../decisions/logger.js";

/** id -> resolve fn for each in-flight gate promise. */
const pending = new Map();
let reader = null;

/** Lazily attach a single stdin line reader that resolves pending requests by id. */
function ensureReader() {
  if (reader) return;
  reader = readline.createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON lines on stdin
    }
    if (msg && msg.type === "gate_decision" && msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      const valid = typeof msg.approved === "boolean";
      resolve({
        approved: valid && msg.approved,
        reason:
          !valid ? "Bridge returned a malformed approval decision." :
          typeof msg.reason === "string"
            ? msg.reason
            : msg.approved
              ? "operator-approved"
              : "operator-denied",
        modifiedContent: typeof msg.modifiedContent === "string" ? msg.modifiedContent : undefined,
        ...(!valid ? { code: "approval-not-provided" } : {}),
      });
    }
  });
}

/** Close the stdin reader so the process can exit once the run is done. */
export function closeBridge() {
  if (reader) {
    reader.close();
    reader = null;
  }
  pending.clear();
}

/** A short human-readable summary of the gated action, for the driver UI. */
function describeAction(tool, args = {}) {
  switch (tool) {
    case "file_write":
      return `Write ${args.path} (${(args.content || "").length} chars)`;
    case "file_edit":
      return `Edit ${args.path}`;
    case "file_delete":
      return `Delete ${args.path}`;
    case "file_move":
      return `Move ${args.source || args.from} to ${args.destination || args.to}`;
    case "shell_exec":
      return `Shell: ${(args.command || "").substring(0, 80)}`;
    case "git_commit":
      return `Git commit: ${(args.message || "").substring(0, 60)}`;
    case "git_push":
      return "Git push";
    default:
      return `${tool}: ${JSON.stringify(args).substring(0, 100)}`;
  }
}

/**
 * Emit a gate_request on stdout and await a matching gate_decision on stdin.
 *
 * @param {object} params { tool, args, level, source, diff, context }
 * @returns {Promise<{ approved: boolean, reason?: string, modifiedContent?: string }>}
 */
export async function requestBridgeApproval(params) {
  ensureReader();
  const id = randomUUID();
  const request = {
    type: "gate_request",
    id,
    tool: params.tool,
    args: params.args || {},
    level: params.level || null,
    source: params.source || null,
    diff: params.diff || null,
    summary: describeAction(params.tool, params.args || {}),
  };
  process.stdout.write(JSON.stringify(request) + "\n");

  const decision = await new Promise((resolve) => {
    pending.set(id, resolve);
  });

  logDecision({
    humanStatus: decision.code === "approval-not-provided" ? "operator-absent" : decision.approved ? "operator-approved" : "operator-denied",
    modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
    context: `Bridge gate ${decision.approved ? "approved" : "denied"}: ${params.tool}`,
    type: "tool-gate",
    decision: `${decision.approved ? "Approved" : "Denied"} ${params.tool} via IDE bridge: ${decision.reason}`,
    inputs: { tool: params.tool, args: params.args },
    metadata: { level: params.level, reason: decision.reason, transport: "bridge" },
  });

  return decision;
}

export default { requestBridgeApproval, closeBridge };
