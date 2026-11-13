/**
 * illuci Agent SDK — MCP tool bridge
 *
 * Connects the SDK's agent loop to external Model Context Protocol servers, so a
 * run's tool surface expands by plugging in MCP servers rather than being limited
 * to illuci's built-in executeTool set. This is the CLIENT half of the MCP-boundary
 * discipline (constitutional/10): substrate-talks-to-other-MCP-servers, via the
 * outbound client at core/tools/mcp-client.js.
 *
 * Each server's tools are namespaced `mcp__<server>__<tool>` so they never
 * collide with illuci's built-ins (file_read, shell_exec, …). Every MCP tool call
 * is routed through the operator's permission channel (the same gate-controller
 * the built-in tools use), because an external server's tools are out-of-scope
 * by default — the operator approves them like any other gated action.
 *
 * @typedef {object} McpToolBridge
 * @property {string[]} toolNames                 — namespaced names to add to the run's surface
 * @property {string} instructions                — a tool-instruction block for the model
 * @property {(name: string) => boolean} has      — is this a bridged MCP tool?
 * @property {(name: string, args: object, ctx?: object) => Promise<object>} execute — gated call → executeTool-shaped result
 * @property {() => Promise<void>} close           — disconnect all servers
 */

import { connectMcpServer, contentToText } from "../tools/mcp-client.js";

function nsName(server, tool) {
  return `mcp__${server}__${tool}`;
}

/**
 * Connect a set of MCP servers and expose their tools as a bridge the loop can
 * merge into its surface. Servers that fail to connect are skipped (noted in the
 * instructions) rather than failing the whole run.
 *
 * @param {Array<object>} serverSpecs — [{ name, command, args?, env?, cwd?, timeoutMs? }]
 * @param {object} [deps] — { connectMcpServer, requestApproval } injection seam for tests
 * @returns {Promise<McpToolBridge>}
 */
export async function connectMcpTools(serverSpecs = [], deps = {}) {
  const connect = deps.connectMcpServer || connectMcpServer;
  const gate =
    deps.requestApproval || (await import("../gates/gate-controller.js")).requestApproval;

  const clients = [];
  const toolMap = new Map(); // nsName -> { client, toolName }
  const lines = [];

  for (const spec of serverSpecs) {
    let client;
    try {
      client = await connect(spec);
    } catch (err) {
      lines.push(`# (MCP server "${spec.name || spec.command}" unavailable: ${err.message})`);
      continue;
    }
    clients.push(client);

    let tools = [];
    try {
      tools = await client.listTools();
    } catch {
      tools = [];
    }
    for (const t of tools) {
      const ns = nsName(client.name, t.name);
      toolMap.set(ns, { client, toolName: t.name });
      const argHint =
        t.inputSchema && t.inputSchema.properties
          ? Object.keys(t.inputSchema.properties).join(", ")
          : "";
      lines.push(`- ${ns}: ${t.description || ""}${argHint ? ` (args: ${argHint})` : ""}`);
    }
  }

  const instructions = lines.length
    ? `\n## External tools (MCP)\nThese are provided by connected MCP servers; call them with the same convention:\n${lines.join("\n")}\n`
    : "";

  return {
    toolNames: [...toolMap.keys()],
    instructions,
    has: (name) => toolMap.has(name),

    async execute(name, args, ctx = {}) {
      const entry = toolMap.get(name);
      if (!entry) return { success: false, error: `Unknown MCP tool: ${name}` };

      // External tool calls are out-of-scope by default → routed through the
      // operator's permission channel (same gate as the built-in tools).
      let decision;
      try {
        decision = await gate({
          tool: name,
          args: args || {},
          source: { model: ctx.agentId || null, seat: ctx.agentName || null, mcp: entry.client.name },
          context: `External MCP tool via "${entry.client.name}"`,
        });
      } catch (err) {
        return { success: false, error: `gate error: ${err.message}` };
      }
      if (!decision || !decision.approved) {
        return { success: false, blocked: true, reason: decision?.reason || "operator-rejected" };
      }

      const r = await entry.client.callTool(entry.toolName, args || {});
      if (!r.ok) return { success: false, error: r.error };
      return { success: true, result: contentToText(r.content) };
    },

    async close() {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export default { connectMcpTools };
