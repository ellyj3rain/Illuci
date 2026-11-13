// core/connections/credential-resolver.test.js
// [A22.3.2] tenant credential resolution — unit + end-to-end (tenant connection -> bridge seam).

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSecretRef, resolveTenantCredentials, tenantEnv, envKeyForProvider } from "./credential-resolver.js";
import { addApiKeyConnection } from "./registry.js";
import { resolveNvidiaApiKey } from "../bridges/nvidia-nim.js";

function writeManifest(connections) {
  const file = join(tmpdir(), `illuci-conn-test-${process.pid}-${connections.length}-${connections.map((c) => c.connectionId).join("")}.json`);
  writeFileSync(file, JSON.stringify({ schema: "illuci.connections.manifest/1", connections, routeBindings: [] }));
  return file;
}

test("envKeyForProvider maps provider ids (longest prefix) to bridge env keys", () => {
  assert.equal(envKeyForProvider("provider.nvidia.nim"), "NVIDIA_API_KEY");
  assert.equal(envKeyForProvider("provider.anthropic.api"), "ANTHROPIC_API_KEY");
  assert.equal(envKeyForProvider("provider.xai.api"), "XAI_API_KEY");
  assert.equal(envKeyForProvider("provider.unknown.x"), null);
});

test("resolveSecretRef: env-backed and literal, fail-closed otherwise", () => {
  assert.equal(resolveSecretRef("env:FOO", { env: { FOO: "bar" } }), "bar");
  assert.equal(resolveSecretRef("literal:baz"), "baz");
  assert.equal(resolveSecretRef("env:MISSING", { env: {} }), null);
  assert.equal(resolveSecretRef("no-scheme"), null);
  assert.equal(resolveSecretRef(null), null);
});

test("end-to-end: a tenant's managed connection reaches the bridge via the seam; isolated + secret-safe", () => {
  process.env.TEST_NIM_SECRET = "KEYA-managed";
  const tenantB = addApiKeyConnection({ connectionId: "cb", provider: "provider.nvidia.nim", tenant: "tenantB", secretRef: "env:OTHER_UNSET" });
  const tenantA = addApiKeyConnection({ connectionId: "ca", provider: "provider.nvidia.nim", tenant: "tenantA", secretRef: "env:TEST_NIM_SECRET" });
  const file = writeManifest([tenantB, tenantA]);
  try {
    // secret-safety: the record holds only the opaque ref, never the value
    assert.equal(JSON.stringify(tenantA).includes("KEYA-managed"), false, "no raw secret in the record");
    assert.equal(tenantA.secretRef, "env:TEST_NIM_SECRET");

    // tenant A resolves its own credential into the bridge's env key
    const a = resolveTenantCredentials("tenantA", { manifestFile: file });
    assert.deepEqual(a.env, { NVIDIA_API_KEY: "KEYA-managed" });
    assert.deepEqual(a.resolved, ["provider.nvidia.nim"]);

    // the bridge's OWN resolver picks up the tenant credential through options.env
    assert.equal(resolveNvidiaApiKey(tenantEnv("tenantA", { manifestFile: file, base: {} })), "KEYA-managed");

    // isolation: tenant B's ref is unset -> skipped, and A's key never leaks to B
    const b = resolveTenantCredentials("tenantB", { manifestFile: file });
    assert.equal(b.env.NVIDIA_API_KEY, undefined);
    assert.ok(b.skipped.some((s) => s.reason === "unresolved-secret"));
  } finally {
    rmSync(file, { force: true });
    delete process.env.TEST_NIM_SECRET;
  }
});

test("tenantEnv layers managed creds over the ambient base; no connection -> pure fallback", () => {
  const file = writeManifest([]);
  try {
    const env = tenantEnv("nobody", { manifestFile: file, base: { AMBIENT: "1", NVIDIA_API_KEY: "env-fallback" } });
    assert.equal(env.AMBIENT, "1");
    assert.equal(env.NVIDIA_API_KEY, "env-fallback"); // falls back to base when the tenant has no connection
  } finally {
    rmSync(file, { force: true });
  }
});
