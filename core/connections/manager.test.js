// core/connections/manager.test.js
// [A22.3.3] connection management — add/list/revoke round-trip, tenant-scoped, secret-safe.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listTenantConnections, addConnection, revokeTenantConnection } from "./manager.js";

test("add -> list -> revoke round-trip, tenant-scoped", () => {
  const manifestFile = join(tmpdir(), `illuci-mgr-rt-${process.pid}.json`);
  const opts = { manifestFile };
  try {
    const a = addConnection({ connectionId: "ca", tenant: "A", provider: "provider.nvidia.nim", authMethod: "api-key", secretRef: "env:NIM_A" }, opts);
    assert.equal(a.connectionId, "ca");
    assert.equal(a.provider, "provider.nvidia.nim");
    addConnection({ connectionId: "cb", tenant: "B", provider: "provider.anthropic.api", authMethod: "api-key", secretRef: "env:ANTH_B" }, opts);

    // tenant-scoped listing
    assert.equal(listTenantConnections("A", opts).length, 1);
    assert.equal(listTenantConnections("A", opts)[0].connectionId, "ca");
    assert.equal(listTenantConnections(null, opts).length, 2);

    // revoke marks (not deletes) the connection
    const revoked = revokeTenantConnection("ca", opts);
    assert.match(revoked.status, /revok/i);
    assert.match(listTenantConnections("A", opts)[0].status, /revok/i);
  } finally {
    rmSync(manifestFile, { force: true });
  }
});

test("prompt-safe view exposes the ref, never the RESOLVED secret value", () => {
  const manifestFile = join(tmpdir(), `illuci-mgr-safe-${process.pid}.json`);
  process.env.MGR_TEST_SECRET = "THE-ACTUAL-VALUE";
  try {
    addConnection({ connectionId: "cx", tenant: "T", provider: "provider.xai.api", authMethod: "api-key", secretRef: "env:MGR_TEST_SECRET" }, { manifestFile });
    const listed = JSON.stringify(listTenantConnections("T", { manifestFile }));
    assert.equal(listed.includes("THE-ACTUAL-VALUE"), false, "resolved secret value must never appear in the prompt-safe view");
  } finally {
    rmSync(manifestFile, { force: true });
    delete process.env.MGR_TEST_SECRET;
  }
});
