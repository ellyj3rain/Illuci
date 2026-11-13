// Hand-rolled JSON-RPC 2.0 over newline-delimited stdio. Shared transport for illuci's boundary
// servers (MCP, ACP). stdout is the protocol channel; everything else goes to stderr.
// Extracted from core/mcp/server.js serveStdio() per the ACP-adapter ruling.

export async function serveJsonRpcStdio({ onInitialize, handlers = {}, onNotification = null }) {
  console.log = (...a) => console.error(...a);

  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  // Server-initiated requests (ACP session/request_permission, MCP elicitation/create):
  // resolve by a server-side id the client echoes back on its response line.
  const pending = new Map();
  let seq = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = `srv-${++seq}`;
      pending.set(id, resolve);
      write({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

  const ctx = { write, notify, request };

  const dispatch = async (msg) => {
    try {
      if (msg.method === "initialize") {
        ok(msg.id, onInitialize ? await onInitialize(msg.params || {}, ctx) : {});
      } else if (handlers[msg.method]) {
        ok(msg.id, await handlers[msg.method](msg.params || {}, ctx));
      } else {
        fail(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      fail(msg.id, -32000, String(err?.message || err));
    }
  };

  // Synchronous reader: parse and route only, never await, so a server-initiated request's
  // response routes back while a handler is mid-await on it.
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === undefined && msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg.error ? { error: msg.error } : (msg.result ?? {}));
        continue;
      }
      if (msg.id == null) { if (onNotification) onNotification(msg); continue; }
      void dispatch(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

export default { serveJsonRpcStdio };
