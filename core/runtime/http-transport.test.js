// core/runtime/http-transport.test.js
// [A22.2] Illuci Runtime service — network transport integration tests (real HTTP, ephemeral port).

import test from "node:test";
import assert from "node:assert/strict";
import { startHttpTransport } from "./http-transport.js";

test("http transport: runtime endpoints + MCP JSON-RPC over the wire", async () => {
  const svc = await startHttpTransport({ port: 0, tenantId: "http-test" });
  try {
    let r = await fetch(`${svc.url}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal((await r.json()).tenant, "http-test");

    r = await fetch(`${svc.url}/runtime/identity`);
    const id = await r.json();
    assert.equal(id.runtimeId, "illuci.runtime");
    assert.ok(id.version, "version present");

    r = await fetch(`${svc.url}/runtime/doctor`);
    const doc = await r.json();
    assert.ok(["ok", "ok-dirty", "degraded"].includes(doc.status));
    assert.ok(doc.capability.counts.providers > 0);

    r = await fetch(`${svc.url}/runtime/capability`);
    const cap = await r.json();
    assert.ok(cap.mcp && Array.isArray(cap.mcp.tools), "MCP tool facet present over HTTP (registry injected)");
    assert.equal(cap.models.find((m) => m.registryId === "nim-riva-translate-4b")?.fleetUse, "delegate");
    assert.ok(Array.isArray(cap.models.find((m) => m.registryId === "nim-riva-translate-4b")?.capabilityLanes));

    r = await fetch(`${svc.url}/runtime/capability`, { method: "OPTIONS" });
    assert.equal(r.status, 204);

    // MCP initialize handshake over HTTP
    r = await fetch(`${svc.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const init = await r.json();
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(init.id, 1);
    assert.ok(init.result.serverInfo && init.result.protocolVersion, "serverInfo + protocolVersion");

    // A registered handler (tools/list) reached over HTTP
    r = await fetch(`${svc.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const tools = await r.json();
    assert.equal(tools.id, 2);
    assert.ok(tools.result, "tools/list returned a result over HTTP");

    // unknown method → JSON-RPC method-not-found
    r = await fetch(`${svc.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope/nope", params: {} }),
    });
    assert.equal((await r.json()).error.code, -32601);
  } finally {
    await svc.close();
  }
});

test("http transport: [A22.7] MCP Streamable-HTTP conformance", async (t) => {
  const svc = await startHttpTransport({ port: 0, tenantId: "streamable-test" });
  try {
    const post = (body, headers = {}) =>
      fetch(`${svc.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    await t.test("a notification returns 202 Accepted with no body", async () => {
      const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      assert.equal(r.status, 202);
      assert.equal(await r.text(), "");
    });

    await t.test("initialize issues an Mcp-Session-Id; echoing it is accepted; unknown session is 404", async () => {
      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      const sessionId = init.headers.get("mcp-session-id");
      assert.ok(sessionId, "initialize issues a session id header");
      assert.equal((await init.json()).result.protocolVersion, "2025-06-18");

      const echoed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": sessionId });
      assert.equal(echoed.status, 200);
      assert.ok((await echoed.json()).result, "echoed session id is accepted");

      const unknown = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { "mcp-session-id": "no-such-session" });
      assert.equal(unknown.status, 404, "unknown session → 404 so the client re-initializes");
    });

    await t.test("sessionless requests keep working (sessions are issued, not required)", async () => {
      const r = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
      assert.equal(r.status, 200);
      assert.ok((await r.json()).result);
    });

    await t.test("DELETE terminates a live session (204); unknown is 404; GET is 405", async () => {
      const init = await post({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
      const sessionId = init.headers.get("mcp-session-id");
      const del = await fetch(`${svc.url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
      assert.equal(del.status, 204);
      const delAgain = await fetch(`${svc.url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
      assert.equal(delAgain.status, 404, "terminated session is gone");
      const stale = await post({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }, { "mcp-session-id": sessionId });
      assert.equal(stale.status, 404, "a terminated session no longer authenticates requests");

      const get = await fetch(`${svc.url}/mcp`);
      assert.equal(get.status, 405, "no server-initiated stream at this cut");
      assert.match(get.headers.get("allow") || "", /POST/);
    });

    await t.test("Accept: text/event-stream gets the response as a single SSE message event", async () => {
      const r = await post(
        { jsonrpc: "2.0", id: 7, method: "initialize", params: {} },
        { accept: "application/json, text/event-stream" },
      );
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") || "", /^text\/event-stream/);
      assert.ok(r.headers.get("mcp-session-id"), "session header rides the SSE response too");
      const text = await r.text();
      assert.match(text, /^event: message\ndata: /, "SSE framing");
      const payload = JSON.parse(text.replace(/^event: message\ndata: /, "").trim());
      assert.equal(payload.id, 7);
      assert.equal(payload.result.protocolVersion, "2025-06-18");
    });

    await t.test("JSON-RPC batch arrays reject (-32600; removed in 2025-06-18)", async () => {
      const r = await post([{ jsonrpc: "2.0", id: 8, method: "tools/list" }]);
      assert.equal((await r.json()).error.code, -32600);
    });

    await t.test("an unsupported MCP-Protocol-Version header rejects 400; supported ones pass", async () => {
      const bad = await post({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { "mcp-protocol-version": "1999-01-01" });
      assert.equal(bad.status, 400);
      const good = await post({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }, { "mcp-protocol-version": "2025-03-26" });
      assert.equal(good.status, 200);
    });

    await t.test("tokenless dev mode refuses a non-loopback Origin (DNS-rebinding guard)", async () => {
      const r = await post({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }, { origin: "http://evil.example" });
      assert.equal(r.status, 403);
      const local = await post({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }, { origin: "http://localhost:3000" });
      assert.equal(local.status, 200);
    });
  } finally {
    await svc.close();
  }
});

test("http transport: bearer token gates non-health endpoints", async () => {
  const svc = await startHttpTransport({ port: 0, tenantId: "auth-test", token: "s3cr3t" });
  try {
    assert.equal((await fetch(`${svc.url}/health`)).status, 200, "health is open");
    assert.equal((await fetch(`${svc.url}/runtime/identity`)).status, 401, "no token → 401");
    const ok = await fetch(`${svc.url}/runtime/identity`, { headers: { authorization: "Bearer s3cr3t" } });
    assert.equal(ok.status, 200, "valid token → 200");
    // [A26.4] the event stream is a non-health endpoint → also gated.
    assert.equal((await fetch(`${svc.url}/runtime/events`)).status, 401, "no token → 401 on /runtime/events");
  } finally {
    await svc.close();
  }
});

test("http transport: [A26.4] GET /runtime/events streams the engine event bus (Lane 1a)", async () => {
  const svc = await startHttpTransport({ port: 0, tenantId: "sse-test" });
  const ac = new AbortController();
  try {
    const res = await fetch(`${svc.url}/runtime/events`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);

    // Read the stream until our probe event arrives.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const seen = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return false;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("sse-probe-marker-a26-4")) return true;
      }
    })();

    // Let the subscription attach, then emit a real event through the emitter.
    const { emit } = await import("../events/emitter.js");
    await new Promise((r) => setTimeout(r, 60));
    emit({ time: 1, type: "sse_probe", payload: { marker: "sse-probe-marker-a26-4" }, sessionId: "sse-test" });

    const delivered = await Promise.race([
      seen,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000)),
    ]);
    assert.equal(delivered, true, "the emitted event was streamed over /runtime/events");
    // Delivered in the sse-server broadcast envelope so an existing canvas subscriber is wire-identical.
    assert.match(buf, /"type":"agent-event"/);
    assert.match(buf, /sse-probe-marker-a26-4/);
  } finally {
    ac.abort();
    await svc.close();
  }
});
