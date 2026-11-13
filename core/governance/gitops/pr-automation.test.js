import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendPrAutomationTrace,
  buildPrAutomationPlan,
  fetchPrAutomationSnapshot,
  fetchRequiredStatusChecks,
  parsePullRequestNumber,
  PR_AUTOMATION_OUTCOMES,
  prAutomationTracePath,
  requestPrAutoMerge,
  requiredContextsFromProtection,
  summarizeRequiredChecks,
} from "./pr-automation.js";

function snapshot(overrides = {}) {
  const requiredContexts = overrides.requiredContexts || ["ci-verify", "codeql", "secret-scan", "dependency-scan"];
  return {
    repository: {
      nameWithOwner: "example-org/illuci",
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      mergeCommitAllowed: true,
      ...(overrides.repository || {}),
    },
    pullRequest: {
      id: "PR_kwDOTest",
      number: 62,
      title: "[A10] Governed GitOps auto-merge actuator",
      url: "https://github.com/example-org/illuci/pull/62",
      state: "OPEN",
      merged: false,
      mergedAt: null,
      isDraft: false,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      baseRefName: "main",
      headRefName: "mallowfluff-a10-auto-merge-actuator",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      autoMergeRequest: null,
      labels: [],
      changedFiles: [{ path: "notes.txt", additions: 1, deletions: 0 }],
      statusCheckRollup: requiredContexts.map((name, index) => ({
        __typename: "CheckRun",
        name,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: `2026-06-26T12:0${index}:00Z`,
        completedAt: `2026-06-26T12:0${index}:05Z`,
      })),
      ...(overrides.pullRequest || {}),
    },
    branchProtection: {
      ok: true,
      requiredContexts,
      raw: {},
      ...(overrides.branchProtection || {}),
    },
    ...(overrides.branchRules ? { branchRules: overrides.branchRules } : {}),
    ...(overrides.requiredCheckPolicy ? { requiredCheckPolicy: overrides.requiredCheckPolicy } : {}),
  };
}

test("requiredContextsFromProtection deduplicates legacy contexts and checks", () => {
  assert.deepEqual(requiredContextsFromProtection({
    contexts: ["ci-verify", "codeql"],
    checks: [{ context: "ci-verify" }, { context: "secret-scan" }],
  }), ["ci-verify", "codeql", "secret-scan"]);
});

test("automation records union branch protection and branch-rules required checks", () => {
  const plan = buildPrAutomationPlan(snapshot({
    requiredContexts: ["ci-verify", "codeql", "secret-scan"],
    branchProtection: { ok: true, requiredContexts: ["ci-verify", "codeql"] },
    branchRules: { ok: true, requiredContexts: ["codeql", "secret-scan"] },
  }));
  assert.equal(plan.record.inputs.requiredCheckPolicy.status, "ok");
  assert.deepEqual(plan.record.inputs.requiredCheckPolicy.requiredContexts, ["ci-verify", "codeql", "secret-scan"]);
  assert.deepEqual(plan.record.inputs.requiredCheckPolicy.sources.map((source) => source.kind), ["branch-protection", "branch-rules"]);
});

test("branch protection 404 is not-configured when branch rules are readable", () => {
  const plan = buildPrAutomationPlan(snapshot({
    requiredContexts: ["ci-verify"],
    branchProtection: { ok: false, statusCode: 404, requiredContexts: [], error: "not found" },
    branchRules: { ok: true, requiredContexts: ["ci-verify"] },
  }));
  assert.equal(plan.requestable, true);
  assert.equal(plan.record.inputs.requiredCheckPolicy.sources[0].status, "not-configured");
  assert.deepEqual(plan.record.inputs.requiredCheckPolicy.requiredContexts, ["ci-verify"]);
});

test("unreadable policy source blocks even when another source has checks", () => {
  const plan = buildPrAutomationPlan(snapshot({
    requiredContexts: ["ci-verify"],
    branchProtection: { ok: false, statusCode: 403, requiredContexts: [], error: "forbidden" },
    branchRules: { ok: true, requiredContexts: ["ci-verify"] },
  }));
  assert.equal(plan.record.inputs.requiredCheckPolicy.status, "unavailable");
  assert.deepEqual(plan.record.inputs.requiredCheckPolicy.errors.map((error) => error.kind), ["branch-protection"]);
  assert.ok(plan.record.action.blockedBy.includes("required-check-policy-unavailable"));
});

test("readable policy with no configured checks is empty", () => {
  const plan = buildPrAutomationPlan(snapshot({
    requiredContexts: [],
    branchProtection: { ok: true, requiredContexts: [] },
    branchRules: { ok: true, requiredContexts: [] },
  }));
  assert.equal(plan.record.inputs.requiredCheckPolicy.status, "empty");
  assert.ok(plan.record.action.blockedBy.includes("required-check-policy-empty"));
});

test("summarizeRequiredChecks uses the latest run for each required context", () => {
  const summary = summarizeRequiredChecks({
    requiredContexts: ["ci-verify", "codeql", "dependency-scan", "secret-scan"],
    statusCheckRollup: [
      { name: "ci-verify", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-06-26T12:00:00Z" },
      { name: "ci-verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T12:10:00Z" },
      { name: "codeql", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-06-26T12:11:00Z" },
      { name: "dependency-scan", status: "COMPLETED", conclusion: "CANCELLED", completedAt: "2026-06-26T12:12:00Z" },
    ],
  });
  assert.equal(summary.allPassed, false);
  assert.deepEqual(summary.passed.map((check) => check.context), ["ci-verify"]);
  assert.deepEqual(summary.pending.map((check) => check.context), ["codeql"]);
  assert.deepEqual(summary.failed.map((check) => check.context), ["dependency-scan"]);
  assert.deepEqual(summary.missing.map((check) => check.context), ["secret-scan"]);
});

test("draft PRs are blocked and never marked ready by the actuator", () => {
  const plan = buildPrAutomationPlan(snapshot({ pullRequest: { isDraft: true } }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.BLOCKED);
  assert.ok(plan.record.action.blockedBy.includes("draft-pr"));
  assert.equal(plan.requestable, false);
});

test("existing auto-merge request is a no-op outcome", () => {
  const plan = buildPrAutomationPlan(snapshot({
    pullRequest: { autoMergeRequest: { enabledAt: "2026-06-26T12:20:00Z", mergeMethod: "SQUASH" } },
  }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.ALREADY_REQUESTED);
  assert.equal(plan.requestable, false);
});

test("already merged PRs are terminal observations before mergeability blockers", () => {
  const plan = buildPrAutomationPlan(snapshot({
    pullRequest: {
      state: "MERGED",
      merged: true,
      mergedAt: "2026-06-27T07:00:11Z",
      mergeCommitOid: "d".repeat(40),
      mergeStateStatus: "UNKNOWN",
      mergeable: "UNKNOWN",
    },
  }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.OBSERVED_MERGED);
  assert.equal(plan.requestable, false);
  assert.deepEqual(plan.record.action.blockedBy, []);
  assert.equal(plan.record.action.allowed, true);
  assert.equal(plan.record.action.mutation.observedTerminalState, true);
  assert.equal(plan.record.action.mutation.mergedAt, "2026-06-27T07:00:11Z");
  assert.equal(plan.record.action.mutation.mergeCommitOid, "d".repeat(40));
  assert.equal(plan.record.classification.outcome.allowed, true);
  assert.equal(plan.record.classification.outcome.selectedStrategy, PR_AUTOMATION_OUTCOMES.OBSERVED_MERGED);
  assert.equal(plan.record.classification.mergeStrategy.code, "terminal-observed-merged");
  assert.deepEqual(plan.record.classification.mergeStrategy.audit.blockingSignals, []);
});

test("all required checks passing makes a clean ready PR requestable", () => {
  const plan = buildPrAutomationPlan(snapshot());
  assert.equal(plan.requestable, true);
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.AUTO_MERGE_REQUESTED);
  assert.deepEqual(plan.record.action.blockedBy, []);
});

test("empty readable required-check policy blocks the actuator", () => {
  const plan = buildPrAutomationPlan(snapshot({
    requiredContexts: [],
    branchProtection: { ok: true, requiredContexts: [] },
    branchRules: { ok: true, requiredContexts: [] },
  }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.BLOCKED);
  assert.ok(plan.record.action.blockedBy.includes("required-check-policy-empty"));
  assert.equal(plan.record.inputs.requiredCheckPolicy.status, "empty");
});

test("unreadable required-check policy blocks the actuator", () => {
  const plan = buildPrAutomationPlan(snapshot({
    branchProtection: { ok: false, statusCode: 403, requiredContexts: [], error: "forbidden" },
    branchRules: { ok: true, requiredContexts: ["ci-verify"] },
  }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.BLOCKED);
  assert.ok(plan.record.action.blockedBy.includes("required-check-policy-unavailable"));
  assert.equal(plan.record.inputs.requiredCheckPolicy.status, "unavailable");
});

test("pending or missing required checks block even when classification is otherwise eligible", () => {
  const plan = buildPrAutomationPlan(snapshot({
    pullRequest: {
      statusCheckRollup: [
        { name: "ci-verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T12:00:00Z" },
        { name: "codeql", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-06-26T12:01:00Z" },
      ],
    },
  }));
  assert.equal(plan.record.action.outcome, PR_AUTOMATION_OUTCOMES.BLOCKED);
  assert.ok(plan.record.action.blockedBy.includes("required-checks-pending"));
  assert.ok(plan.record.action.blockedBy.includes("required-checks-missing"));
});

test("requestPrAutoMerge records a successful GraphQL auto-merge request", async () => {
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /graphql$/);
    assert.equal(options.method, "POST");
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: {
          enablePullRequestAutoMerge: {
            pullRequest: {
              number: 62,
              url: "https://github.com/example-org/illuci/pull/62",
              state: "OPEN",
              merged: false,
              mergedAt: null,
              autoMergeRequest: { enabledAt: "2026-06-26T12:21:00Z", mergeMethod: "SQUASH" },
              mergeCommit: null,
            },
          },
        },
      }),
      headers: { get: () => null },
    };
  };
  const result = await requestPrAutoMerge({
    snapshot: snapshot(),
    token: "token",
    fetchImpl,
  });
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.AUTO_MERGE_REQUESTED);
  assert.equal(result.record.action.mutation.mergeMethod, "SQUASH");
});

test("requestPrAutoMerge immediately squash-merges an already clean eligible PR", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /graphql$/);
    const body = JSON.parse(options.body);
    seen.push(body.query);
    if (/enablePullRequestAutoMerge/.test(body.query)) {
      return {
        ok: true,
        text: async () => JSON.stringify({ errors: [{ message: "Pull request Pull request is in clean status" }] }),
        headers: { get: () => null },
      };
    }
    assert.match(body.query, /mergePullRequest/);
    return {
      ok: true,
      text: async () => JSON.stringify({
        data: {
          mergePullRequest: {
            pullRequest: {
              number: 62,
              url: "https://github.com/example-org/illuci/pull/62",
              state: "MERGED",
              merged: true,
              mergedAt: "2026-06-26T13:48:00Z",
              autoMergeRequest: null,
              mergeCommit: { oid: "c".repeat(40) },
            },
          },
        },
      }),
      headers: { get: () => null },
    };
  };
  const result = await requestPrAutoMerge({
    snapshot: snapshot(),
    token: "token",
    fetchImpl,
  });
  assert.equal(seen.length, 2);
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.MERGED_IMMEDIATELY);
  assert.equal(result.record.action.allowed, true);
  assert.equal(result.record.action.mutation.mergeMethod, "SQUASH");
  assert.equal(result.record.action.mutation.mergedAt, "2026-06-26T13:48:00Z");
  assert.equal(result.record.action.mutation.mergeCommitOid, "c".repeat(40));
});

test("requestPrAutoMerge stops on GitHub rejection without choosing another strategy", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ errors: [{ message: "Auto-merge is not allowed" }] }),
    headers: { get: () => null },
  });
  const result = await requestPrAutoMerge({
    snapshot: snapshot(),
    token: "token",
    fetchImpl,
  });
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.BLOCKED);
  assert.ok(result.record.action.blockedBy.includes("github-rejected-expected-strategy"));
  assert.match(result.record.action.error, /Auto-merge is not allowed/);
});

test("requestPrAutoMerge observes terminal merged state after mutation-time already-merged race", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /graphql$/);
    const body = JSON.parse(options.body);
    seen.push(body.query);
    if (/enablePullRequestAutoMerge/.test(body.query)) {
      return {
        ok: true,
        text: async () => JSON.stringify({ errors: [{ message: "Pull request Pull request is in clean status" }] }),
        headers: { get: () => null },
      };
    }
    assert.match(body.query, /mergePullRequest/);
    return {
      ok: true,
      text: async () => JSON.stringify({ errors: [{ message: "Pull request Pull request is already merged" }] }),
      headers: { get: () => null },
    };
  };
  const result = await requestPrAutoMerge({
    snapshot: snapshot(),
    token: "token",
    fetchImpl,
    refetchSnapshot: async () => snapshot({
      pullRequest: {
        state: "MERGED",
        merged: true,
        mergedAt: "2026-06-27T08:17:23Z",
        mergeCommitOid: "e".repeat(40),
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
      },
    }),
  });
  assert.equal(seen.length, 2);
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.OBSERVED_MERGED);
  assert.equal(result.record.action.allowed, true);
  assert.deepEqual(result.record.action.blockedBy, []);
  assert.equal(result.record.action.mutation.observedTerminalState, true);
  assert.equal(result.record.action.mutation.mergedAt, "2026-06-27T08:17:23Z");
  assert.equal(result.record.action.mutation.mergeCommitOid, "e".repeat(40));
  assert.equal(result.record.classification.outcome.allowed, true);
  assert.equal(result.record.classification.mergeStrategy.code, "terminal-observed-merged");
  assert.deepEqual(result.record.classification.mergeStrategy.audit.blockingSignals, []);
});

test("requestPrAutoMerge observes terminal merged state after mutation-time merge-in-progress race", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    assert.match(String(url), /graphql$/);
    const body = JSON.parse(options.body);
    seen.push(body.query);
    if (/enablePullRequestAutoMerge/.test(body.query)) {
      return {
        ok: true,
        text: async () => JSON.stringify({ errors: [{ message: "Pull request Pull request is in clean status" }] }),
        headers: { get: () => null },
      };
    }
    assert.match(body.query, /mergePullRequest/);
    return {
      ok: true,
      text: async () => JSON.stringify({ errors: [{ message: "Merge already in progress" }] }),
      headers: { get: () => null },
    };
  };
  const result = await requestPrAutoMerge({
    snapshot: snapshot(),
    token: "token",
    fetchImpl,
    refetchSnapshot: async () => snapshot({
      pullRequest: {
        state: "MERGED",
        merged: true,
        mergedAt: "2026-06-27T08:29:07Z",
        mergeCommitOid: "f".repeat(40),
        mergeStateStatus: "UNKNOWN",
        mergeable: "UNKNOWN",
      },
    }),
  });
  assert.equal(seen.length, 2);
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.OBSERVED_MERGED);
  assert.equal(result.record.action.allowed, true);
  assert.deepEqual(result.record.action.blockedBy, []);
  assert.equal(result.record.action.mutation.observedTerminalState, true);
  assert.equal(result.record.action.mutation.mergedAt, "2026-06-27T08:29:07Z");
  assert.equal(result.record.action.mutation.mergeCommitOid, "f".repeat(40));
  assert.equal(result.record.classification.outcome.allowed, true);
  assert.equal(result.record.classification.mergeStrategy.code, "terminal-observed-merged");
  assert.deepEqual(result.record.classification.mergeStrategy.audit.blockingSignals, []);
});

test("requestPrAutoMerge uses policyToken for policy reads and mutation token for PR reads and mutation", async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const auth = options.headers?.authorization;
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith("/graphql")) {
      seen.push({ kind: body.query.includes("enablePullRequestAutoMerge") ? "mutation" : "pr-query", auth });
      assert.equal(auth, "Bearer mutation-token");
      if (body.query.includes("enablePullRequestAutoMerge")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: {
              enablePullRequestAutoMerge: {
                pullRequest: {
                  number: 64,
                  url: "https://github.com/example-org/illuci/pull/64",
                  state: "OPEN",
                  merged: false,
                  mergedAt: null,
                  autoMergeRequest: { enabledAt: "2026-06-26T15:10:00Z", mergeMethod: "SQUASH" },
                  mergeCommit: null,
                },
              },
            },
          }),
          headers: { get: () => null },
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            repository: {
              nameWithOwner: "example-org/illuci",
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              mergeCommitAllowed: true,
              pullRequest: {
                id: "PR_kwDOTest",
                number: 64,
                title: "[A12] CI actuator policy visibility",
                url: "https://github.com/example-org/illuci/pull/64",
                state: "OPEN",
                merged: false,
                mergedAt: null,
                isDraft: false,
                mergeStateStatus: "CLEAN",
                mergeable: "MERGEABLE",
                baseRefName: "main",
                headRefName: "mallowfluff-a12-ci-actuator-policy-visibility",
                baseRefOid: "a".repeat(40),
                headRefOid: "b".repeat(40),
                autoMergeRequest: null,
                labels: { nodes: [] },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: "CheckRun", name: "ci-verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T15:00:00Z" },
                      { __typename: "CheckRun", name: "codeql", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T15:01:00Z" },
                    ],
                  },
                },
              },
            },
          },
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/pulls/64/files")) {
      seen.push({ kind: "files", auth });
      assert.equal(auth, "Bearer mutation-token");
      return {
        ok: true,
        text: async () => JSON.stringify([{ filename: "notes.txt", additions: 1, deletions: 0 }]),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/required_status_checks")) {
      seen.push({ kind: "branch-protection", auth });
      assert.equal(auth, "Bearer policy-token");
      return {
        ok: true,
        text: async () => JSON.stringify({ contexts: ["ci-verify"], checks: [] }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/rules/branches/main")) {
      seen.push({ kind: "branch-rules", auth });
      assert.equal(auth, "Bearer policy-token");
      return {
        ok: true,
        text: async () => JSON.stringify([{
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "codeql", integration_id: 15368 }] },
        }]),
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await requestPrAutoMerge({
    repository: "example-org/illuci",
    prNumber: 64,
    token: "mutation-token",
    policyToken: "policy-token",
    fetchImpl,
  });
  assert.deepEqual(seen.map((entry) => entry.kind), ["pr-query", "files", "branch-protection", "branch-rules", "mutation"]);
  assert.equal(result.record.action.outcome, PR_AUTOMATION_OUTCOMES.AUTO_MERGE_REQUESTED);
  assert.deepEqual(result.record.inputs.requiredCheckPolicy.requiredContexts, ["ci-verify", "codeql"]);
});

test("fetchRequiredStatusChecks normalizes branch-protection contexts", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /required_status_checks$/);
    return {
      ok: true,
      text: async () => JSON.stringify({
        contexts: ["ci-verify"],
        checks: [{ context: "codeql" }],
      }),
      headers: { get: () => null },
    };
  };
  assert.deepEqual(await fetchRequiredStatusChecks({
    repository: "example-org/illuci",
    baseRefName: "main",
    token: "token",
    fetchImpl,
  }), {
    ok: true,
    status: "ok",
    statusCode: 200,
    requiredContexts: ["ci-verify", "codeql"],
    raw: { contexts: ["ci-verify"], checks: [{ context: "codeql" }] },
  });
});

test("fetchPrAutomationSnapshot includes combined required-check policy", async () => {
  const fetchImpl = async (url, options = {}) => {
    const auth = options.headers?.authorization;
    if (String(url).endsWith("/graphql")) {
      assert.equal(auth, "Bearer mutation-token");
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: {
            repository: {
              nameWithOwner: "example-org/illuci",
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              mergeCommitAllowed: true,
              pullRequest: {
                id: "PR_kwDOTest",
                number: 64,
                title: "[A12] CI actuator policy visibility",
                url: "https://github.com/example-org/illuci/pull/64",
                state: "OPEN",
                merged: false,
                mergedAt: null,
                isDraft: false,
                mergeStateStatus: "CLEAN",
                mergeable: "MERGEABLE",
                baseRefName: "main",
                headRefName: "mallowfluff-a12-ci-actuator-policy-visibility",
                baseRefOid: "a".repeat(40),
                headRefOid: "b".repeat(40),
                autoMergeRequest: null,
                labels: { nodes: [] },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          },
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/pulls/64/files")) {
      assert.equal(auth, "Bearer mutation-token");
      return {
        ok: true,
        text: async () => JSON.stringify([{ filename: "notes.txt", additions: 1, deletions: 0 }]),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/required_status_checks")) {
      assert.equal(auth, "Bearer policy-token");
      return {
        ok: true,
        text: async () => JSON.stringify({ contexts: ["ci-verify"], checks: [] }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/rules/branches/main")) {
      assert.equal(auth, "Bearer policy-token");
      return {
        ok: true,
        text: async () => JSON.stringify([{
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "codeql", integration_id: 15368 }] },
        }]),
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await fetchPrAutomationSnapshot({
    repository: "example-org/illuci",
    prNumber: 64,
    token: "mutation-token",
    policyToken: "policy-token",
    fetchImpl,
  });
  assert.equal(result.requiredCheckPolicy.status, "ok");
  assert.deepEqual(result.requiredCheckPolicy.requiredContexts, ["ci-verify", "codeql"]);
});

test("fetchRequiredStatusChecks records non-JSON GitHub errors as unavailable protection", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
    text: async () => "branch protection unavailable",
    headers: { get: () => null },
  });
  const result = await fetchRequiredStatusChecks({
    repository: "example-org/illuci",
    baseRefName: "main",
    token: "token",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /branch protection unavailable/);
});

test("parsePullRequestNumber accepts numbers and GitHub PR URLs", () => {
  assert.equal(parsePullRequestNumber("62"), 62);
  assert.equal(parsePullRequestNumber("https://github.com/example-org/illuci/pull/62"), 62);
  assert.equal(parsePullRequestNumber("not-a-pr"), null);
});

test("appendPrAutomationTrace writes JSONL under the gitops automation lane", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-automation-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    const plan = buildPrAutomationPlan(snapshot(), { dryRun: true });
    const trace = appendPrAutomationTrace(plan.record);
    assert.equal(trace.displayPath, ".illuci/data/gitops/pr-automation/records.jsonl");
    assert.equal(trace.path, prAutomationTracePath());
    assert.equal(existsSync(trace.path), true);
    const line = readFileSync(trace.path, "utf8").trim();
    assert.equal(JSON.parse(line).schema, "illuci.gitops.pr-automation/1");
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
