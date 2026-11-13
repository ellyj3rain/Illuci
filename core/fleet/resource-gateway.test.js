import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileDispatchTarget,
  dispatchIdForPublicModel,
  getModelResource,
  getProviderResource,
  listModelResources,
  listProviderResources,
  publicModelIdFor,
  resolveModelResource,
} from "./resource-gateway.js";

test("provider resources are first-class management records", () => {
  const providers = listProviderResources();
  const ids = new Set(providers.map((provider) => provider.id));

  assert.ok(ids.has("provider.ollama.cloud"));
  assert.ok(ids.has("provider.google.antigravity"));
  assert.ok(ids.has("provider.xai.cli"));
  assert.ok(ids.has("provider.anthropic.cli"));
  assert.ok(ids.has("provider.openai.sdk"));

  const ollama = getProviderResource("ollama-cloud");
  assert.equal(ollama.id, "provider.ollama.cloud");
  assert.ok(ollama.modelCount > 0);
  assert.ok(ollama.channelCount >= ollama.modelCount);
});

test("Kimi public resource is the Ollama-backed model, not the Moonshot CLI", () => {
  const kimi = getModelResource("kimi-cloud");
  assert.equal(kimi.id, "model.kimi.ollama");
  assert.equal(kimi.label, "Kimi via Ollama");
  assert.equal(kimi.defaultProviderResourceId, "provider.ollama.cloud");

  const moonshot = getModelResource("kimi-local");
  assert.equal(moonshot.id, "model.kimi.moonshot");
  assert.equal(moonshot.defaultProviderResourceId, "provider.moonshot.cli");
});

test("public IDs translate to dispatch IDs without becoming the UI vocabulary", () => {
  assert.equal(publicModelIdFor("grok-cli"), "model.grok.build");
  assert.equal(dispatchIdForPublicModel("model.grok.frontier"), "grok-build");
  assert.equal(publicModelIdFor("grok-composer-2.5-fast"), "model.grok.composer-fast");
  assert.equal(dispatchIdForPublicModel("model.grok.composer-fast"), "grok-composer-2.5-fast");

  const target = compileDispatchTarget("model.grok.composer-fast");
  assert.equal(target.modelResourceId, "model.grok.composer-fast");
  assert.equal(target.providerResourceId, "provider.xai.cli");
  assert.equal(target.dispatchId, "grok-composer-2.5-fast");
  assert.equal(target.providerModel, "grok-composer-2.5-fast");
});

test("model resources expose reversible route status for held API routes", () => {
  const api = getModelResource("grok");
  const build = getModelResource("grok-build");

  assert.equal(api.routeStatus, "suspended");
  assert.equal(api.diagnostics.routeStatus, "suspended");
  assert.match(api.diagnostics.routeStatusReason, /productization hold/);
  assert.equal(build.routeStatus, "available");
});

test("Antigravity channel selection compiles under one public GPT-OSS resource", () => {
  const prior = {
    normalized: process.env.ILLUCI_FLEET_NORMALIZED_ENABLED,
    channels: process.env.ILLUCI_FLEET_CHANNELS_ENABLED,
    agyPath: process.env.AGY_PATH,
  };
  const dir = mkdtempSync(join(tmpdir(), "illuci-gateway-agy-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");

  process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = "1";
  process.env.ILLUCI_FLEET_CHANNELS_ENABLED = "1";
  process.env.AGY_PATH = fakeAgy;

  try {
    const resolved = resolveModelResource({ family: "gpt", reasoning: "high", transport: "antigravity" });
    assert.equal(resolved.model.id, "model.gpt-oss.frontier");
    assert.equal(resolved.dispatchTarget.providerResourceId, "provider.google.antigravity");
    assert.equal(resolved.dispatchTarget.bridge, "agy.js");
    assert.equal(resolved.dispatchTarget.providerModel, "GPT-OSS 120B (Medium)");
  } finally {
    if (prior.normalized === undefined) delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
    else process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = prior.normalized;
    if (prior.channels === undefined) delete process.env.ILLUCI_FLEET_CHANNELS_ENABLED;
    else process.env.ILLUCI_FLEET_CHANNELS_ENABLED = prior.channels;
    if (prior.agyPath === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prior.agyPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumer model list exposes the fleet by default and filters by provider on request", () => {
  const fleetModels = listModelResources();
  const fleetIds = new Set(fleetModels.map((model) => model.id));
  assert.ok(fleetIds.has("model.grok.composer-fast"));
  assert.ok(fleetIds.has("model.kimi.ollama"));
  assert.ok(fleetIds.has("model.claude.opus"));

  const models = listModelResources({ providerResourceId: "provider.ollama.cloud" });
  const kimi = models.find((model) => model.id === "model.kimi.ollama");
  assert.ok(kimi);
  assert.equal(kimi.label, "Kimi via Ollama");
  assert.equal(kimi.registryId, "kimi-cloud");
  assert.ok(kimi.channels.every((channel) => channel.providerResourceId === "provider.ollama.cloud"));
  assert.equal(kimi.diagnostics.registryId, "kimi-cloud");
});

test("model resources expose standardized control metadata", () => {
  const gemini = getModelResource("gemini");
  assert.equal(gemini.controls.reasoning.control, "thinking");
  assert.equal(gemini.controls.thinking.supported, true);
  assert.deepEqual(gemini.controls.thinking.values, [true, false]);

  const glm = getModelResource("glm");
  assert.equal(glm.controls.reasoning.control, "think");
  assert.equal(glm.controls.thinking.supported, true);
});
