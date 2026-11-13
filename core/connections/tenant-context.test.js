// core/connections/tenant-context.test.js
// [A22.3.4] request-scoped tenant context — a bridge routes with the tenant's credential.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithTenant, resolveAmbientEnv, currentTenantId } from "./tenant-context.js";
import { addApiKeyConnection } from "./registry.js";
import { resolveNvidiaApiKey, query } from "../bridges/nvidia-nim.js";

function tenantManifest(conn) {
  const file = join(tmpdir(), `illuci-tctx-${process.pid}-${conn.connectionId}.json`);
  writeFileSync(file, JSON.stringify({ schema: "illuci.connections.manifest/1", connections: [conn], routeBindings: [] }));
  return file;
}

test("runWithTenant establishes an ambient tenant env; a bridge resolver reads it; no leak after", () => {
  process.env.TCTX_SECRET = "tenant-key-A";
  const conn = addApiKeyConnection({ connectionId: "ca", tenant: "tA", provider: "provider.nvidia.nim", secretRef: "env:TCTX_SECRET" });
  const file = tenantManifest(conn);
  try {
    assert.equal(currentTenantId(), null);
    const key = runWithTenant("tA", () => resolveNvidiaApiKey(resolveAmbientEnv()), { manifestFile: file });
    assert.equal(key, "tenant-key-A");
    assert.equal(currentTenantId(), null); // context did not leak
  } finally {
    rmSync(file, { force: true });
    delete process.env.TCTX_SECRET;
  }
});

test("nvidia-nim query() sends the tenant's credential (Authorization) under runWithTenant", async () => {
  process.env.TCTX_SECRET2 = "tenant-key-B";
  const conn = addApiKeyConnection({ connectionId: "cb", tenant: "tB", provider: "provider.nvidia.nim", secretRef: "env:TCTX_SECRET2" });
  const file = tenantManifest(conn);
  let auth = null;
  const mockFetch = async (u, o) => {
    auth = o?.headers?.Authorization ?? o?.headers?.authorization ?? null;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }) };
  };
  try {
    await runWithTenant("tB", () => query("hi", { fetch: mockFetch, model: "x" }), { manifestFile: file });
    assert.equal(auth, "Bearer tenant-key-B");
  } finally {
    rmSync(file, { force: true });
    delete process.env.TCTX_SECRET2;
  }
});

test("default tenant gets no override", () => {
  assert.equal(runWithTenant("default", () => currentTenantId()), null);
});
