// core/runtime/remote-client.js
//
// [A22.6] Illuci Runtime remote client — the payoff of the [A22] runtime service. A caller with only
// a base URL and (for a non-loopback deploy) a bearer token can introspect and drive a hosted Illuci
// with NO local checkout: GET /runtime/{identity,capability,doctor} + POST /mcp (JSON-RPC). This
// module has zero engine imports — it is intentionally self-contained so a downstream host can copy
// it as its whole illuci dependency.

function normalizeBase(url) {
  const b = String(url || "").replace(/\/+$/, "");
  if (!b) throw new Error("illuciRemoteClient: baseUrl is required");
  return b;
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl   e.g. http://192.0.2.10:7473
 * @param {string} [opts.token]   bearer token for the non-health endpoints (required for a LAN deploy)
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function illuciRemoteClient(opts = {}) {
  const base = normalizeBase(opts.baseUrl);
  const timeoutMs = opts.timeoutMs || 30000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("illuciRemoteClient requires fetch");
  const authHeaders = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  let rpcId = 1;

  async function req(path, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { ...init, signal: ctrl.signal, headers: { ...(init.headers || {}), ...authHeaders } });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message || body?.error || `HTTP ${res.status} on ${path}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rpc(method, params = {}) {
    const msg = await req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    });
    if (msg?.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg?.result;
  }

  const post = (path, payload) =>
    req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });

  return {
    baseUrl: base,
    health: () => req("/health"),
    identity: () => req("/runtime/identity"),
    capability: () => req("/runtime/capability"),
    doctor: () => req("/runtime/doctor"),
    // [A22.8] canonical-API action verbs — plain REST over the governed pipeline; no MCP framing needed.
    runTopology: (args = {}) => post("/runtime/run-topology", args),
    dispatch: (args = {}) => post("/runtime/dispatch", args),
    datastoreQuery: (args = {}) => post("/runtime/datastore/query", args),
    // MCP over the network — initialize, list tools/resources, call a tool, read a resource.
    initialize: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "illuci-remote-client", version: "1" } }),
    listTools: async () => (await rpc("tools/list")).tools || [],
    listResources: async () => (await rpc("resources/list")).resources || [],
    callTool: (name, args = {}) => rpc("tools/call", { name, arguments: args }),
    readResource: (uriOrName, args = {}) =>
      rpc("resources/read", String(uriOrName).startsWith("illuci://") ? { uri: uriOrName, arguments: args } : { name: uriOrName, arguments: args }),
  };
}

export default { illuciRemoteClient };
