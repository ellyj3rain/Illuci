import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConnectionSecretMaterialError, ConnectionValidationError, addApiKeyConnection } from "./registry.js";
import {
  connectionManifestPath,
  createConnectionManifestStore,
  normalizeConnectionManifest,
  readConnectionManifestFile,
  writeConnectionManifestFile,
} from "./store.js";

const NOW = "2026-07-01T11:26:00.000Z";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "illuci-connections-store-"));
}

test("connection manifest path uses the typed runtime data lane", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = tempRoot();
  try {
    process.env.ILLUCI_DATA_HOME = root;
    assert.equal(connectionManifestPath(), join(root, "connections", "connections.json"));
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest store persists connection refs and route bindings without route-carried secrets", () => {
  const root = tempRoot();
  const manifestFile = join(root, "connections.json");
  try {
    const store = createConnectionManifestStore({ manifestFile });
    const { connection } = store.upsertConnection(addApiKeyConnection({
      connectionId: "conn:provider.openai.sdk:operator",
      provider: "provider.openai.sdk",
      account: "operator",
      scopes: ["models:read", "responses:create"],
      endpoint: "https://api.openai.com",
      secretRef: "vault:illuci/openai/operator-api-key",
    }, { now: NOW }), { now: NOW });

    const { binding } = store.bindRoute({
      routeKind: "model",
      routeId: "model.openai.frontier",
      modelId: "model.openai.frontier",
      providerModelId: "gpt-5",
      transport: "api",
      role: "builder",
      skillFramework: "implementation",
      topology: "direct",
      workPermitId: "permit:model-route:openai",
    }, connection.connectionId, { now: NOW });

    const manifest = store.read();
    assert.equal(manifest.connections.length, 1);
    assert.equal(manifest.routeBindings.length, 1);
    assert.equal(manifest.routeBindings[0].connectionId, connection.connectionId);
    assert.equal("secretRef" in manifest.routeBindings[0], false);

    const text = readFileSync(manifestFile, "utf-8");
    assert.match(text, /vault:illuci\/openai\/operator-api-key/);
    assert.doesNotMatch(text, /sk-/);

    const resolution = store.resolve(binding.bindingId);
    assert.equal(resolution.resolved, true);
    assert.equal(resolution.connection.referencePolicy, "references-hidden");
    assert.equal("refs" in resolution.connection, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest writes reject raw secret material anywhere in the payload", () => {
  const root = tempRoot();
  try {
    assert.throws(() => writeConnectionManifestFile({
      connections: [{
        connectionId: "conn:bad",
        provider: "provider.bad",
        authMethod: "api-key",
        apiKey: "sk-this-must-not-enter-the-manifest",
      }],
    }, { manifestFile: join(root, "connections.json") }), ConnectionSecretMaterialError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("route bindings must reference declared connections by default", () => {
  assert.throws(() => normalizeConnectionManifest({
    connections: [],
    routeBindings: [{
      bindingId: "binding:model:missing",
      routeKind: "model",
      routeId: "model.missing",
      connectionId: "conn:missing",
    }],
  }, { now: NOW }), ConnectionValidationError);
});

test("manifest reader fails closed on invalid JSON", () => {
  const root = tempRoot();
  const manifestFile = join(root, "connections.json");
  try {
    mkdirSync(dirname(manifestFile), { recursive: true });
    writeFileSync(manifestFile, "{ not valid json", "utf-8");
    assert.throws(() => readConnectionManifestFile({ manifestFile }), ConnectionValidationError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});