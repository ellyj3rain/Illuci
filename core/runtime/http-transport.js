// core/runtime/http-transport.js
//
// [A22.2] Illuci Runtime service — network (HTTP) transport.
// [A22.7] Spec-conformant MCP Streamable-HTTP on the same endpoint.
//
// Makes the runtime remotely reachable so a client needs no local checkout:
//   GET    /health              — liveness (open, no auth)
//   GET    /runtime/identity    — versioned identity        (bootstrap, no MCP needed)
//   GET    /runtime/capability  — normalized capability
//   GET    /runtime/doctor      — deterministic doctor
//   POST   /mcp                 — MCP Streamable-HTTP (JSON-RPC 2.0; JSON or SSE response)
//   GET    /mcp                 — 405 (no server-initiated stream at this cut)
//   DELETE /mcp                 — session termination (spec-optional; supported)
//
// [A22.7] conformance (MCP Streamable HTTP, protocol 2025-06-18 with 2025-03-26/2024-11-05
// accepted): a JSON-RPC NOTIFICATION returns 202 Accepted with no body; `initialize` issues an
// `Mcp-Session-Id` header (sessions are issued, echoed-if-presented, and validated — but not
// REQUIRED, so pre-A22.7 clients that never send the header keep working unchanged); a request
// whose Accept includes `text/event-stream` receives its response as a single SSE `message`
// event on that stream (the seam where server progress notifications stream later); JSON-RPC
// batch arrays reject (removed in 2025-06-18); an unsupported `MCP-Protocol-Version` header
// rejects 400; tokenless dev mode validates Origin against loopback (DNS-rebinding guard —
// token-gated deployments already carry the stronger check).
//
// Mirrors the stdio dispatch in core/mcp/server.js serveStdio() (initialize → serverInfo;
// else handlers[method](msg, ctx)), additively — the stdio path is untouched. Auth is a
// bearer token here; [A22.3] replaces it with per-tenant managed connections (token → tenant
// → that tenant's own credentials, resolved server-side).

import http from "node:http";
import { createCheckpointChannel } from "./checkpoint-channel.js";
import { randomUUID } from "node:crypto";
import { startServer } from "../mcp/server.js";
import { getRuntimeIdentity } from "./identity.js";
import { getRuntimeCapability } from "./capability.js";
import { runtimeDoctor } from "./doctor.js";
import { runWithTenant } from "../connections/tenant-context.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Protocol revisions this transport accepts on the MCP-Protocol-Version header. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);

/**
 * [A22.8] Action verbs on the canonical runtime API. Each verb is a REST wire shape over
 * the SAME governed tools/call pipeline the MCP surface runs (audit boundary, role
 * boundary, work permits — one implementation, two surfaces, so MCP==API holds by
 * construction and the contract tests prove it). A curated table, deliberately NOT a
 * generic /runtime/tool/:name pass-through: only named verbs are REST-exposed.
 */
export const RUNTIME_ACTION_VERBS = Object.freeze({
  "/runtime/run-topology": "run_topology_v1",
  "/runtime/dispatch": "dispatch_v1",
  "/runtime/datastore/query": "datastore_query_v1",
  // [A43] the capability-grant verbs — the runtime capability boundary (MCP == API).
  "/runtime/grants/list": "grants_list_v1",
  "/runtime/grants/issue": "grants_issue_v1",
  "/runtime/grants/revoke": "grants_revoke_v1",
  "/runtime/grants/verify": "grants_verify_v1",
  // [A88] the persona-genome read verbs — read-only, no genesis (MCP == API).
  "/runtime/genome/status": "genome_status_v1",
  "/runtime/genome/profile": "genome_profile_v1",
});

/** Unwrap the MCP tools/call content envelope to the plain canonical-API payload. */
export function unwrapToolEnvelope(envelope) {
  const text = envelope?.content?.[0]?.text;
  if (typeof text !== "string") return envelope;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const SESSION_CAP = 512;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** A JSON-RPC message with no id is a notification (fire-and-forget; 202, no body). */
export function isJsonRpcNotification(msg) {
  return !!msg && msg.jsonrpc === "2.0" && typeof msg.method === "string" && msg.id === undefined;
}

/**
 * In-memory MCP session store (issued on initialize, validated when presented). Bounded:
 * stale sessions expire on touch, and the oldest-by-lastSeen evicts past the cap. Sessions
 * are an affordance, not a wall — requests without a session header remain first-class.
 */
export function createSessionStore({ cap = SESSION_CAP, ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
  const sessions = new Map();
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(id);
    while (sessions.size > cap) {
      let oldestId = null;
      let oldestSeen = Infinity;
      for (const [id, s] of sessions) if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldestId = id; }
      if (oldestId === null) break;
      sessions.delete(oldestId);
    }
  };
  return {
    issue(protocolVersion) {
      sweep();
      const id = randomUUID();
      sessions.set(id, { createdAt: now(), lastSeen: now(), protocolVersion: protocolVersion || MCP_PROTOCOL_VERSION });
      return id;
    },
    touch(id) {
      const s = sessions.get(id);
      if (!s) return false;
      if (s.lastSeen < now() - ttlMs) { sessions.delete(id); return false; }
      s.lastSeen = now();
      return true;
    },
    terminate(id) {
      return sessions.delete(id);
    },
    get size() {
      return sessions.size;
    },
  };
}

/**
 * One JSON-RPC dispatch, mirroring serveStdio's dispatchRequest (no streaming/elicitation
 * over HTTP at this cut — read-shaped tools run synchronously; progress/elicitation is a follow-up).
 * A notification returns null (the transport answers 202 with no body).
 */
export async function dispatchJsonRpc(msg, { handlers, info, tenantId, ctxExtras = null }) {
  const ok = (result) => ({ jsonrpc: "2.0", id: msg?.id ?? null, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code, message } });
  try {
    if (Array.isArray(msg)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC batching is not supported (removed in MCP 2025-06-18)" } };
    }
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return fail(-32600, "Invalid Request");
    }
    if (isJsonRpcNotification(msg)) {
      // Fire-and-forget: run a registered handler if one exists, but never author a response.
      if (handlers[msg.method]) {
        try { await handlers[msg.method](msg, { tenant_id: tenantId, ...(ctxExtras || {}) }); } catch { /* notification errors are not reportable */ }
      }
      return null;
    }
    if (msg.method === "initialize") {
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: info,
      });
    }
    if (handlers[msg.method]) {
      return ok(await handlers[msg.method](msg, { tenant_id: tenantId, ...(ctxExtras || {}) }));
    }
    return fail(-32601, `Method not found: ${msg.method}`);
  } catch (err) {
    return fail(-32000, String(err?.message || err));
  }
}

/** Does the request's Accept header ask for an SSE-framed response? */
function acceptsEventStream(req) {
  return String(req.headers.accept || "").toLowerCase().includes("text/event-stream");
}

/** Loopback origins (+ absent Origin) are fine in tokenless dev mode; anything else is rebinding-shaped. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Start the HTTP transport over the registered MCP handlers + the runtime surface.
 * @returns {Promise<{server: import("node:http").Server, url: string, port: number, close: () => Promise<void>}>}
 */
export async function startHttpTransport({ port = 7473, host = "127.0.0.1", tenantId = "default", token = null } = {}) {
  const mcp = await startServer({ tenantId, transport: "http" });
  const { handlers, info, registry } = mcp;
  const sessions = createSessionStore();
  // [A43] The checkpoint-decision channel: requests ride /runtime/events;
  // decisions arrive at POST /runtime/checkpoint/decision. The port is
  // injected into every MCP handler ctx, so run_topology_v1 can honor
  // runControl.tools.autonomy "checkpointed" over this transport.
  const { emit } = await import("../events/emitter.js");
  const checkpointChannel = createCheckpointChannel({ emit });

  const authorized = (req) => {
    if (!token) return true; // dev-mode: unauthenticated (A22.3 makes a token/tenant mandatory in prod posture)
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;
    return provided === token;
  };

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version,last-event-id",
    "access-control-expose-headers": "mcp-session-id",
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const send = (status, obj, extraHeaders = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...CORS, ...extraHeaders });
      res.end(JSON.stringify(obj));
    };
    /** 202 Accepted, no body — the spec's answer to a notification-only POST. */
    const accepted = (extraHeaders = {}) => {
      res.writeHead(202, { ...CORS, ...extraHeaders });
      res.end();
    };
    /** One JSON-RPC response as a single SSE `message` event, then close (spec: SHOULD close after the response). */
    const sendSse = (payload, extraHeaders = {}) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS, ...extraHeaders });
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    };

    if (req.method === "OPTIONS") return send(204, {});

    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, { status: "ok", runtimeId: "illuci.runtime", tenant: tenantId });
    }
    if (!authorized(req)) return send(401, { error: "unauthorized" });
    // Tokenless dev mode: refuse cross-origin browser calls (DNS-rebinding guard).
    if (!token && !originAllowed(req)) return send(403, { error: "origin not allowed in tokenless dev mode" });

    if (req.method === "GET" && url.pathname === "/runtime/identity") return send(200, getRuntimeIdentity());
    if (req.method === "GET" && url.pathname === "/runtime/capability") return send(200, getRuntimeCapability({ mcpRegistry: registry }));
    if (req.method === "GET" && url.pathname === "/runtime/doctor") return send(200, runtimeDoctor({ mcpRegistry: registry }));
    if (req.method === "GET" && url.pathname === "/runtime/connections") {
      const { listTenantConnections } = await import("../connections/manager.js");
      return send(200, { connections: listTenantConnections(url.searchParams.get("tenant")) });
    }

    // [A26.4] Lane 1a — live event stream over the runtime transport. A remote consumer
    // (the host visualization, any MCP/HTTP client) observes runs WITHOUT the separate
    // `illuci flow` sse-server. Token-gated (past authorized() above); mirrors sse-server.js's
    // broadcast shape { type:"agent-event", event } so an existing canvas subscriber is
    // wire-identical here. NOT tenant-partitioned yet: the emitter is a process-global bus,
    // so a consumer sees every in-process run event (same posture as the flow sse-server;
    // per-tenant event scoping is a follow-up tied to the [A22.3] tenant isolation).
    if (req.method === "GET" && url.pathname === "/runtime/events") {
      const { onEvent } = await import("../events/emitter.js");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS });
      res.write(": illuci runtime event stream open\n\n");
      const unsubscribe = onEvent((event) => {
        try { res.write(`data: ${JSON.stringify({ type: "agent-event", event })}\n\n`); }
        catch { /* client vanished mid-write; req 'close' handles cleanup */ }
      });
      req.on("close", () => { try { unsubscribe(); } catch { /* already gone */ } });
      return;
    }

    // [A43] the checkpoint channel: the approvals queue + the decision intake.
    if (req.method === "GET" && url.pathname === "/runtime/checkpoints") {
      return send(200, { pending: checkpointChannel.pendingRequests() });
    }
    if (req.method === "POST" && url.pathname === "/runtime/checkpoint/decision") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed;
      try { parsed = JSON.parse(body || "{}"); } catch { return send(400, { error: "invalid JSON" }); }
      const result = checkpointChannel.resolveDecision(parsed.checkpointId, { action: parsed.action, intent: parsed.intent });
      return send(result.ok ? 200 : 404, result);
    }

    // [A22.8] canonical-API action verbs: REST in, the governed tools/call pipeline underneath.
    if (req.method === "POST" && RUNTIME_ACTION_VERBS[url.pathname]) {
      const toolName = RUNTIME_ACTION_VERBS[url.pathname];
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
      } catch {
        return send(400, { error: "read error", verb: toolName });
      }
      let args;
      try {
        args = body ? JSON.parse(body) : {};
      } catch {
        return send(400, { error: "request body must be a JSON object of tool arguments", verb: toolName });
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return send(400, { error: "request body must be a JSON object of tool arguments", verb: toolName });
      }
      try {
        // The SAME governed handler the MCP surface dispatches through — never the raw tool.
        // [A44]/F-085: the ctx carries the checkpoint port here exactly as on /mcp — REST
        // and JSON-RPC are two wire shapes over ONE transport, and this transport OWNS the
        // channel, so runControl.tools.autonomy "checkpointed" is honorable over /runtime/run-topology too.
        const envelope = await runWithTenant(tenantId, () =>
          handlers["tools/call"]({ params: { name: toolName, arguments: args } }, { tenant_id: tenantId, checkpointPort: checkpointChannel.port }),
        );
        return send(200, unwrapToolEnvelope(envelope));
      } catch (err) {
        const message = String(err?.message || err);
        const status = /CAPABILITY_DENIED|work permit/i.test(message) ? 403 : 400;
        return send(status, { error: message, verb: toolName });
      }
    }

    if (url.pathname === "/mcp") {
      // Session and protocol-version headers apply to every /mcp method.
      const presentedSession = req.headers["mcp-session-id"];
      const protocolVersion = req.headers["mcp-protocol-version"];
      if (typeof protocolVersion === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
        return send(400, { error: `unsupported MCP-Protocol-Version "${protocolVersion}"`, supported: SUPPORTED_PROTOCOL_VERSIONS });
      }

      if (req.method === "GET") {
        // No server-initiated stream at this cut; the spec's answer is 405.
        return send(405, { error: "no server-initiated stream; POST JSON-RPC to this endpoint" }, { allow: "POST, DELETE" });
      }
      if (req.method === "DELETE") {
        if (typeof presentedSession === "string" && sessions.terminate(presentedSession)) {
          res.writeHead(204, { ...CORS });
          return res.end();
        }
        return send(404, { error: "unknown session" });
      }
      if (req.method !== "POST") {
        return send(405, { error: "method not allowed" }, { allow: "POST, DELETE" });
      }

      // A presented session must be live; an unknown one is the spec's 404 (client re-initializes).
      if (typeof presentedSession === "string" && !sessions.touch(presentedSession)) {
        return send(404, { error: "unknown or expired session; re-initialize" });
      }

      let body = "";
      try {
        for await (const chunk of req) body += chunk;
      } catch {
        return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Read error" } });
      }
      let msg;
      try {
        msg = JSON.parse(body || "null");
      } catch {
        return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }

      // [A22.3.4] open the tenant context so a tenant's request routes with ITS managed credentials.
      const response = await runWithTenant(tenantId, () => dispatchJsonRpc(msg, { handlers, info, tenantId, ctxExtras: { checkpointPort: checkpointChannel.port } }));
      if (response === null) return accepted(); // notification: 202, no body

      // initialize issues a session id the client MAY echo on subsequent requests.
      const issuedHeaders = {};
      if (msg && msg.method === "initialize" && !response.error) {
        issuedHeaders["mcp-session-id"] = sessions.issue(msg.params?.protocolVersion);
      }
      if (acceptsEventStream(req)) return sendSse(response, issuedHeaders);
      return send(200, response, issuedHeaders);
    }

    return send(404, { error: "not found", path: url.pathname });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    sessions,
  };
}

export default {
  startHttpTransport,
  dispatchJsonRpc,
  isJsonRpcNotification,
  createSessionStore,
  unwrapToolEnvelope,
  RUNTIME_ACTION_VERBS,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
};
