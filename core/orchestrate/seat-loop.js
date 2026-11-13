// Phase 2 — a topology seat that runs the Think/Act/Observe loop instead of a
// single-shot dispatch, so the seated model can call in-context tools (query_sibling,
// later spawn_topology) and iterate. It reuses the agent SDK's run() wholesale:
// the loop, the permission channel, cancellation, and the tool surface are already
// there. The only new piece is exposing in-context orchestration tools to the loop
// (an mcpTools-shaped bridge, the seam run()/loop.js already accept) and adapting
// the agent-event stream back to the runner's { model, response, usage, seat } shape.
//
// This is OPT-IN: the runner routes a seat here only when it is marked loop-capable,
// so every existing single-shot council is unchanged.

/**
 * Wrap a set of in-context tools ({ name, description, parameters, handler }) as the
 * mcpTools bridge shape loop.js consumes ({ toolNames, instructions, has, execute,
 * close }). The loop routes a parsed tool call whose name `has()` matches here to
 * `execute()`, exactly as it does for external MCP tools — no loop.js change needed.
 */
export function buildSeatToolBridge(tools = []) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const lines = tools.map((t) => {
    const props = t.parameters?.properties ? Object.keys(t.parameters.properties).join(", ") : "";
    return `- ${t.name}: ${t.description || ""}${props ? ` (args: ${props})` : ""}`;
  });
  return {
    toolNames: [...byName.keys()],
    instructions: lines.length
      ? `\n## In-context orchestration tools\nCall these with the same tool-call convention as the built-ins:\n${lines.join("\n")}\n`
      : "",
    has: (name) => byName.has(name),
    async execute(name, args, _ctx = {}) {
      const t = byName.get(name);
      if (!t) return { success: false, error: `Unknown in-context tool: ${name}` };
      try {
        const r = await t.handler(args || {});
        return { success: true, result: typeof r === "string" ? r : JSON.stringify(r) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    async close() {},
  };
}

/**
 * Run one seat as a looping agent. Returns the runner's seat-response shape so the
 * phase executors can treat it identically to a single-shot queryModel result.
 *
 * @param {object} opts
 * @param {string} opts.model      — resolved seat model id
 * @param {string} opts.message    — the composed seat frame (carries the mandate)
 * @param {string} [opts.seat]     — seat id
 * @param {string} [opts.agentId]  — stable assignable agent identity
 * @param {boolean} [opts.requireAssignedAgent] - refuse legacy model fallback for an explicitly assigned instance
 * @param {string} [opts.agentSlug]
 * @param {string} [opts.roleHint]
 * @param {string} [opts.topology]
 * @param {string} [opts.projectId]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.cwd]
 * @param {object} [opts.skillGrants] — resolveSeatGrants output; licenses off-floor MCP
 *   bridges for this seat (DR-112). null → no skill layer, floor governs.
 * @param {Function} [opts.onPermission] — operator permission channel for gated tools
 * @param {AbortSignal} [opts.signal]
 * @param {Array} [opts.tools]     — in-context tools (e.g. [siblingTool])
 * @param {number} [opts.maxSteps]
 * @param {object} [deps]          — test seam forwarded to run() (queryModelStream, executeTool, toolNames)
 * @returns {Promise<{ model, response, usage, error, seat, latency, steps, halted }>}
 */
export async function runSeatLoop(opts, deps = {}) {
  const {
    model, message, seat = null, roleHint = null, topology = null,
    projectId = null, sessionId = null, cwd = null,
    onPermission = null, signal = null, tools = [], maxSteps,
    agentId = null, agentSlug = null, workPermit = null, workPermitRequired = false, requireAssignedAgent = false,
    skillGrants = null,
    capabilityResolution = null,
  } = opts;

  // This is a stricter routing requirement, not authentication or a grant.
  // Legacy unbound callers retain the existing model-keyed behavior.
  if (requireAssignedAgent && (typeof agentId !== "string" || !agentId.trim())) {
    throw Object.assign(new Error("An explicit assigned agent is required"), { code: "ILLUCI_ASSIGNED_AGENT_REQUIRED" });
  }

  // Lazy import: runner.js -> seat-loop.js -> run.js -> council.js -> runner.js is a
  // module cycle; deferring run() to call-time keeps init order clean.
  const { run } = await import("../agent/run.js");

  const seatTools = buildSeatToolBridge(tools);
  const start = Date.now();

  let deltas = "";
  let synthText = null;
  let usage = null;
  let error = null;
  let steps = null;
  let halted = false;

  const input = {
    direction: { messages: [{ role: "user", content: message }] },
    context: { cwd: cwd || undefined, projectId, session: sessionId || undefined },
    config: {
      coordination: "direct",
      agent: model,
      agentId: agentId || model,
      agentSlug,
      seat,
      role: roleHint,
      topology,
      onPermission,
      workPermit,
      workPermitRequired,
      skillGrants,
      capabilityResolution,
      ...(Number.isInteger(maxSteps) ? { maxSteps } : {}),
    },
    signal: signal || undefined,
  };

  for await (const ev of run(input, { ...deps, mcpTools: seatTools })) {
    switch (ev.type) {
      case "text":
        deltas += ev.text || "";
        break;
      case "synthesis":
        // The synthesis text is the authoritative final answer; deltas are a fallback.
        synthText = typeof ev.text === "string" ? ev.text : synthText;
        if (ev.usage) usage = ev.usage;
        break;
      case "error":
        if (ev.fatal) error = ev.error || error;
        break;
      case "run_complete":
        steps = ev.steps ?? steps;
        halted = ev.halted || halted;
        if (ev.usage) usage = ev.usage;
        break;
      default:
        break;
    }
  }

  const finalResponse = synthText != null ? synthText : deltas;
  return {
    model,
    response: error ? null : finalResponse,
    usage,
    error,
    seat,
    latency: Date.now() - start,
    steps,
    halted,
  };
}

export default { buildSeatToolBridge, runSeatLoop };
