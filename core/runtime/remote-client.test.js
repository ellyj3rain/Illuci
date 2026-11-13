// core/runtime/remote-client.test.js — [A22.6] the no-checkout client drives a live service end to
// end. Uses the REAL http-transport over an ephemeral port (not a mock) so this is a true
// remote-reachability proof, mirroring http-transport.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { startHttpTransport } from "./http-transport.js";
import { illuciRemoteClient } from "./remote-client.js";
import { getRuntimeIdentity } from "./identity.js";

test("a client with only baseUrl+token introspects and drives a live runtime — no local engine import", async () => {
  const svc = await startHttpTransport({ port: 0, host: "127.0.0.1", token: "deploy-token" });
  try {
    const client = illuciRemoteClient({ baseUrl: svc.url, token: "deploy-token" });

    // health is open; identity/capability/doctor are token-gated and equal the direct API shapes
    assert.equal((await client.health()).status, "ok");
    const id = await client.identity();
    assert.equal(id.runtimeId, getRuntimeIdentity().runtimeId);
    assert.ok((await client.capability()).providers, "capability carries providers");
    assert.ok(["ok", "ok-dirty", "degraded"].includes((await client.doctor()).status));

    // MCP over the network: initialize + list the registered surface
    const init = await client.initialize();
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.ok(Array.isArray(await client.listTools()));
  } finally {
    await svc.close();
  }
});

test("a wrong/absent token is rejected on the gated endpoints", async () => {
  const svc = await startHttpTransport({ port: 0, host: "127.0.0.1", token: "right" });
  try {
    const bad = illuciRemoteClient({ baseUrl: svc.url, token: "wrong" });
    assert.equal((await bad.health()).status, "ok"); // health stays open
    await assert.rejects(() => bad.identity(), /401|unauthorized/i);
  } finally {
    await svc.close();
  }
});
