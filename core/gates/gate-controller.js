/**
 * Illuci — Gate Controller
 *
 * Mediates tool approval requests during agentic execution.
 * Routes to the active transport:
 *   - Illuci CLI: interactive terminal prompt with colored diff
 *   - Illuci IDE: Electron IPC to operator approval panel (future)
 *   - Headless: fail-closed deny (no operator present)
 *
 * Read operations pass through. Write operations require operator approval.
 * This is how Illuci prevents models from destroying the codebase.
 */

import { GATE_LEVELS } from "./gate-types.js";
import { requiresGate } from "./gate-registry.js";
import { logDecision } from "../decisions/logger.js";
import { promptApproval } from "./cli-gate.js";
import { requestTUIApproval } from "./tui-gate.js";
import { requestBridgeApproval } from "./bridge-gate.js";
import { hasApprovalCallback, requestCallbackApproval } from "./callback-gate.js";
import { evaluate, recordApproval, recordDenial } from "./approval-context.js";
import { isClassifierEnabled } from "./classifier/config.js";
import { buildFeatureContext } from "./classifier/feature-extractor.js";
import { classifyAction } from "./classifier/classifier-arbiter.js";
import { auditClassifierDecision, recentClassifierDecisions } from "./classifier/audit.js";

const MODE = process.env.ILLUCI_GATE_MODE || "cli"; // "cli" | "ide" | "headless"

/**
 * Request approval for a gated tool action.
 *
 * @param {object} params
 * @param {string} params.tool — tool name (file_write, shell_exec, etc.)
 * @param {object} params.args — tool arguments
 * @param {string} params.level — gate level from registry
 * @param {object} params.source — { model, seat, topology, phase }
 * @param {string} params.diff — unified diff if applicable
 * @param {string} params.context — why this action is happening
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
export async function requestApproval(params) {
  const level = params.level || GATE_LEVELS.FULL;

  // No gate needed — reads pass through
  if (level === GATE_LEVELS.NONE) {
    return { approved: true };
  }

  // ─── EVALUATE AGAINST APPROVAL CONTEXT ───
  // Check if this action falls within what the operator already approved.
  // In-scope actions auto-approve. Out-of-scope actions get the prompt.
  // ESCALATED level bypasses auto-approval — always prompt the operator.
  const evaluation = evaluate(params.tool, params.args, params.source);

  if (evaluation.decision === "approved" && level !== GATE_LEVELS.ESCALATED) {
    logDecision({
      humanStatus: evaluation.approvalOrigin && evaluation.approvalOrigin !== "operator" ? "operator-absent" : "operator-approved",
      modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
      context: `Gate auto-approved (in scope): ${params.tool} — ${evaluation.reason}`,
      type: "tool-gate",
      decision: `Auto-approved ${params.tool}(${summarizeArgs(params.args)})`,
      inputs: { tool: params.tool, args: params.args },
      metadata: { level, reason: evaluation.reason, autoApproved: true, approvalOrigin: evaluation.approvalOrigin || "selected-scope" },
    });
    return { approved: true, reason: evaluation.reason };
  }

  if (evaluation.decision === "denied") {
    logDecision({
      humanStatus: "operator-denied",
      modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
      context: `Gate auto-denied (previously rejected): ${params.tool} — ${evaluation.reason}`,
      type: "tool-gate",
      decision: `Auto-denied ${params.tool}(${summarizeArgs(params.args)})`,
      inputs: { tool: params.tool, args: params.args },
      metadata: { level, reason: evaluation.reason, autoDenied: true },
    });
    return { approved: false, reason: evaluation.reason };
  }

  // ─── DARWINIAN-HARDENED ACTION CLASSIFIER (TIER 0 + TIER 1) ───
  // Dark behind ILLUCI_CLASSIFIER_ENABLED (default OFF). Acts ONLY on an
  // out-of-scope "gate" verdict — it never overrides the explicit approved /
  // denied early-returns above. When the flag is OFF the entire block is
  // skipped and the out-of-scope action flows to the existing transports
  // below, byte-identical to pre-classifier behavior. Degrades fail-closed:
  // any thrown error (e.g. a misconfigured feature context) denies.
  if (evaluation.decision === "gate" && isClassifierEnabled()) {
    try {
      const featureCtx = await buildFeatureContext(params, evaluation);
      const cls = await classifyAction(featureCtx);
      auditClassifierDecision(cls, params);
      recentClassifierDecisions.push(cls);

      if (cls.decision === "allow") {
        logDecision({
          humanStatus: "operator-absent",
          modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
          context: `Classifier auto-approved (tier ${cls.tier}): ${params.tool} — ${cls.reason}`,
          type: "classifier-gate",
          decision: `Classifier-approved ${params.tool}(${summarizeArgs(params.args)})`,
          inputs: { tool: params.tool, args: params.args },
          metadata: { level, tier: cls.tier, reason: cls.reason, classifierApproved: true },
        });
        recordApproval(params.tool, params.args, { origin: "classifier" });
        return { approved: true, reason: cls.reason, classifier: cls };
      }

      if (cls.decision === "deny") {
        logDecision({
          humanStatus: "operator-absent",
          modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
          context: `Classifier denied (tier ${cls.tier}): ${params.tool} — ${cls.reason}`,
          type: "classifier-gate",
          decision: `Classifier-denied ${params.tool}(${summarizeArgs(params.args)})`,
          inputs: { tool: params.tool, args: params.args },
          metadata: { level, tier: cls.tier, reason: cls.reason, classifierDenied: true },
        });
        return { approved: false, reason: cls.reason, code: cls.code, classifier: cls };
      }

      // "undecided" — fall through to the existing transport selection below.
    } catch (err) {
      // Fail-closed: a classifier failure denies rather than prompting.
      return { approved: false, reason: `classifier failure: ${err?.message || "unknown"}` };
    }
  }

  // ─── OUT OF SCOPE — PROMPT THE OPERATOR ───

  // In-process callback channel (Agent SDK onPermission). Takes priority over
  // ILLUCI_GATE_MODE: a consumer that registered a channel is the most specific
  // intent available. Additive — no callback registered means this is skipped
  // and the env-routed transports below behave exactly as before.
  if (hasApprovalCallback()) {
    const result = await requestCallbackApproval(params);
    if (result.approved) {
      recordApproval(params.tool, params.args);
    } else if (result.code !== "approval-not-provided") {
      recordDenial(params.tool, params.args, result.reason);
    }
    return result;
  }

  // Illuci CLI: interactive operator prompt with diff display
  if (MODE === "cli") {
    // [A98]/DR-191: an interactive prompt with nobody at the terminal is not a
    // gate — it is a hang. The cli transport is the DEFAULT mode, so every
    // spawned/background process inherited it and blocked forever on a prompt
    // no one could see (first live case: a headless company run hung mid-phase
    // and died as an unsettled await, F-132). When stdin cannot answer, degrade
    // to the headless fail-closed deny LOUDLY — DR-127's law at the transport:
    // pacing without a pacer never runs.
    if (!process.stdin.isTTY) {
      const reason =
        "cli gate transport with no TTY — denied fail-closed (a headless process cannot answer a prompt). " +
        "Run from an interactive terminal, register an approval callback, or set ILLUCI_GATE_MODE=headless explicitly.";
      logDecision({
        humanStatus: "operator-absent",
        modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
        context: `Gate denied (cli transport, no TTY): ${params.tool}`,
        type: "tool-gate",
        decision: `Denied ${params.tool} — cli gate requested but stdin is not a TTY`,
        inputs: { tool: params.tool, args: params.args },
        metadata: { level, mode: MODE, headlessDetected: true },
      });
      recordDenial(params.tool, params.args, reason);
      return { approved: false, reason, code: "headless-no-tty" };
    }

    const result = await promptApproval(params);

    // Record the decision so future similar actions know the operator's intent
    if (result.approved) {
      recordApproval(params.tool, params.args);
    } else {
      recordDenial(params.tool, params.args, result.reason);
    }

    return result;
  }

  // Illuci IDE bridge: programmatic driver (a spawned `illuci run`) over stdout/stdin.
  // The request goes out as an NDJSON line on stdout; the decision returns on stdin.
  if (MODE === "bridge") {
    const result = await requestBridgeApproval(params);
    if (result.approved) {
      recordApproval(params.tool, params.args);
    } else if (result.code !== "approval-not-provided") {
      recordDenial(params.tool, params.args, result.reason);
    }
    return result;
  }

  // Illuci TUI: route to TUI event transport
  if (MODE === "tui") {
    const result = await requestTUIApproval(params);

    // Record the decision so future similar actions know the operator's intent
    if (result.approved) {
      recordApproval(params.tool, params.args);
    } else {
      recordDenial(params.tool, params.args, result.reason);
    }

    return result;
  }

  // Illuci IDE: route to Electron IPC (future)
  if (MODE === "ide") {
    // TODO: emit gate request via IPC, await operator decision in UI
    logDecision({
      humanStatus: "operator-absent",
      modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
      context: `Gate denied (IDE IPC not connected): ${params.tool}`,
      type: "tool-gate",
      decision: `Denied ${params.tool} — IDE approval channel not available`,
      inputs: { tool: params.tool, args: params.args },
      metadata: { level, mode: MODE },
    });
    return { approved: false, reason: "IDE approval channel not connected." };
  }

  // Headless: fail closed — no operator to approve
  logDecision({
    humanStatus: "operator-absent",
    modelStatus: [params.source || { model: "unknown", seat: "unknown" }],
    context: `Gate denied (headless mode): ${params.tool}`,
    type: "tool-gate",
    decision: `Denied ${params.tool} — no operator present`,
    inputs: { tool: params.tool, args: params.args },
    metadata: { level, mode: MODE },
  });
  return { approved: false, reason: "Headless mode — no operator to approve gated actions." };
}

function summarizeArgs(args) {
  if (!args) return "";
  if (args.path) return args.path;
  if (args.command) return args.command.substring(0, 80);
  return JSON.stringify(args).substring(0, 100);
}

export default { requestApproval };
