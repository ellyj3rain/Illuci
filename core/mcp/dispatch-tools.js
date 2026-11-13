import {rejectUnsupportedBoundWork} from '../agent/work-boundary.js';
/**
 * MCP dispatch tools.
 *
 * This boundary consumes the upstream run-control ontology instead of owning
 * independent run modes. Gate posture governs approval behavior. Run-control
 * governs agenda strategy, mutation authority, and tool autonomy.
 */

import { normalizeRunControl, runControlBlocksPhaseMutation, runControlAutonomy } from "../orchestrate/run-control.js";
import { normalizeChildIdentity } from "../orchestrate/child-identity.js";
import { normalizeGradingSources } from "../agents/genome-grading-sources.js";
import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Select the existing host-bound project, never client-asserted authority. */
export function m5ProjectOptions(args = {}, ctx = {}) {
  const selected = args.agentContinuity !== undefined && args.agentContinuity !== false;
  if (args.perceive !== undefined && typeof args.perceive !== "boolean") throw Error("run_topology_v1: perceive must be boolean");
  if (!selected) {
    if (args.projectDir !== undefined) throw Error("run_topology_v1: projectDir requires an explicit agentContinuity selection");
    return { options: args.perceive === undefined ? {} : { perceive: args.perceive }, selected: false };
  }
  const control = args.agentContinuity;
  if (!control || typeof control !== "object" || Array.isArray(control) ||
      Object.keys(control).some(k => !["limit", "share", "after"].includes(k)) ||
      (Object.hasOwn(control, "limit") && (!Number.isInteger(control.limit) || control.limit < 1 || control.limit > 20))) {
    throw Error("run_topology_v1: agentContinuity must be false or a bounded selection object");
  }
  if (typeof ctx.principalContext?.snapshot !== "function") throw Error("run_topology_v1: selected M5 requires an existing host-bound principal project");
  const binding = ctx.principalContext.snapshot().binding;
  let projectDir;
  try {
    if (typeof binding?.workspaceId !== "string" || !isAbsolute(binding.workspaceId)) throw Error("missing");
    projectDir = realpathSync(binding.workspaceId);
    if (args.projectDir !== undefined && (typeof args.projectDir !== "string" || !isAbsolute(args.projectDir) ||
        realpathSync(resolve(args.projectDir)) !== projectDir)) throw Error("mismatch");
  } catch { throw Error("run_topology_v1: M5 project is unavailable or differs from the bound principal project"); }
  return { selected: true, options: { projectDir, agentContinuity: structuredClone(control),
    ...(args.perceive === undefined ? {} : { perceive: args.perceive }) } };
}

/** Calling-client receipt: cursors and hashes, not recipient history views. */
export function m5PreparedReceipt(trace) {
  return { scope: "prepared frame/cursor references; not model receipt, use or authority",
    recipients: (trace?.agentContinuity?.preparedFrames || []).map(frame => ({
      recipientId: frame.recipientId, sha256: frame.sha256,
      sources: [frame.references?.self, ...(frame.references?.peers || [])].filter(Boolean)
        .map(view => ({ agentId: view.agentId, status: view.status, cursor: view.cursor ? {
          sessionId: view.cursor.sessionId, runId: view.cursor.runId, sha256: view.cursor.sha256,
        } : null })),
    })) };
}

const continuityCursorSchema = { type: "object", properties: {
  sessionId: { type: "string" }, runId: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
}, required: ["sessionId", "runId", "sha256"], additionalProperties: false };
const continuitySelectionSchema = { oneOf: [{ type: "boolean", const: false }, { type: "object", properties: {
  limit: { type: "integer", minimum: 1, maximum: 20 },
  share: { type: "object", maxProperties: 64, additionalProperties: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string" } } },
  after: { type: "object", maxProperties: 64, additionalProperties: { type: "object", maxProperties: 64, additionalProperties: continuityCursorSchema } },
}, additionalProperties: false }] };

export const POSTURES = Object.freeze(["ask", "accept-edits", "bypass"]);

export function postureWriteMode(posture) {
  return posture === "bypass" || posture === "accept-edits";
}

function validatePosture(posture) {
  if (posture != null && !POSTURES.includes(posture)) {
    throw new Error(`posture must be one of ${POSTURES.join(", ")} (got "${posture}")`);
  }
}

export function mcpStepFromPhaseResponse(phaseId, response = {}) {
  return {
    phaseId,
    model: response.model ?? response.facilitator ?? null,
    ...(response.round ? { round: response.round } : {}),
    ...(response.reasoningSummary ? { reasoningSummary: response.reasoningSummary } : {}),
    ...(response.failed ? { failed: true, error: response.error || "seat dispatch failed" } : {}),
    output: response.response ?? response.mergedArtifact ?? response.question ?? "",
  };
}

export function traceHaltFields(trace) {
  if (!trace?.halted) return {};
  return { halted: true, haltedAt: trace.haltedAt ?? null, haltReason: trace.haltReason ?? null };
}

const FILE_WRITE_TOOL = /file_(write|edit|create)|^(write|edit)$/i;

export function makeGateCallback(posture, elicit) {
  return async (params = {}) => {
    const action = params.tool || params.action || "action";
    if (posture === "accept-edits" && FILE_WRITE_TOOL.test(action)) {
      return { approved: true, reason: "accept-edits: file write auto-approved" };
    }
    const summary = params.args ? JSON.stringify(params.args).slice(0, 200) : "";
    const res = await elicit({
      message: `Approve ${action}${summary ? `: ${summary}` : ""}?`,
      requestedSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    });
    const approved = res?.action === "accept" && res?.content?.approved === true;
    const explicitlyDenied = res?.action === "decline" ||
      (res?.action === "accept" && res?.content?.approved === false);
    return {
      approved,
      reason: approved ? "operator approved via elicitation" :
        explicitlyDenied ? "operator declined via elicitation" : "no valid approval provided via elicitation",
      ...(!approved && !explicitlyDenied ? { code: "approval-not-provided" } : {}),
    };
  };
}

function runControlInputSchema() {
  return {
    type: "object",
    properties: {
      agenda: {
        type: "object",
        properties: {
          strategy: { type: "string", enum: ["conducted", "derived", "ritual"] },
        },
      },
      execution: {
        type: "object",
        properties: {
          mutationAuthority: { type: "string", enum: ["gated", "blocked"] },
        },
      },
      tools: {
        type: "object",
        properties: {
          autonomy: { type: "string", enum: ["directed", "checkpointed", "governed", "autonomous"] },
        },
      },
    },
  };
}

export const DISPATCH_TOOLS = [
  {
    name: "dispatch_v1",
    schema_version: "1.0.0",
    description:
      "Dispatch one prompt to one fleet model and return its response. Gate posture controls write-mode above Illuci's hard-deny floor.",
    requiredActions: ["shell_exec"],
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "A Illuci fleet model id." },
        prompt: { type: "string", description: "The user message to dispatch." },
        systemPrompt: { type: "string", description: "Optional system prompt prepended for this dispatch." },
        posture: { type: "string", enum: [...POSTURES], description: "Gate posture: ask, accept-edits, or bypass." },
        sessionState: { type: "array", description: "Optional prior turns ([{role, content}, ...]).", items: { type: "object" } },
        reasoning: { type: "string", description: "Optional reasoning tier." },
        thinking: { type: "boolean", description: "Optional model thinking control." },
        params: { type: "object", description: "Optional generation parameters." },
        timeoutMs: { type: "number", description: "Optional caller timeout in milliseconds." },
        creationDecision: { type: "object", description: "Existing scope/work record for a selected consequential creation: action create; record, requirement, existingSystem.surfaces with owner, revision, responsibilities, contracts, demonstratedBehavior, adequate and reason; remaining gap, boundary and owner." },
      },
      required: ["model", "prompt"],
    },
    async handler(args = {}, ctx = {}) {
      rejectUnsupportedBoundWork(ctx,'MCP fleet dispatch/child orchestration');
      const { model, prompt, systemPrompt, posture = "ask", sessionState, reasoning, thinking, params, timeoutMs, creationDecision } = args;
      if (!model || typeof model !== "string") throw new Error("dispatch_v1: model (string) is required");
      if (!prompt || typeof prompt !== "string") throw new Error("dispatch_v1: prompt (string) is required");
      validatePosture(posture);

      const writeMode = postureWriteMode(posture);
      const opts = {
        seat: "mcp-dispatch",
        writeMode,
        ...(creationDecision !== undefined ? { creationDecision } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(Array.isArray(sessionState) ? { sessionState } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(typeof thinking === "boolean" ? { thinking } : {}),
        ...(params && typeof params === "object" && !Array.isArray(params) ? { params } : {}),
        ...(Number.isFinite(Number(timeoutMs)) ? { timeoutMs: Number(timeoutMs) } : {}),
      };
      const gate = writeMode ? "auto-approve above hard-deny floor" : "gated";

      if (ctx && typeof ctx.notify === "function") {
        const { queryModelStream } = await import("../dispatch/dispatch.js");
        let acc = "", usage = {}, latencyMs = null, finalModel = model, finalResponse = null, finalFailed = null;
        for await (const ev of queryModelStream(model, prompt, opts)) {
          if (ev.type === "delta") {
            if (ev.text && ev.reasoning) ctx.notify({ message: ev.text, reasoning: true });
            else if (ev.text) { acc += ev.text; ctx.notify({ message: ev.text }); }
          } else if (ev.type === "final") {
            usage = ev.usage || {};
            latencyMs = ev.latency ?? null;
            finalModel = ev.model || model;
            finalResponse = ev.response ?? null;
            if (ev.failed) finalFailed = ev.error || "dispatch failed";
          } else if (ev.type === "error") {
            throw new Error(ev.error || "dispatch_v1: dispatch failed");
          }
        }
        if (finalFailed) throw new Error(finalFailed);
        return { model: finalModel, response: acc || finalResponse || "", usage, latencyMs, posture, gate, streamed: true };
      }

      const { queryModel } = await import("../dispatch/dispatch.js");
      const res = await queryModel(model, prompt, opts);
      if (res?.failed) throw new Error(`${res.code ? `${res.code}: ` : ""}${res.error || "dispatch_v1: dispatch failed"}`);
      return {
        model: res?.model || model,
        response: res?.response ?? "",
        usage: res?.usage || {},
        latencyMs: res?.latency ?? null,
        posture,
        gate,
        streamed: false,
        skipped: res?.skipped || false,
      };
    },
  },
  {
    name: "run_topology_v1",
    schema_version: "1.0.0",
    description:
      "Run one Illuci topology over a task. Runtime control is supplied only through the runControl envelope.",
    requiredActions: ["shell_exec"],
    inputSchema: {
      type: "object",
      properties: {
        topology: { type: "string", description: "A topology id." },
        task: { type: "string", description: "The task the topology works on." },
        assignments: { type: "object", description: "Optional per-seat model choices." },
        agents: { type: "object", description: "Optional agent assignment manifest." },
        seatAgents: { type: "object", description: "Optional per-seat agent bindings." },
        projectDir: { type: "string", description: "Optional server-side M5 project selector. It must match the existing host-bound principal project; it is never an access grant or a cwd fallback." },
        agentContinuity: { ...continuitySelectionSchema, description: "Optional host-bound M5 structural change selection. Source/recipient IDs must be assigned agents. false/absent preserves existing MCP behavior; selected mode requires the trusted host's principal-work context." },
        perceive: { type: "boolean", description: "Existing post-run model perception control. false omits the independent model-keyed perception calls; primary execution and its permission gates remain unchanged." },
        skillFrameworks: { type: ["array", "object", "string"], description: "Optional skill-framework use requests." },
        seatSkillFrameworks: { type: "object", description: "Optional per-seat skill-framework requests." },
        workPermits: { type: "object", description: "Optional work permits keyed by agent id or slug." },
        workPermitRequired: { type: "boolean", description: "Require a matching work permit before tool/capability execution." },
        posture: { type: "string", enum: [...POSTURES], description: "Gate posture: ask, accept-edits, or bypass." },
        runControl: runControlInputSchema(),
        reasoning: { type: "string", description: "Optional reasoning tier override." },
        thinking: { type: "boolean", description: "Optional model thinking control." },
        params: { type: "object", description: "Optional generation parameters." },
        timeoutMs: { type: "number", description: "Optional caller timeout in milliseconds." },
        preflight: { type: "string", enum: ["off", "config", "probe"], description: "Optional readiness gate." },
        adaptive: { type: ["boolean", "object"], description: "Optional adaptive control-cycle policy." },
        genome: {
          type: "object",
          description:
            "Optional persona-genome arm (DR-182): { projectDir (string, required when present), " +
            "precedence ('seed'|'dominant'|'pull'), sealThreshold (integer, 0 disables), " +
            "childIdentity ('none'|'inherit'|'derive'|'explicit'), " +
            "gradingSources (string[], default ['tension']; 'salient' is a disclosed opt-in that " +
            "reinforces expressed poles but is NOT attribution-grounded — DR-194) }. Takes effect " +
            "only with seated durable agents (the agents/seatAgents manifest) on preset seats.",
        },
      },
      required: ["topology", "task"],
    },
    async handler(args = {}, ctx = {}) {
      rejectUnsupportedBoundWork(ctx,'MCP fleet dispatch/child orchestration');
      const {
        topology,
        task,
        assignments,
        agents,
        seatAgents,
        skillFrameworks,
        seatSkillFrameworks,
        workPermits,
        workPermitRequired,
        posture = "ask",
        runControl: rawRunControl,
        reasoning,
        thinking,
        params,
        timeoutMs,
        adaptive,
        preflight,
        genome,
      } = args;
      if (!topology || typeof topology !== "string") throw new Error("run_topology_v1: topology (string) is required");
      if (!task || typeof task !== "string") throw new Error("run_topology_v1: task (string) is required");
      const m5 = m5ProjectOptions(args, ctx);
      // [A90]/DR-182 P1: the genome arm fails closed at the boundary, before any
      // topology lookup or dispatch — same law as the resolver's projectDir gate.
      if (genome !== undefined) {
        if (typeof genome !== "object" || genome === null || Array.isArray(genome)) {
          throw new Error("run_topology_v1: genome must be an object { projectDir, precedence?, sealThreshold?, childIdentity? }");
        }
        if (!genome.projectDir || typeof genome.projectDir !== "string") {
          throw new Error("run_topology_v1: genome.projectDir (string) is required when genome is armed");
        }
        // [A91]/DR-184: the childIdentity state validates at the verb boundary
        // through the ONE policy module — unknown or Phase-3 states die here.
        try {
          normalizeChildIdentity(genome);
        } catch (err) {
          throw new Error(`run_topology_v1: ${err.message}`);
        }
        // [A101]/DR-194: the grading-sources control validates at the boundary
        // too (default ["tension"]; "salient" is the disclosed opt-in) — an
        // unknown/reserved source fails closed here, not silently at grade time.
        if (genome.gradingSources !== undefined) {
          try {
            genome.gradingSources = [...normalizeGradingSources(genome.gradingSources)];
          } catch (err) {
            throw new Error(`run_topology_v1: ${err.message}`);
          }
        }
      }
      validatePosture(posture);
      const runControl = normalizeRunControl({ runControl: rawRunControl || {} });
      if (preflight !== undefined && !["off", "config", "probe"].includes(preflight)) {
        throw new Error(`run_topology_v1: preflight must be one of off|config|probe (got "${preflight}")`);
      }
      if (adaptive !== undefined && typeof adaptive !== "boolean" && (typeof adaptive !== "object" || adaptive === null || Array.isArray(adaptive))) {
        throw new Error("run_topology_v1: adaptive must be a boolean or a policy object { enabled?, maxLoopsPerPhase?, maxTotalReroutes? }");
      }
      if (runControlAutonomy(runControl) === "checkpointed" && typeof ctx?.checkpointPort !== "function") {
        throw new Error('run_topology_v1: runControl.tools.autonomy "checkpointed" requires a fire-control checkpoint port');
      }

      const { TOPOLOGIES } = await import("../topologies/index.js");
      if (!TOPOLOGIES[topology]) {
        throw new Error(`run_topology_v1: unknown topology "${topology}". available: ${Object.keys(TOPOLOGIES).join(", ")}`);
      }

      const canElicit = !!(ctx && typeof ctx.elicit === "function");
      let useGateCallback = false;
      let gateLabel = "auto-approve above hard-deny floor";
      if (posture === "ask") {
        if (!canElicit && !runControlBlocksPhaseMutation(runControl)) {
          throw new Error("run_topology_v1: posture ask requires ctx.elicit unless runControl.execution.mutationAuthority is blocked");
        }
        useGateCallback = canElicit && !runControlBlocksPhaseMutation(runControl);
        gateLabel = useGateCallback ? "per-action elicitation" : "mutation effects blocked by run-control";
      } else if (posture === "accept-edits") {
        gateLabel = "accept-edits above hard-deny floor";
      }

      let cbRegistered = false;
      if (useGateCallback) {
        const { registerApprovalCallback } = await import("../gates/callback-gate.js");
        registerApprovalCallback(makeGateCallback(posture, ctx.elicit));
        cbRegistered = true;
      }

      let unsub = null;
      if (ctx && typeof ctx.notify === "function") {
        const { onEvent } = await import("../events/emitter.js");
        unsub = onEvent((event) => {
          const t = event?.type || event?.event_type;
          if (!t) return;
          const phase = event.phaseId || event.phase || "";
          try { ctx.notify({ message: phase ? `${t}: ${phase}` : t }); } catch {}
        });
      }

      let trace;
      try {
        const { runTopology } = await import("../topologies/runner.js");
        trace = await runTopology(topology, assignments || {}, task, {
          humanStatus: "operator-initiated",
          context: `mcp run_topology_v1: ${topology}`,
          runControl,
          ...(agents ? { agents } : {}),
          ...(seatAgents ? { seatAgents } : {}),
          ...m5.options,
          ...(genome ? { genome } : {}),
          ...(skillFrameworks ? { skillFrameworks } : {}),
          ...(seatSkillFrameworks ? { seatSkillFrameworks } : {}),
          ...(workPermits ? { workPermits } : {}),
          ...(workPermitRequired === true ? { workPermitRequired: true } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(typeof thinking === "boolean" ? { thinking } : {}),
          ...(params && typeof params === "object" && !Array.isArray(params) ? { params } : {}),
          ...(Number.isFinite(Number(timeoutMs)) ? { timeoutMs: Number(timeoutMs) } : {}),
          ...(preflight !== undefined ? { preflight } : {}),
          ...(runControlAutonomy(runControl) === "checkpointed" && typeof ctx?.checkpointPort === "function" ? { checkpoint: ctx.checkpointPort } : {}),
          ...(adaptive !== undefined ? { adaptive } : {}),
        });
      } finally {
        if (unsub) unsub();
        if (cbRegistered) {
          const { clearApprovalCallback } = await import("../gates/callback-gate.js");
          clearApprovalCallback();
        }
      }

      const steps = [];
      for (const [phaseId, phase] of Object.entries(trace?.phases || {})) {
        for (const r of phase.responses || []) steps.push(mcpStepFromPhaseResponse(phaseId, r));
      }
      return {
        topology,
        topologyName: trace?.topologyName || topology,
        totalLatencyMs: trace?.totalLatency ?? null,
        posture,
        gate: gateLabel,
        elicits: useGateCallback,
        streamed: !!unsub,
        runControl: trace?.runControl || runControl,
        skillFrameworkUses: trace?.skillFrameworkUses || {},
        ...(m5.selected ? { agentContinuity: m5PreparedReceipt(trace) } : {}),
        ...traceHaltFields(trace),
        steps,
      };
    },
  },
];

export default { DISPATCH_TOOLS, POSTURES, postureWriteMode, makeGateCallback, mcpStepFromPhaseResponse, traceHaltFields };
