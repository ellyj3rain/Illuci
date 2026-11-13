// core/runtime/mcp-runtime-adapter.test.js
// [A22.4] Runtime-backed MCP parity and HTTP MCP client adapter tests.

import test from "node:test";
import assert from "node:assert/strict";

import { startHttpTransport } from "./http-transport.js";
import { connectMcpHttpServer } from "../tools/mcp-client.js";

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

function parseResource(readResult, expectedUri) {
  assert.ok(Array.isArray(readResult?.contents), "resource read returns contents");
  assert.equal(readResult.contents[0].uri, expectedUri);
  assert.equal(readResult.contents[0].mimeType, "application/json");
  return JSON.parse(readResult.contents[0].text);
}

test("runtime MCP resources equal the direct runtime HTTP API", async () => {
  const svc = await startHttpTransport({ port: 0, tenantId: "a22-4-runtime-mcp-parity" });
  const client = await connectMcpHttpServer({ url: svc.url, name: "illuci-runtime-http-test" });
  try {
    const resources = await client.listResources();
    const names = resources.map((r) => r.name);
    assert.ok(names.includes("runtime_identity_v1"));
    assert.ok(names.includes("runtime_capability_v1"));
    assert.ok(names.includes("runtime_doctor_v1"));

    const directIdentity = await getJson(`${svc.url}/runtime/identity`);
    const mcpIdentity = parseResource(
      await client.readResource("runtime_identity_v1"),
      "illuci://runtime/identity",
    );
    assert.deepEqual(mcpIdentity, directIdentity);

    const directCapability = await getJson(`${svc.url}/runtime/capability`);
    const mcpCapability = parseResource(
      await client.readResource("runtime_capability_v1"),
      "illuci://runtime/capability",
    );
    assert.deepEqual(mcpCapability, directCapability);

    const directDoctor = await getJson(`${svc.url}/runtime/doctor`);
    const mcpDoctor = parseResource(
      await client.readResource("illuci://runtime/doctor"),
      "illuci://runtime/doctor",
    );
    assert.deepEqual(mcpDoctor, directDoctor);
  } finally {
    await client.close();
    await svc.close();
  }
});

test("HTTP MCP adapter calls tools over POST /mcp without a local stdio process", async () => {
  const svc = await startHttpTransport({ port: 0, tenantId: "a22-4-http-mcp-adapter" });
  const client = await connectMcpHttpServer({ url: svc.url, name: "illuci-runtime-http-test" });
  try {
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === "run_topology_v1"));
    const called = await client.callTool("compose_skill_v1", { skillId: "__http_adapter__" });
    assert.equal(called.ok, true);
    assert.match(JSON.stringify(called.content), /__http_adapter__/);

    const framework = await client.callTool("compose_skill_framework_use_v1", {
      frameworkId: "hosted-infrastructure-operations",
      topology: "dev-team",
      skillRefs: ["infrastructure.account-posture"],
    });
    assert.equal(framework.ok, true);
    assert.match(JSON.stringify(framework.content), /hosted-infrastructure-operations/);
    assert.match(JSON.stringify(framework.content), /infrastructure\.account-posture/);
  } finally {
    await client.close();
    await svc.close();
  }
});
