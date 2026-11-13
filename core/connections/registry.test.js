import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ConnectionSecretMaterialError,
  addApiKeyConnection,
  bindRouteToConnection,
  completeOAuthConnection,
  createConnectionRegistry,
  refreshOAuthConnection,
  registerSshConnection,
  resolveConnectionForRoute,
  revokeConnection,
  startOAuthConnection,
  toMcpConnectionResource,
  toPromptSafeConnection,
} from "./registry.js";

const NOW = "2026-07-01T10:22:00.000Z";

test("API-key connections store secret references, not key material", () => {
  const connection = addApiKeyConnection({
    connectionId: "conn:provider.openai.sdk:operator",
    provider: "provider.openai.sdk",
    account: "operator",
    scopes: ["models:read", "responses:create"],
    endpoint: "https://api.openai.com",
    secretRef: "vault:illuci/openai/operator-api-key",
  }, { now: NOW });

  assert.equal(connection.authMethod, "api-key");
  assert.equal(connection.secretRef, "vault:illuci/openai/operator-api-key");
  assert.equal(connection.status, "configured");

  const promptSafe = toPromptSafeConnection(connection);
  assert.equal(promptSafe.credentialRefs.hasSecretRef, true);
  assert.equal("secretRef" in promptSafe, false);
});

test("raw secret material is rejected before normalization", () => {
  assert.throws(() => addApiKeyConnection({
    connectionId: "conn:bad:operator",
    provider: "provider.bad",
    apiKey: "sk-real-value-does-not-belong-here",
  }), ConnectionSecretMaterialError);

  assert.throws(() => registerSshConnection({
    connectionId: "conn:git:ssh",
    provider: "provider.github",
    sshIdentityRef: "ssh:operator/github",
    metadata: {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-for-prompts\n-----END OPENSSH PRIVATE KEY-----",
    },
  }), ConnectionSecretMaterialError);
});

test("OAuth lifecycle can start pending, complete, refresh, and revoke by reference", () => {
  const pending = startOAuthConnection({
    connectionId: "conn:provider.google.antigravity:operator",
    provider: "provider.google.antigravity",
    account: "operator",
    scopes: ["model:invoke"],
    endpoint: "https://accounts.google.com",
  }, { now: NOW });

  assert.equal(pending.status, "pending");
  assert.equal(pending.secretRef, null);

  const complete = completeOAuthConnection(pending, {
    secretRef: "vault:illuci/google-antigravity/operator-oauth",
    tenant: "ai-ultra",
  }, { now: "2026-07-01T10:23:00.000Z" });

  assert.equal(complete.status, "valid");
  assert.equal(complete.secretRef, "vault:illuci/google-antigravity/operator-oauth");
  assert.equal(complete.tenant, "ai-ultra");

  const refreshed = refreshOAuthConnection(complete, {
    secretRef: "vault:illuci/google-antigravity/operator-oauth:v2",
  }, { now: "2026-07-01T10:24:00.000Z" });

  assert.equal(refreshed.secretRef, "vault:illuci/google-antigravity/operator-oauth:v2");

  const revoked = revokeConnection(refreshed, { now: "2026-07-01T10:25:00.000Z", reason: "operator-revoked" });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.audit.reason, "operator-revoked");
});

test("SSH connections use an identity reference and expose refs only by opt-in", () => {
  const connection = registerSshConnection({
    connectionId: "conn:provider.github:ssh-operator",
    provider: "provider.github",
    account: "operator",
    sshIdentityRef: "ssh:operator/github",
    scopes: ["git:read", "git:write"],
  }, { now: NOW });

  assert.equal(connection.authMethod, "ssh");
  assert.equal(connection.sshIdentityRef, "ssh:operator/github");

  const mcp = toMcpConnectionResource(connection, { includeRefs: true });
  assert.equal(mcp.refs.sshIdentityRef, "ssh:operator/github");
  assert.equal(mcp.credentialRefs.hasSshIdentityRef, true);
});

test("route bindings point at a connection without carrying credential material", () => {
  const connection = addApiKeyConnection({
    connectionId: "conn:provider.xai.api:operator",
    provider: "provider.xai.api",
    account: "operator",
    secretRef: "vault:illuci/xai/operator-api-key",
  }, { now: NOW });

  const binding = bindRouteToConnection({
    routeKind: "model",
    routeId: "model.grok.api",
    modelId: "model.grok.api",
    providerModelId: "grok-4",
    transport: "api",
    role: "arbiter",
    skillFramework: "gitops-review",
    topology: "adversarial-debate",
    workPermitId: "permit:model-route:grok",
  }, connection, { now: NOW });

  assert.equal(binding.connectionId, connection.connectionId);
  assert.equal(binding.provider, "provider.xai.api");
  assert.equal("secretRef" in binding, false);
  assert.equal(binding.providerModelId, "grok-4");
  assert.equal(binding.modelId, "model.grok.api");
});

test("registry resolves route bindings through safe MCP resources", () => {
  const registry = createConnectionRegistry([
    addApiKeyConnection({
      connectionId: "conn:provider.xai.api:operator",
      provider: "provider.xai.api",
      account: "operator",
      secretRef: "vault:illuci/xai/operator-api-key",
    }, { now: NOW }),
  ]);

  const binding = registry.bindRoute({
    routeKind: "model",
    routeId: "model.grok.frontier",
    providerModelId: "grok-4.20-0309-reasoning",
    transport: "api",
  }, "conn:provider.xai.api:operator", { now: NOW });

  const resolution = registry.resolve(binding);
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.connection.connectionId, "conn:provider.xai.api:operator");
  assert.equal(resolution.connection.referencePolicy, "references-hidden");
  assert.equal("refs" in resolution.connection, false);

  const privilegedResolution = resolveConnectionForRoute(binding, [registry.getRecord("conn:provider.xai.api:operator")], { includeRefs: true });
  assert.equal(privilegedResolution.connection.refs.secretRef, "vault:illuci/xai/operator-api-key");
});
