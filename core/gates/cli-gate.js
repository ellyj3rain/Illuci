/**
 * Illuci — CLI Gate Transport
 *
 * Interactive gate approval for the ILLUCI CLI. When a model proposes
 * a file write, shell command, or any gated action, this renders
 * the proposal in the terminal with:
 *
 *   - What model proposed it and from what seat
 *   - Natural language summary of what the change does
 *   - Colored diff of the proposed change
 *   - Context from the shared store (why this change is happening)
 *   - Approve / Reject / Modify prompt
 *
 * This replaces the blanket-deny behavior in gate-controller.js
 * when running from the CLI.
 */

import readline from "readline";
import { GATE_LEVELS } from "./gate-types.js";
import { logDecision } from "../decisions/logger.js";

// ANSI color helpers
const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

/**
 * Render a colored unified diff in the terminal.
 */
function renderDiff(diff) {
  if (!diff) return c.dim("  (no diff available)");

  return diff.split("\n").map(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) return c.green(line);
    if (line.startsWith("-") && !line.startsWith("---")) return c.red(line);
    if (line.startsWith("@@")) return c.cyan(line);
    if (line.startsWith("diff") || line.startsWith("---") || line.startsWith("+++")) return c.bold(line);
    return c.dim(line);
  }).join("\n");
}

/**
 * Build a human-readable summary of what the tool action does.
 */
function describeAction(tool, args) {
  switch (tool) {
    case "file_write":
      return `Write file: ${args.path} (${(args.content || "").length} chars)`;
    case "file_edit":
      return `Edit file: ${args.path}\n  Replace: "${(args.oldString || "").substring(0, 60)}..."\n  With:    "${(args.newString || "").substring(0, 60)}..."`;
    case "file_delete":
      return `Delete file: ${args.path}`;
    case "file_move":
      return `Move: ${args.from} → ${args.to}`;
    case "shell_exec":
      return `Shell command: ${args.command}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "git_add":
      return `Git add: ${Array.isArray(args.paths) ? args.paths.join(", ") : args.paths}`;
    case "git_commit":
      return `Git commit: "${args.message}"`;
    case "git_push":
      return `Git push${args.remote ? ` to ${args.remote}` : ""}${args.branch ? ` branch ${args.branch}` : ""}`;
    case "git_reset":
      return `Git reset${args.hard ? " --hard" : ""} ${args.ref || ""}`;
    default:
      return `${tool}: ${JSON.stringify(args).substring(0, 120)}`;
  }
}

/**
 * Prompt the operator for approval in the CLI.
 * Returns a promise that resolves with the decision.
 *
 * @param {object} params
 * @param {string} params.tool — tool name
 * @param {object} params.args — tool arguments
 * @param {string} params.level — GATE_LEVELS value
 * @param {object} params.source — { model, seat, topology, phase }
 * @param {string} params.diff — unified diff if applicable
 * @param {string} params.context — why this action is happening
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
export async function promptApproval(params) {
  const { tool, args, level, source, diff, context: actionContext } = params;
  const model = source?.model || "unknown";
  const seat = source?.seat || "unknown";

  // Build the gate display
  const lines = [];
  lines.push("");
  lines.push(c.yellow("┌─────────────────────────────────────────────────────────────┐"));
  lines.push(c.yellow("│") + c.bold("  GATE APPROVAL REQUEST") + c.yellow("                                        │"));
  lines.push(c.yellow("└─────────────────────────────────────────────────────────────┘"));
  lines.push("");
  lines.push(`  ${c.bold("Model:")}  ${c.cyan(model)}  ${c.dim(`(${seat})`)}`);
  lines.push(`  ${c.bold("Action:")} ${describeAction(tool, args || {})}`);
  lines.push(`  ${c.bold("Level:")}  ${level === GATE_LEVELS.ESCALATED ? c.red(level) : c.yellow(level)}`);

  if (actionContext) {
    lines.push(`  ${c.bold("Why:")}    ${c.dim(actionContext.substring(0, 120))}`);
  }

  if (diff) {
    lines.push("");
    lines.push(c.bold("  Diff:"));
    lines.push(renderDiff(diff).split("\n").map(l => `  ${l}`).join("\n"));
  }

  if (tool === "file_write" && args?.content) {
    const preview = args.content.substring(0, 500);
    const truncated = args.content.length > 500 ? `\n  ${c.dim(`... (${args.content.length - 500} more chars)`)}` : "";
    lines.push("");
    lines.push(c.bold("  Content preview:"));
    lines.push(c.dim(preview.split("\n").map(l => `  ${l}`).join("\n") + truncated));
  }

  lines.push("");

  if (level === GATE_LEVELS.ESCALATED) {
    lines.push(c.red("  ⚠ ESCALATED — This action is destructive or hard to reverse."));
    lines.push("");
  }

  // Print the gate
  console.log(lines.join("\n"));

  // Prompt
  const answer = await askUser(
    level === GATE_LEVELS.ESCALATED
      ? c.red("  Approve? [y/N/reason] > ")
      : c.yellow("  Approve? [Y/n/reason] > ")
  );

  const trimmed = answer.trim().toLowerCase();
  const defaultApproved = level !== GATE_LEVELS.ESCALATED; // ESCALATED defaults to deny

  let approved;
  let reason;

  if (trimmed === "" ) {
    approved = defaultApproved;
    reason = defaultApproved ? "operator-default-approve" : "operator-default-deny";
  } else if (trimmed === "y" || trimmed === "yes") {
    approved = true;
    reason = "operator-approved";
  } else if (trimmed === "n" || trimmed === "no") {
    approved = false;
    reason = "operator-denied";
  } else {
    // Anything else is a denial with the text as the reason
    approved = false;
    reason = answer.trim();
  }

  // Log the decision
  logDecision({
    humanStatus: approved ? "operator-approved" : "operator-denied",
    modelStatus: [source || { model: "unknown", seat: "unknown" }],
    context: `Gate ${approved ? "approved" : "denied"}: ${tool}(${describeAction(tool, args || {}).substring(0, 80)})`,
    type: "tool-gate",
    decision: `${approved ? "Approved" : "Denied"} ${tool} — ${reason}`,
    inputs: { tool, args },
    metadata: { level, reason },
  });

  if (approved) {
    console.log(c.green("  ✓ Approved\n"));
  } else {
    console.log(c.red(`  ✗ Denied${reason !== "operator-denied" && reason !== "operator-default-deny" ? `: ${reason}` : ""}\n`));
  }

  return { approved, reason };
}

/**
 * Ask the user a question via stdin.
 */
function askUser(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export default { promptApproval };
