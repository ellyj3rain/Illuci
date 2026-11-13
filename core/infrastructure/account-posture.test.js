import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  adapterForInfrastructurePlatform,
  appendInfrastructureAccountPostureTrace,
  buildInfrastructureAccountPosture,
  checkInfrastructureAccountPosture,
  INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA,
  infrastructureAccountPostureTracePath,
  listInfrastructureAccountAdapters,
} from "./account-posture.js";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  };
}

test("infrastructure adapters classify platform families above vendor identity", () => {
  const adapters = listInfrastructureAccountAdapters();
  const ids = adapters.map((adapter) => adapter.id);

  assert.deepEqual(ids, ["github", "gitlab", "vercel", "supabase", "obsidian"]);
  assert.equal(adapterForInfrastructurePlatform("gitlab").family, "gitops");
  assert.equal(adapterForInfrastructurePlatform("vercel").family, "deployment-hosting");
  assert.equal(adapterForInfrastructurePlatform("supabase").family, "managed-data-platform");
  assert.equal(adapterForInfrastructurePlatform("obsidian").family, "knowledge-vault");
  assert.equal(adapterForInfrastructurePlatform("github").family, "gitops");
});

test("GitHub billing evidence can classify hosted quota exhaustion without naming a plan as source truth", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "github",
    account: { kind: "user", login: "operator", plan: "pro" },
    auth: { tokenPresent: true, tokenNames: ["GITHUB_TOKEN"] },
    apiEvidence: [
      { id: "identity", ok: true, evidence: { login: "operator" } },
      { id: "actions-billing", ok: true, evidence: { included_minutes: 3000, total_minutes_used: 3000 } },
    ],
  }, { id: "github-exhausted", timestamp: "2026-06-27T12:30:00Z" });

  assert.equal(record.schema, INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA);
  assert.equal(record.subject.family, "gitops");
  assert.equal(record.quota.posture, "exhausted");
  assert.equal(record.quota.unit, "github-actions-minutes");
  assert.equal(record.dimensions.action, "pause-hosted-execution");
  assert.equal(record.dimensions.executionSubstratePosture, "hosted-execution-blocked");
  assert.ok(record.action.blockedBy.includes("hosted-quota-exhausted"));
  assert.equal(record.dimensions.accountPlanKnown, true);
});

test("GitLab runner evidence classifies self-managed execution substrate without hardcoding routing", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "gitlab",
    account: { kind: "admin-or-user", login: "operator" },
    auth: { tokenPresent: true, tokenNames: ["GITLAB_TOKEN"] },
    apiEvidence: [
      { id: "identity", ok: true, evidence: { username: "operator", is_admin: true } },
      { id: "version", ok: true, evidence: { version: "17.11.0" } },
      { id: "runners", ok: true, evidence: { total: 2, active: 2 } },
      { id: "license", ok: true, evidence: { plan: "premium" } },
    ],
  }, { id: "gitlab-runner-visible" });

  assert.equal(record.schema, INFRASTRUCTURE_ACCOUNT_POSTURE_SCHEMA);
  assert.equal(record.subject.family, "gitops");
  assert.equal(record.subject.substrateClass, "source-control-ci-and-self-managed-runners");
  assert.equal(record.dimensions.accountPosture, "api-confirmed");
  assert.equal(record.dimensions.executionSubstratePosture, "self-managed-runner-visible");
  assert.equal(record.dimensions.runnerPosture, "visible");
  assert.equal(record.dimensions.action, "use-self-managed-runner");
  assert.equal(record.action.outcome, "ready");
});

test("GitLab account evidence without runner visibility requires runner verification", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "gitlab",
    auth: { tokenPresent: true, tokenNames: ["GITLAB_TOKEN"] },
    apiEvidence: [
      { id: "identity", ok: true, evidence: { username: "operator" } },
      { id: "runners", ok: false, statusCode: 403, error: "Forbidden" },
    ],
  }, { id: "gitlab-runner-permission-limited" });

  assert.equal(record.dimensions.authPosture, "authorized");
  assert.equal(record.dimensions.executionSubstratePosture, "self-managed-runner-permission-limited");
  assert.equal(record.dimensions.runnerPosture, "permission-limited");
  assert.equal(record.dimensions.action, "verify-frontend");
  assert.equal(record.action.outcome, "ready");
});

test("missing hosted provider token records frontend verification rather than account certainty", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "vercel",
    auth: { tokenPresent: false },
  }, { id: "vercel-missing" });

  assert.equal(record.subject.family, "deployment-hosting");
  assert.equal(record.dimensions.authPosture, "missing");
  assert.equal(record.dimensions.accountPosture, "frontend-verification-required");
  assert.equal(record.dimensions.action, "require-auth");
  assert.ok(record.action.blockedBy.includes("account-token-missing"));
  assert.ok(record.action.blockedBy.includes("frontend-account-verification-required"));
});

test("API identity without surfaced account limits keeps frontend verification in the action posture", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "vercel",
    auth: { tokenPresent: true, tokenNames: ["VERCEL_TOKEN"] },
    apiEvidence: [{ id: "identity", ok: true, evidence: { username: "operator" } }],
  }, { id: "vercel-api-only" });

  assert.equal(record.dimensions.accountPosture, "api-confirmed");
  assert.equal(record.dimensions.quotaPosture, "unknown");
  assert.equal(record.dimensions.featureDiscoveryPosture, "api-plus-frontend-required");
  assert.equal(record.dimensions.action, "verify-frontend");
  assert.equal(record.action.outcome, "ready");
});

test("Obsidian defaults to local plugin or vault verification when no endpoint is configured", () => {
  const record = buildInfrastructureAccountPosture({
    platform: "obsidian",
    auth: { tokenPresent: false },
  }, { id: "obsidian-local" });

  assert.equal(record.subject.family, "knowledge-vault");
  assert.equal(record.dimensions.accountPosture, "local-plugin-required");
  assert.equal(record.dimensions.action, "verify-frontend");
  assert.ok(record.action.blockedBy.includes("local-plugin-or-vault-verification-required"));
});

test("infrastructure doctor probes GitLab, Vercel, and Supabase with native tokens", async () => {
  const requests = [];
  const result = await checkInfrastructureAccountPosture({
    platforms: "gitlab,vercel,supabase",
    env: {
      GITLAB_TOKEN: "gitlab-secret",
      GITLAB_API_URL: "https://gitlab.example.test/api/v4",
      VERCEL_TOKEN: "vercel-secret",
      SUPABASE_ACCESS_TOKEN: "supabase-secret",
    },
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        authorization: options.headers.authorization,
        privateToken: options.headers["private-token"],
      });
      if (String(url).includes("gitlab.example.test/api/v4/user")) {
        return response(200, { id: 7, username: "operator", is_admin: true });
      }
      if (String(url).includes("gitlab.example.test/api/v4/version")) {
        return response(200, { version: "17.11.0" });
      }
      if (String(url).includes("gitlab.example.test/api/v4/runners")) {
        return response(200, [{ id: 1, active: true }]);
      }
      if (String(url).includes("gitlab.example.test/api/v4/license")) {
        return response(200, { plan: "premium" });
      }
      if (String(url).includes("api.vercel.com")) {
        return response(200, { user: { id: "u_1", username: "operator" } });
      }
      if (String(url).includes("api.supabase.com")) {
        return response(200, [{ id: "project_1" }, { id: "project_2" }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(result.schema, "illuci.infrastructure.account-posture-set/1");
  assert.equal(result.records.length, 3);
  assert.equal(result.recordsByPlatform.gitlab.dimensions.runnerPosture, "visible");
  assert.equal(result.recordsByPlatform.gitlab.dimensions.action, "use-self-managed-runner");
  assert.equal(result.recordsByPlatform.vercel.dimensions.accountPosture, "api-confirmed");
  assert.equal(result.recordsByPlatform.supabase.inputs.apiEvidence[0].evidence.total, 2);
  assert.equal(requests.find((request) => request.url.includes("/user")).privateToken, "gitlab-secret");
  assert.deepEqual(requests.filter((request) => request.authorization).map((request) => request.authorization), [
    "Bearer vercel-secret",
    "Bearer supabase-secret",
  ]);
});

test("infrastructure account posture trace appends JSONL under the infrastructure lane", () => {
  const data = mkdtempSync(join(tmpdir(), "illuci-infra-account-posture-"));
  const prior = process.env.ILLUCI_DATA_HOME;
  process.env.ILLUCI_DATA_HOME = data;
  try {
    const record = buildInfrastructureAccountPosture({ platform: "github" }, { id: "trace-infra" });
    const trace = appendInfrastructureAccountPostureTrace(record);
    assert.equal(trace.displayPath, ".illuci/data/infrastructure/account-posture/records.jsonl");
    assert.equal(trace.path, infrastructureAccountPostureTracePath());
    assert.equal(existsSync(trace.path), true);
    assert.equal(JSON.parse(readFileSync(trace.path, "utf8").trim()).id, "trace-infra");
  } finally {
    if (prior === undefined) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(data, { recursive: true, force: true });
  }
});
