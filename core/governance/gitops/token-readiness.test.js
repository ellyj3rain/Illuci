import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendGitopsTokenReadinessTrace,
  buildGitopsTokenReadinessRecord,
  checkGitopsTokenReadiness,
  fetchCorpusTokenReadiness,
  fetchRequiredCheckPolicyReadiness,
  GITOPS_TOKEN_READINESS_SCHEMA,
  gitopsTokenReadinessTracePath,
} from "./token-readiness.js";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  };
}

function readyInput(overrides = {}) {
  return {
    repository: "example-org/illuci",
    baseRef: "main",
    tokenSources: {
      policy: { name: "ILLUCI_GITOPS_TOKEN", present: true, authority: "required-check policy read" },
      corpus: { name: "ILLUCI_GITOPS_CORPUS_TOKEN", present: true, authority: "corpus promotion readiness" },
      mutation: { name: "GITHUB_TOKEN", present: true, authority: "PR auto-merge mutation" },
    },
    policy: {
      ready: true,
      status: "ok",
      requiredContexts: ["ci-verify", "codeql"],
      sources: [
        { kind: "branch-protection", status: "ok", statusCode: 200, requiredContexts: ["ci-verify"] },
        { kind: "branch-rules", status: "ok", statusCode: 200, requiredContexts: ["codeql"] },
      ],
      errors: [],
    },
    corpus: {
      ready: true,
      status: "ok",
      repositoryReadable: true,
      writeCapable: true,
      permissionEvidence: { pull: true, push: true, maintain: false, admin: false, triage: true },
      evidence: { method: "repository-permissions", nonMutating: true, pushCapabilityInferred: true },
      errors: [],
    },
    ...(overrides || {}),
  };
}

test("token readiness record reports ready without serializing token values", () => {
  const record = buildGitopsTokenReadinessRecord(readyInput(), { id: "ready-test", timestamp: "2026-06-26T17:00:00Z" });
  assert.equal(record.schema, GITOPS_TOKEN_READINESS_SCHEMA);
  assert.equal(record.action.outcome, "ready");
  assert.deepEqual(record.action.blockedBy, []);
  assert.equal(record.inputs.requiredCheckPolicy.status, "ok");
  assert.deepEqual(record.policy.requiredContexts, ["ci-verify", "codeql"]);
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /policy-secret|corpus-secret|mutation-secret/);
});

test("missing tokens fail closed with explicit blocked reasons", () => {
  const record = buildGitopsTokenReadinessRecord({
    ...readyInput(),
    tokenSources: {
      policy: { name: "ILLUCI_GITOPS_TOKEN", present: false, authority: "required-check policy read" },
      corpus: { name: "ILLUCI_GITOPS_CORPUS_TOKEN", present: false, authority: "corpus promotion readiness" },
      mutation: { name: "GITHUB_TOKEN|GH_TOKEN", present: false, authority: "PR auto-merge mutation" },
    },
  });
  assert.equal(record.action.outcome, "blocked");
  assert.ok(record.action.blockedBy.includes("policy-token-missing"));
  assert.ok(record.action.blockedBy.includes("corpus-token-missing"));
  assert.ok(record.action.blockedBy.includes("mutation-token-missing"));
});

test("policy readiness unions branch protection and branch-rules checks", async () => {
  const seen = [];
  const policy = await fetchRequiredCheckPolicyReadiness({
    repository: "example-org/illuci",
    baseRef: "main",
    token: "policy-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), authorization: options.headers.authorization });
      if (String(url).includes("/protection/required_status_checks")) {
        return response(200, { contexts: ["ci-verify"], checks: [{ context: "codeql" }] });
      }
      return response(200, [{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "secret-scan" }, { context: "codeql" }] },
      }]);
    },
  });
  assert.equal(policy.status, "ok");
  assert.deepEqual(policy.requiredContexts, ["ci-verify", "codeql", "secret-scan"]);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((request) => request.authorization === "Bearer policy-secret"));
});

test("branch protection 404 is not-configured when branch rules are readable", async () => {
  const policy = await fetchRequiredCheckPolicyReadiness({
    repository: "example-org/illuci",
    baseRef: "main",
    token: "policy-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url) => {
      if (String(url).includes("/protection/required_status_checks")) {
        return response(404, { message: "Branch not protected" });
      }
      return response(200, [{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci-verify" }] },
      }]);
    },
  });
  assert.equal(policy.status, "ok");
  assert.equal(policy.sources[0].status, "not-configured");
  assert.deepEqual(policy.requiredContexts, ["ci-verify"]);
});

test("policy 403 fails closed as unavailable", async () => {
  const policy = await fetchRequiredCheckPolicyReadiness({
    repository: "example-org/illuci",
    baseRef: "main",
    token: "policy-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url) => {
      if (String(url).includes("/protection/required_status_checks")) {
        return response(403, { message: "Resource not accessible by integration" });
      }
      return response(200, [{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci-verify" }] },
      }]);
    },
  });
  assert.equal(policy.status, "unavailable");
  assert.equal(policy.ready, false);
  assert.deepEqual(policy.errors.map((error) => error.kind), ["branch-protection"]);
});

test("readable policy with no required checks fails closed as empty", async () => {
  const policy = await fetchRequiredCheckPolicyReadiness({
    repository: "example-org/illuci",
    baseRef: "main",
    token: "policy-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async () => response(200, []),
  });
  assert.equal(policy.status, "empty");
  const record = buildGitopsTokenReadinessRecord(readyInput({ policy }));
  assert.ok(record.action.blockedBy.includes("required-check-policy-empty"));
});

test("corpus token infers push readiness from non-mutating repository permissions", async () => {
  const corpus = await fetchCorpusTokenReadiness({
    repository: "example-org/illuci",
    token: "corpus-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      assert.match(String(url), /\/repos\/example-org\/illuci$/);
      assert.equal(options.headers.authorization, "Bearer corpus-secret");
      return response(200, { permissions: { pull: true, push: true, triage: true } });
    },
  });
  assert.equal(corpus.status, "ok");
  assert.equal(corpus.ready, true);
  assert.equal(corpus.evidence.nonMutating, true);
  assert.equal(corpus.writeCapable, true);
});

test("corpus token without push, maintain, or admin permission blocks", async () => {
  const corpus = await fetchCorpusTokenReadiness({
    repository: "example-org/illuci",
    token: "corpus-secret",
    apiUrl: "https://api.github.test",
    fetchImpl: async () => response(200, { permissions: { pull: true, push: false, triage: true } }),
  });
  assert.equal(corpus.status, "insufficient-permission");
  assert.equal(corpus.ready, false);
  const record = buildGitopsTokenReadinessRecord(readyInput({ corpus }));
  assert.ok(record.action.blockedBy.includes("corpus-token-insufficient-permission"));
});

test("checkGitopsTokenReadiness uses policy token for policy reads and corpus token for corpus reads", async () => {
  const requests = [];
  const result = await checkGitopsTokenReadiness({
    repository: "example-org/illuci",
    env: {
      ILLUCI_GITOPS_TOKEN: "policy-secret",
      ILLUCI_GITOPS_CORPUS_TOKEN: "corpus-secret",
      GITHUB_TOKEN: "mutation-secret",
    },
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.authorization });
      if (String(url).includes("/protection/required_status_checks")) {
        return response(200, { contexts: ["ci-verify"] });
      }
      if (String(url).includes("/rules/branches/")) {
        return response(200, [{
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "codeql" }] },
        }]);
      }
      return response(200, { permissions: { pull: true, push: true } });
    },
  });
  assert.equal(result.record.action.ready, true);
  assert.deepEqual(requests.map((request) => request.authorization), [
    "Bearer policy-secret",
    "Bearer policy-secret",
    "Bearer corpus-secret",
  ]);
  const text = JSON.stringify(result.record);
  assert.doesNotMatch(text, /policy-secret|corpus-secret|mutation-secret/);
});

test("token readiness trace appends JSONL under the gitops data lane", () => {
  const data = mkdtempSync(join(tmpdir(), "illuci-token-readiness-data-"));
  const prior = process.env.ILLUCI_DATA_HOME;
  process.env.ILLUCI_DATA_HOME = data;
  try {
    const record = buildGitopsTokenReadinessRecord(readyInput(), { id: "trace-test" });
    const trace = appendGitopsTokenReadinessTrace(record);
    assert.equal(trace.displayPath, ".illuci/data/gitops/token-readiness/records.jsonl");
    assert.equal(trace.path, gitopsTokenReadinessTracePath());
    assert.equal(existsSync(trace.path), true);
    assert.equal(JSON.parse(readFileSync(trace.path, "utf8").trim()).id, "trace-test");
  } finally {
    if (prior === undefined) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(data, { recursive: true, force: true });
  }
});
