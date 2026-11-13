// core/connections/bridge-ambient-env.test.js
// [A22.5] every HTTP API bridge resolves credentials tenant-context-first — a tenant's managed
// key reaches the bridge under runWithTenant; outside a context the bridge falls through to
// process.env. Mirrors the nvidia-nim pattern proven in tenant-context.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithTenant } from "./tenant-context.js";
import { addApiKeyConnection } from "./registry.js";
import { resolveAnthropicApiKey } from "../bridges/claude-api.js";
import { detectAuth } from "../bridges/gemini-api.js";
import { resolveXaiApiKey } from "../bridges/grok-api.js";

function tenantManifest(conns) {
  const file = join(tmpdir(), `illuci-bae-${process.pid}-${conns[0].connectionId}.json`);
  writeFileSync(file, JSON.stringify({ schema: "illuci.connections.manifest/1", connections: conns, routeBindings: [] }));
  return file;
}

test("claude-api resolves the tenant's ANTHROPIC_API_KEY under runWithTenant", () => {
  process.env.BAE_ANTH = "tenant-anthropic-key";
  const conn = addApiKeyConnection({ connectionId: "ba1", tenant: "tA", provider: "provider.anthropic", secretRef: "env:BAE_ANTH" });
  const file = tenantManifest([conn]);
  try {
    const key = runWithTenant("tA", () => resolveAnthropicApiKey(), { manifestFile: file });
    assert.equal(key, "tenant-anthropic-key");
  } finally {
    rmSync(file, { force: true });
    delete process.env.BAE_ANTH;
  }
});

test("gemini-api detectAuth sees the tenant's GEMINI_API_KEY under runWithTenant", () => {
  process.env.BAE_GEM = "tenant-gemini-key";
  const conn = addApiKeyConnection({ connectionId: "bg1", tenant: "tG", provider: "provider.google", secretRef: "env:BAE_GEM" });
  const file = tenantManifest([conn]);
  try {
    const auth = runWithTenant("tG", () => detectAuth(), { manifestFile: file });
    assert.equal(auth.key, "tenant-gemini-key");
  } finally {
    rmSync(file, { force: true });
    delete process.env.BAE_GEM;
  }
});

test("grok-api resolves the tenant's XAI_API_KEY under runWithTenant", () => {
  process.env.BAE_XAI = "tenant-xai-key";
  const conn = addApiKeyConnection({ connectionId: "bx1", tenant: "tX", provider: "provider.xai", secretRef: "env:BAE_XAI" });
  const file = tenantManifest([conn]);
  try {
    const key = runWithTenant("tX", () => resolveXaiApiKey(), { manifestFile: file });
    assert.equal(key, "tenant-xai-key");
  } finally {
    rmSync(file, { force: true });
    delete process.env.BAE_XAI;
  }
});

test("outside a tenant context every resolver falls through to process.env", () => {
  process.env.ANTHROPIC_API_KEY_SAVED = process.env.ANTHROPIC_API_KEY || "";
  process.env.ANTHROPIC_API_KEY = "server-key";
  try {
    assert.equal(resolveAnthropicApiKey(), "server-key");
  } finally {
    if (process.env.ANTHROPIC_API_KEY_SAVED) process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY_SAVED;
    else delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_SAVED;
  }
});

test("an explicit env argument overrides the ambient tenant context", () => {
  process.env.BAE_EXPL = "tenant-key";
  const conn = addApiKeyConnection({ connectionId: "be1", tenant: "tE", provider: "provider.xai", secretRef: "env:BAE_EXPL" });
  const file = tenantManifest([conn]);
  try {
    const key = runWithTenant("tE", () => resolveXaiApiKey({ XAI_API_KEY: "explicit-key" }), { manifestFile: file });
    assert.equal(key, "explicit-key");
  } finally {
    rmSync(file, { force: true });
    delete process.env.BAE_EXPL;
  }
});
