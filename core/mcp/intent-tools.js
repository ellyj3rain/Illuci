/**
 * illuci/core/mcp/intent-tools.js — the IlluciIntent entry verb (the skill-framework spine).
 *
 * illuci_intent_v1 receives a IlluciIntent envelope from a Claude-side skill-framework subskill
 * and dispatches it to the named illuci verb, after seating the session and enforcing the
 * dynamic MCP boundary on the TARGET verb. This is the single machine-readable entry point
 * the CSFM (the Claude illuci-orchestration umbrella) emits to: Claude stays semantic, the
 * envelope is precise, illuci validates + gates + executes.
 *
 * Envelope: { version, subskillId, verb, params, sessionId, roleId, topologyId, seatId, gateRequested }
 *   - verb (required): the registered illuci tool to dispatch to (e.g. role_create_v1).
 *   - sessionId + roleId (optional): seat the session so the boundary resolves it by sessionId later.
 *   - params: forwarded to the target verb's handler.
 *   - gateRequested: carried for the operator-approval gate (the dispatch-tools.js posture flow is
 *     the consumer; full elicitation wiring is a later step) — surfaced in the result for now.
 *
 * Permission: illuci_intent_v1 itself is UNRESTRICTED (a router); the real enforcement is
 * assertMcpToolExposed on the TARGET verb under the envelope's resolved seat. With governance
 * off, the boundary short-circuits and dispatch is behavior-identical.
 *
 * @module core/mcp/intent-tools
 */
import { getSchema } from "./schema-registry.js";
import { setSessionSeat, resolveRoleContext, assertMcpToolExposed } from "./permission-context.js";

export const INTENT_TOOLS = [
  {
    name: "illuci_intent_v1",
    schema_version: "1.0.0",
    description:
      "The IlluciIntent entry verb: receive a skill-framework envelope and dispatch it to a named " +
      "illuci verb, seating the session and enforcing the dynamic MCP boundary on the TARGET verb. " +
      "The single machine-readable entry point the Claude illuci-orchestration umbrella emits to.",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string" },
        subskillId: { type: "string" },
        verb: { type: "string", description: "The registered illuci tool to dispatch to (e.g. role_create_v1)." },
        params: { type: "object", description: "Forwarded to the target verb's handler." },
        sessionId: { type: "string" },
        roleId: { type: "string", description: "The seat's role; seats the session + drives the boundary." },
        topologyId: { type: ["string", "null"] },
        seatId: { type: ["string", "null"] },
        gateRequested: { type: "boolean" },
      },
      required: ["verb"],
    },
    async handler(args = {}, ctx = {}) {
      const { verb, params = {}, sessionId, roleId, topologyId = null, seatId = null, gateRequested = false } = args;
      if (!verb || typeof verb !== "string") return { ok: false, error: "illuci_intent_v1: 'verb' (string) is required" };
      if (verb === "illuci_intent_v1") return { ok: false, error: "illuci_intent_v1: refusing to dispatch to itself" };
      const target = getSchema(verb);
      if (!target || target.kind !== "tool" || typeof target.definition?.handler !== "function") {
        return { ok: false, error: `illuci_intent_v1: unknown verb '${verb}'` };
      }
      // Seat the session so the boundary can resolve this seat by sessionId on later calls.
      if (typeof sessionId === "string" && sessionId !== "" && typeof roleId === "string" && roleId !== "") {
        setSessionSeat(sessionId, { roleId, topologyId, seatId });
      }
      // Enforce the dynamic MCP boundary on the TARGET verb under the envelope's seat.
      const roleCtx = resolveRoleContext({ roleId, sessionId, topologyId, seatId });
      try {
        assertMcpToolExposed(verb, roleCtx);
      } catch (e) {
        return { ok: false, denied: e.code, verb, error: e.message };
      }
      // Dispatch to the target verb.
      const result = await target.definition.handler(params, ctx);
      return { ok: true, verb, gateRequested, result };
    },
  },
];

export default { INTENT_TOOLS };
