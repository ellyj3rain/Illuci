// Test fixture: a minimal MCP stdio server (newline-delimited JSON-RPC 2.0).
// Spawned by agent.test.js to exercise the real mcp-client against a real process.
// Named *.fixture.mjs so the node --test runner does not execute it as a test.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id == null) continue; // a notification (e.g. notifications/initialized)
    if (m.method === "initialize") {
      reply(m.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } });
    } else if (m.method === "tools/list") {
      reply(m.id, { tools: [{ name: "echo", description: "echo the args back", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] });
    } else if (m.method === "tools/call") {
      reply(m.id, { content: [{ type: "text", text: "echo:" + JSON.stringify(m.params?.arguments ?? {}) }] });
    } else {
      reply(m.id, {});
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
