import { test } from "node:test";
import assert from "node:assert/strict";

import { DENIAL_CODES } from "../roles/denial-codes.js";
import { evaluateWorkPermit, signWorkPermit } from "./work-permit.js";

function permit(overrides = {}) {
  return signWorkPermit({
    agentId: "agent-a",
    actions: ["file_write"],
    toolFamilies: ["filesystem"],
    toolChannels: ["native"],
    capabilities: ["file.write"],
    targets: ["src/app.js"],
    riskCeiling: "medium",
    expiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides,
  });
}

test("signed exact permit allows matching file write scope", () => {
  const verdict = evaluateWorkPermit({
    permit: permit(),
    required: true,
    toolName: "file_write",
    params: { path: "src/app.js" },
    context: { agentId: "agent-a" },
  });

  assert.equal(verdict.allow, true);
  assert.equal(verdict.scope.capability, "file.write");
  assert.equal(verdict.scope.target, "src/app.js");
});

test("required work permit denies missing permit with machine code", () => {
  const verdict = evaluateWorkPermit({
    permit: null,
    required: true,
    toolName: "file_write",
    params: { path: "src/app.js" },
    context: { agentId: "agent-a" },
  });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, DENIAL_CODES.WORK_PERMIT_DENIED);
  assert.match(verdict.reason, /required/);
});

test("wildcard targets are denied unless explicitly allowed", () => {
  const denied = evaluateWorkPermit({
    permit: permit({ targets: ["*"] }),
    required: true,
    toolName: "file_write",
    params: { path: "src/app.js" },
    context: { agentId: "agent-a" },
  });
  const allowed = evaluateWorkPermit({
    permit: permit({ targets: ["*"], allowWildcardTargets: true }),
    required: true,
    toolName: "file_write",
    params: { path: "src/app.js" },
    context: { agentId: "agent-a" },
  });

  assert.equal(denied.allow, false);
  assert.equal(allowed.allow, true);
});

test("directory target scopes do not authorize sibling prefixes", () => {
  const verdict = evaluateWorkPermit({
    permit: permit({ targets: ["src"] }),
    required: true,
    toolName: "file_write",
    params: { path: "src-secret/app.js" },
    context: { agentId: "agent-a" },
  });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, DENIAL_CODES.WORK_PERMIT_DENIED);
  assert.match(verdict.reason, /target/);
});

test("risk ceiling denies shell execution above medium", () => {
  const verdict = evaluateWorkPermit({
    permit: permit({
      actions: ["shell_exec"],
      toolFamilies: ["process"],
      capabilities: ["process.exec"],
      targets: ["powershell"],
      riskCeiling: "medium",
    }),
    required: true,
    toolName: "shell_exec",
    params: { command: "powershell -NoProfile" },
    context: { agentId: "agent-a" },
  });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, DENIAL_CODES.WORK_PERMIT_DENIED);
  assert.match(verdict.reason, /risk/);
});

test("tampered permit signature denies execution", () => {
  const signed = permit();
  const verdict = evaluateWorkPermit({
    permit: { ...signed, targets: ["src/other.js"] },
    required: true,
    toolName: "file_write",
    params: { path: "src/other.js" },
    context: { agentId: "agent-a" },
  });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, DENIAL_CODES.WORK_PERMIT_DENIED);
  assert.match(verdict.reason, /signature/);
});
