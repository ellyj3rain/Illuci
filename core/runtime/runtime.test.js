// core/runtime/runtime.test.js
// [A22.1] Illuci Runtime service — identity / capability / doctor contract tests.

import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeIdentity, RUNTIME_ID, RUNTIME_SCHEMA_VERSION } from "./identity.js";
import { getRuntimeCapability } from "./capability.js";
import { runtimeDoctor } from "./doctor.js";

test("identity: versioned, self-describing, no secrets", () => {
  const id = getRuntimeIdentity();
  assert.equal(id.runtimeId, RUNTIME_ID);
  assert.equal(id.schema, RUNTIME_SCHEMA_VERSION);
  assert.equal(id.schemaVersion, RUNTIME_SCHEMA_VERSION);
  assert.ok(typeof id.version === "string" || id.version === null);
  assert.ok(id.source && typeof id.source.from === "string");
});

test("capability: real surfaces, Illuci-owned shapes", () => {
  const cap = getRuntimeCapability();
  assert.ok(cap.providers.length > 0, "providers present");
  assert.ok(cap.models.length > 0, "models present");
  assert.ok(Array.isArray(cap.topologies) && cap.topologies.length > 0, "topologies present");
  assert.ok(Array.isArray(cap.authModes) && cap.authModes.length > 0, "auth modes declared");
  for (const p of cap.providers) {
    assert.deepEqual(Object.keys(p).sort(), ["authMode", "class", "id", "label", "organization"]);
  }
  assert.ok(cap.models.every((m) => Array.isArray(m.capabilityLanes)), "model route capability lanes normalized");
  assert.equal(cap.models.find((m) => m.registryId === "nim-riva-translate-4b")?.fleetUse, "delegate");
  assert.equal(cap.models.find((m) => m.registryId === "nim-nemotron-3-ultra")?.fleetUse, "seat");
  assert.equal(cap.counts.providers, cap.providers.length);
  assert.equal(cap.postureProfile.schema, "illuci.governance.posture-profile/1");
  assert.equal(cap.postureProfile.contracts.versionMaturity, "evidence-not-authority");
  assert.equal(cap.postureProfile.contracts.variables, "justified-gradients-not-modes");
  assert.ok(cap.postureProfile.profile.competenceFloor.includes("retain-relevant-world-and-user-context"));
  // MCP facet absent unless a registry is injected.
  assert.equal(cap.mcp.present, false);
});

test("capability: MCP surface included when a registry is supplied", () => {
  const cap = getRuntimeCapability({
    mcpRegistry: { t1: { kind: "tool" }, r1: { kind: "resource" }, p1: { kind: "prompt" } },
  });
  assert.deepEqual(cap.mcp.tools, ["t1"]);
  assert.deepEqual(cap.mcp.resources, ["r1"]);
  assert.deepEqual(cap.mcp.prompts, ["p1"]);
});

test("no secret material crosses the introspection surface", () => {
  // Plant a secret in the environment; it must never appear anywhere in the responses.
  const marker = "SEKRET-" + "abc123xyz";
  process.env.NVIDIA_API_KEY = marker;
  process.env.ANTHROPIC_API_KEY = marker;
  try {
    const blob = JSON.stringify({
      id: getRuntimeIdentity(),
      cap: getRuntimeCapability(),
      doc: runtimeDoctor(),
    });
    assert.equal(blob.includes(marker), false, "secret value leaked into runtime surface");
    assert.equal(/"(apiKey|api_key|token|secret|password)"\s*:/i.test(blob), false, "secret-shaped field present");
  } finally {
    delete process.env.NVIDIA_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("doctor: deterministic report with pass/fail checks", () => {
  const rep = runtimeDoctor();
  assert.ok(["ok", "ok-dirty", "degraded"].includes(rep.status));
  assert.equal(rep.schema, RUNTIME_SCHEMA_VERSION);
  assert.ok(rep.identity && rep.capability && Array.isArray(rep.checks));
  assert.ok(rep.checks.length >= 5);
  for (const c of rep.checks) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.ok, "boolean");
  }
  // With real surfaces present, the only reason for non-ok is a dirty tree.
  assert.ok(rep.status === "ok" || rep.status === "ok-dirty");
});
