import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SECURITY_EGRESS_PROFILES,
  assertAtomicSecurityRequest,
  collectEvidenceRefs,
  createSecurityEngineAdapter,
  evaluateSecurityCapabilityPermit,
  normalizeSecurityCapability,
} from "./engine-adapter.js";
import { signWorkPermit } from "../governance/work-permit.js";

test("normalizes PhantomReach capability facts without importing the engine", () => {
  const capability = normalizeSecurityCapability(
    {
      capability_id: "secure_comms.sqlite_inventory",
      module: "secure_comms",
      action: "sqlite_inventory",
      risk_tier: 2,
      execution_mode: "read-only",
      isolation: "in-process",
      requires_permit: true,
      network_active: false,
      sensitive_data: true,
      allowed_target_kinds: ["filesystem", "backup"],
      version: "1.0.0",
    },
    { engineId: "phantomreach" },
  );

  assert.equal(capability.engineId, "phantomreach");
  assert.equal(capability.capabilityId, "secure_comms.sqlite_inventory");
  assert.equal(capability.illuciRisk, "medium");
  assert.equal(capability.requiresPermit, true);
  assert.equal(capability.networkAccess, "none");
  assert.deepEqual(capability.targetKinds, ["filesystem", "backup"]);
});

test("normalizes SecurityLang L1 descriptor as peer sidecar capability", () => {
  const capability = normalizeSecurityCapability(
    {
      id: "headers",
      summary: "Inspect response security headers",
      network_access: "active-read",
      destructive: false,
      default_timeout_ms: 10000,
    },
    { engineId: "securitylang.go-scanner" },
  );

  assert.equal(capability.engineId, "securitylang.go-scanner");
  assert.equal(capability.capabilityId, "headers");
  assert.equal(capability.networkAccess, "active-read");
  assert.equal(capability.illuciRisk, "low");
  assert.equal(capability.action, "probe.execute");
});

test("security engine calls stay atomic", () => {
  assert.equal(assertAtomicSecurityRequest({ capabilityId: "headers" }), "headers");
  assert.throws(
    () => assertAtomicSecurityRequest({ capabilityIds: ["headers", "crawl"] }),
    /one atomic capability/,
  );
  assert.throws(
    () => assertAtomicSecurityRequest({ capabilityId: "headers", steps: [] }),
    /one atomic capability/,
  );
});

test("security permit evaluation preserves engine, capability, risk, and target scope", () => {
  const permit = signWorkPermit({
    agentId: "security-runner",
    actions: ["security_engine.execute"],
    toolFamilies: ["security"],
    toolChannels: ["phantomreach"],
    capabilities: ["secure_comms.sqlite_inventory"],
    targetScope: ["https://fixture.example"],
    riskCeiling: "medium",
    expiresAt: "2099-01-01T00:00:00Z",
  });

  const allowed = evaluateSecurityCapabilityPermit({
    permit,
    engineId: "phantomreach",
    capability: { id: "secure_comms.sqlite_inventory", risk_tier: 2, requires_permit: true },
    target: "https://fixture.example",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(allowed.allow, true);

  const denied = evaluateSecurityCapabilityPermit({
    permit,
    engineId: "phantomreach",
    capability: { id: "secure_comms.sqlite_inventory", risk_tier: 2, requires_permit: true },
    target: "https://other.example",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /outside work permit scope/);
});

test("adapter wraps discovery, execution, and evidence references", async () => {
  const permit = signWorkPermit({
    agentId: "security-runner",
    actions: ["security_engine.execute"],
    toolFamilies: ["security"],
    toolChannels: ["securitylang.go-scanner"],
    capabilities: ["headers"],
    targetScope: ["https://fixture.example"],
    riskCeiling: "low",
    expiresAt: "2099-01-01T00:00:00Z",
  });
  const adapter = createSecurityEngineAdapter({
    engineId: "securitylang.go-scanner",
    capabilities: [{ id: "headers", network_access: "active-read", destructive: false }],
    async executeCapability(request) {
      return {
        findings: [{ id: "fn-1", evidence_refs: ["ev-abc"] }],
        evidence: [{ id: "ev-def", sha256: "f".repeat(64) }],
        artifacts: [{ uri: `artifact:${request.capabilityId}` }],
      };
    },
  });

  const result = await adapter.executeCapability(
    { capabilityId: "headers", target: "https://fixture.example" },
    { workPermit: permit },
  );
  assert.equal(result.engineId, "securitylang.go-scanner");
  assert.equal(result.capabilityId, "headers");
  assert.deepEqual(result.evidenceRefs, [
    "artifact:headers",
    "ev-abc",
    "ev-def",
    `sha256:${"f".repeat(64)}`,
  ]);
});

test("egress profiles model governed gradient rather than a network toggle", () => {
  assert.equal(SECURITY_EGRESS_PROFILES.package.requiresPermit, false);
  assert.equal(SECURITY_EGRESS_PROFILES["security-authorized"].evidenceRequired, true);
  assert.equal(SECURITY_EGRESS_PROFILES["open-diagnostic"].expires, "short-lived");
});

test("collectEvidenceRefs tolerates mixed security engine result shapes", () => {
  assert.deepEqual(
    collectEvidenceRefs({
      findings: [{ evidenceRefs: ["ev-one"] }],
      artifacts: [{ sha256: "0".repeat(64) }],
    }),
    ["ev-one", `sha256:${"0".repeat(64)}`],
  );
});
