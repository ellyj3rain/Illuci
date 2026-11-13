import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendPrOutcomeObservationTrace,
  appendPrOutcomeTrace,
  auditPrOutcomeCorpusContinuity,
  backfillPrOutcomes,
  buildPrOutcome,
  buildPrOutcomeObservation,
  collectPrOutcome,
  fetchPostMergeChecks,
  fetchPrOutcomeSnapshot,
  formatPrOutcomeCorpusContinuity,
  isGeneratedPrOutcomeCorpusPullRequest,
  listCommittedPrOutcomeCorpusNumbers,
  listTerminalPullRequests,
  prCorpusKey,
  PR_OUTCOME_CORPUS_CONTINUITY_SCHEMA,
  PR_OUTCOME_OBSERVATION_SCHEMA,
  PR_OUTCOME_SCHEMA,
  prOutcomeCorpusPaths,
  prOutcomeObservationTracePath,
  prOutcomeTracePath,
  promotePrOutcomeCorpus,
  terminalKind,
} from "./pr-outcome.js";

function snapshot(overrides = {}) {
  const requiredContexts = overrides.requiredContexts || ["ci-verify", "codeql"];
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
      number: 65,
      title: "[A12] Add CI actuator policy visibility",
      url: "https://github.com/example-org/illuci/pull/65",
      state: "MERGED",
      merged: true,
      mergedAt: "2026-06-26T15:41:12Z",
      closedAt: "2026-06-26T15:41:12Z",
      mergeCommitOid: "3b77cc54b18c3559cfa09ec2b1db778d268cff52",
      isDraft: false,
      mergeStateStatus: "UNKNOWN",
      mergeable: "UNKNOWN",
      baseRefName: "main",
      headRefName: "mallowfluff-a12-ci-actuator-policy-visibility",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      autoMergeRequest: null,
      labels: [],
      changedFiles: [{ path: "core/governance/gitops/pr-automation.js", additions: 10, deletions: 2 }],
      statusCheckRollup: requiredContexts.map((name, index) => ({
        __typename: "CheckRun",
        name,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: `2026-06-26T15:3${index}:00Z`,
      })),
      ...(overrides.pullRequest || {}),
    },
    branchProtection: { ok: true, requiredContexts },
    branchRules: { ok: true, requiredContexts: [] },
    requiredCheckPolicy: {
      ok: true,
      status: "ok",
      requiredContexts,
      sources: [
        { kind: "branch-protection", status: "ok", requiredContexts, error: null, statusCode: 200 },
        { kind: "branch-rules", status: "ok", requiredContexts: [], error: null, statusCode: 200 },
      ],
      errors: [],
    },
    postMergeChecks: [
      { id: 1, name: "ci-verify", status: "completed", conclusion: "success", event: "push", url: "https://example.test/ci" },
      { id: 2, name: "codeql", status: "completed", conclusion: "success", event: "push", url: "https://example.test/codeql" },
    ],
    ...(overrides.root || {}),
  };
}

test("terminalKind distinguishes merged, closed-unmerged, and non-terminal PRs", () => {
  assert.equal(terminalKind({ state: "MERGED", merged: true }), "merged");
  assert.equal(terminalKind({ state: "CLOSED", merged: false }), "closed-unmerged");
  assert.equal(terminalKind({ state: "OPEN", merged: false }), "not-terminal");
});

test("buildPrOutcomeObservation joins terminal, classifier, automation, and check evidence", () => {
  const observation = buildPrOutcomeObservation({ snapshot: snapshot(), sourceEvent: "pull_request.closed" }, {
    id: "obs-test",
    timestamp: "2026-06-26T16:02:00.000Z",
  });
  assert.equal(observation.schema, PR_OUTCOME_OBSERVATION_SCHEMA);
  assert.equal(observation.subject.prNumber, 65);
  assert.equal(observation.inputs.terminal.kind, "merged");
  assert.equal(observation.inputs.requiredChecks.total, 2);
  assert.equal(observation.inputs.postMergeChecks.total, 2);
  assert.equal(observation.outcomeCandidate.terminal, true);
  assert.equal(observation.outcomeCandidate.settled, true);
  assert.equal(observation.classification.schema, "illuci.gitops.pr-classification/1");
  assert.equal(observation.automation.schema, "illuci.gitops.pr-automation/1");
});

test("buildPrOutcome records closed-unmerged terminal outcomes", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      pullRequest: {
        state: "CLOSED",
        merged: false,
        mergedAt: null,
        closedAt: "2026-06-26T12:00:00Z",
        mergeCommitOid: null,
      },
      root: { postMergeChecks: [] },
    }),
  }, { id: "obs-closed", timestamp: "2026-06-26T16:02:00.000Z" });
  const outcome = buildPrOutcome({ observation });
  assert.equal(outcome.schema, PR_OUTCOME_SCHEMA);
  assert.equal(outcome.terminal.kind, "closed-unmerged");
  assert.equal(outcome.settled, true);
  assert.equal(outcome.id, "pr-outcome-pr-00065");
});

test("pending post-merge checks leave merged observations unsettled", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      root: {
        postMergeChecks: [
          { id: 1, name: "ci-verify", status: "completed", conclusion: "success" },
          { id: 2, name: "codeql", status: "in_progress", conclusion: null },
        ],
      },
    }),
  }, { id: "obs-pending" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-checks-pending"]);
});

test("failed post-merge checks leave merged observations unsettled", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      root: {
        postMergeChecks: [
          { id: 1, name: "ci-verify", status: "completed", conclusion: "success" },
          { id: 2, name: "codeql", status: "completed", conclusion: "failure" },
        ],
      },
    }),
  }, { id: "obs-failed" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-checks-failed"]);
  assert.equal(observation.inputs.postMergeChecks.failed, 1);
});

test("failed post-merge runs without runner or steps classify as execution substrate blocked", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      requiredContexts: ["ci-verify"],
      root: {
        postMergeChecks: [
          {
            id: 1,
            name: "ci-verify",
            status: "completed",
            conclusion: "failure",
            jobSummary: {
              available: true,
              total: 1,
              runnerAssigned: 0,
              unassignedRunnerJobs: 1,
              emptyStepJobs: 1,
              stepsTotal: 0,
              jobs: [{ id: 10, name: "ci-verify", runnerName: null, stepsTotal: 0 }],
            },
          },
        ],
      },
    }),
  }, { id: "obs-substrate-blocked" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.equal(observation.outcomeCandidate.evidenceState, "execution-substrate-blocked");
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-execution-substrate-blocked"]);
  assert.equal(observation.inputs.postMergeChecks.executionSubstrate.state, "blocked-before-runner");
  assert.equal(observation.inputs.postMergeChecks.executionSubstrate.codeAttribution, "not-evidenced");
  assert.deepEqual(observation.inputs.postMergeChecks.executionSubstrate.affectedRuns.map((run) => run.name), ["ci-verify"]);
});

test("failed post-merge runs with runner evidence remain check failures", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      requiredContexts: ["ci-verify"],
      root: {
        postMergeChecks: [
          {
            id: 1,
            name: "ci-verify",
            status: "completed",
            conclusion: "failure",
            jobSummary: {
              available: true,
              total: 1,
              runnerAssigned: 1,
              unassignedRunnerJobs: 0,
              emptyStepJobs: 0,
              stepsTotal: 4,
              jobs: [{ id: 10, name: "ci-verify", runnerName: "GitHub Actions 1", stepsTotal: 4 }],
            },
          },
        ],
      },
    }),
  }, { id: "obs-runner-failed" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.equal(observation.outcomeCandidate.evidenceState, "incomplete");
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-checks-failed"]);
  assert.equal(observation.inputs.postMergeChecks.executionSubstrate.state, "runner-started-failure");
  assert.equal(observation.inputs.postMergeChecks.executionSubstrate.codeAttribution, "possible");
});

test("missing required post-merge contexts leave merged observations unsettled", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      requiredContexts: ["ci-verify", "codeql", "dependency-scan"],
      root: {
        postMergeChecks: [
          { id: 1, name: "ci-verify", status: "completed", conclusion: "success" },
          { id: 2, name: "codeql", status: "completed", conclusion: "success" },
        ],
      },
    }),
  }, { id: "obs-missing-required" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-required-checks-missing"]);
  assert.deepEqual(observation.outcomeCandidate.missingRequiredPostMergeContexts, ["dependency-scan"]);
  assert.deepEqual(observation.inputs.postMergeChecks.missingRequiredContexts, ["dependency-scan"]);
});

test("empty required-check policy distinguishes unconfigured missing post-merge evidence", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      requiredContexts: [],
      branchProtection: { ok: true, requiredContexts: [] },
      branchRules: { ok: true, requiredContexts: [] },
      requiredCheckPolicy: {
        ok: true,
        status: "empty",
        requiredContexts: [],
        sources: [],
        errors: [],
      },
      root: { postMergeChecks: [] },
    }),
  }, { id: "obs-unconfigured" });
  assert.equal(observation.outcomeCandidate.settled, false);
  assert.equal(observation.outcomeCandidate.evidenceState, "unconfigured");
  assert.deepEqual(observation.outcomeCandidate.unsettledBy, ["post-merge-checks-unconfigured"]);
});

test("settlement only assesses required post-merge contexts when policy is configured", () => {
  const observation = buildPrOutcomeObservation({
    snapshot: snapshot({
      root: {
        postMergeChecks: [
          { id: 1, name: "ci-verify", status: "completed", conclusion: "success" },
          { id: 2, name: "codeql", status: "completed", conclusion: "success" },
          { id: 3, name: "pr-outcome-corpus", status: "completed", conclusion: "failure" },
        ],
      },
    }),
  }, { id: "obs-required-only" });
  assert.equal(observation.outcomeCandidate.settled, true);
  assert.equal(observation.inputs.postMergeChecks.total, 3);
  assert.equal(observation.inputs.postMergeChecks.assessedTotal, 2);
});

test("corpus paths are deterministic by PR number and record id", () => {
  assert.equal(prCorpusKey(65), "pr-00065");
  const observation = buildPrOutcomeObservation({ snapshot: snapshot() }, { id: "obs-test" });
  const outcome = buildPrOutcome({ observation });
  const root = join(tmpdir(), "illuci-pr-outcome-corpus-root");
  const paths = prOutcomeCorpusPaths({ observation, outcome, corpusRoot: root });
  assert.equal(paths.observationPath, join(root, "observations", "pr-00065", "obs-test.json"));
  assert.equal(paths.outcomePath, join(root, "outcomes", "pr-00065.json"));
});

test("corpus continuity audit reports ordinary gaps and skips generated corpus PRs", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-continuity-"));
  try {
    mkdirSync(join(root, "outcomes"), { recursive: true });
    writeFileSync(join(root, "outcomes", "pr-00067.json"), "{}\n", "utf8");
    const result = await auditPrOutcomeCorpusContinuity({
      repository: "example-org/illuci",
      corpusRoot: root,
      prs: [
        { number: 67, state: "MERGED", title: "[A14] Add GitOps token readiness doctor", headRefName: "mallowfluff-a14-gitops-token-readiness" },
        { number: 69, state: "MERGED", title: "[A13] Add PR #66 outcome corpus", headRefName: "mallowfluff-a13-pr-outcome-corpus-pr-00066" },
        { number: 77, state: "MERGED", title: "[A14.2] Guard corpus self-promotion", headRefName: "mallowfluff-a14-2-corpus-self-skip-hotfix" },
      ],
      timestamp: "2026-06-26T23:57:00.000Z",
    });
    assert.equal(result.schema, PR_OUTCOME_CORPUS_CONTINUITY_SCHEMA);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing.map((record) => record.prNumber), [77]);
    assert.deepEqual(result.skipped.map((record) => record.prNumber), [69]);
    assert.equal(result.policy.generatedCorpusPullRequests.continuity, "excluded-from-required-committed-outcome-set");
    assert.match(formatPrOutcomeCorpusContinuity(result), /missing: #77/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed corpus number listing and generated corpus detection are deterministic", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-list-"));
  try {
    mkdirSync(join(root, "outcomes"), { recursive: true });
    writeFileSync(join(root, "outcomes", "pr-00068.json"), "{}\n", "utf8");
    writeFileSync(join(root, "outcomes", "README.md"), "ignore\n", "utf8");
    assert.deepEqual(listCommittedPrOutcomeCorpusNumbers({ corpusRoot: root }), [68]);
    assert.equal(isGeneratedPrOutcomeCorpusPullRequest({
      title: "[A13] Add PR #78 outcome corpus",
      headRefName: "mallowfluff-a13-pr-outcome-corpus-pr-00078",
    }), true);
    assert.equal(isGeneratedPrOutcomeCorpusPullRequest({ title: "[A15] Calibrate outcome settlement evidence" }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotePrOutcomeCorpus writes full records and avoids duplicate rewrites", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-corpus-"));
  try {
    const observation = buildPrOutcomeObservation({ snapshot: snapshot() }, { id: "obs-test" });
    const outcome = buildPrOutcome({ observation });
    const promoted = promotePrOutcomeCorpus({ observation, outcome, corpusRoot: root });
    assert.equal(promoted.writes.observation.written, true);
    assert.equal(promoted.writes.outcome.written, true);
    assert.equal(JSON.parse(readFileSync(promoted.writes.outcome.path, "utf8")).schema, PR_OUTCOME_SCHEMA);
    const again = promotePrOutcomeCorpus({ observation, outcome, corpusRoot: root });
    assert.equal(again.writes.observation.reason, "already-exists");
    assert.equal(again.writes.outcome.reason, "already-exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotePrOutcomeCorpus honors dry-run without source writes", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-dry-"));
  try {
    const observation = buildPrOutcomeObservation({ snapshot: snapshot() }, { id: "obs-dry" });
    const outcome = buildPrOutcome({ observation });
    const promoted = promotePrOutcomeCorpus({ observation, outcome, corpusRoot: root, dryRun: true });
    assert.equal(promoted.writes.observation.reason, "dry-run");
    assert.equal(existsSync(promoted.writes.observation.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotePrOutcomeCorpus refuses observation-only source promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-nonterminal-"));
  try {
    const observation = buildPrOutcomeObservation({
      snapshot: snapshot({
        pullRequest: {
          state: "OPEN",
          merged: false,
          mergedAt: null,
          closedAt: null,
          mergeCommitOid: null,
          isDraft: true,
        },
        root: { postMergeChecks: [] },
      }),
    }, { id: "obs-open" });
    const outcome = buildPrOutcome({ observation });
    const promoted = promotePrOutcomeCorpus({ observation, outcome, corpusRoot: root });
    assert.equal(outcome, null);
    assert.equal(promoted.ok, false);
    assert.equal(promoted.writes.observation.reason, "no-terminal-outcome");
    assert.equal(promoted.writes.outcome.reason, "no-terminal-outcome");
    assert.equal(existsSync(promoted.writes.observation.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append outcome traces write JSONL under gitops lanes", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-data-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    const observation = buildPrOutcomeObservation({ snapshot: snapshot() }, { id: "obs-trace" });
    const outcome = buildPrOutcome({ observation });
    const obsTrace = appendPrOutcomeObservationTrace(observation);
    const outTrace = appendPrOutcomeTrace(outcome);
    assert.equal(obsTrace.path, prOutcomeObservationTracePath());
    assert.equal(outTrace.path, prOutcomeTracePath());
    assert.equal(JSON.parse(readFileSync(obsTrace.path, "utf8")).schema, PR_OUTCOME_OBSERVATION_SCHEMA);
    assert.equal(JSON.parse(readFileSync(outTrace.path, "utf8")).schema, PR_OUTCOME_SCHEMA);
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectPrOutcome can promote corpus from a supplied snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-collect-"));
  try {
    const result = await collectPrOutcome({
      snapshot: snapshot(),
      promoteCorpus: true,
      corpusRoot: root,
      observation: { id: "obs-collect", timestamp: "2026-06-26T16:02:00.000Z" },
    });
    assert.equal(result.outcome.schema, PR_OUTCOME_SCHEMA);
    assert.equal(result.corpus.writes.observation.written, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectPrOutcome does not source-promote non-terminal observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-pr-outcome-collect-open-"));
  try {
    const result = await collectPrOutcome({
      snapshot: snapshot({
        pullRequest: {
          state: "OPEN",
          merged: false,
          mergedAt: null,
          closedAt: null,
          mergeCommitOid: null,
          isDraft: true,
        },
        root: { postMergeChecks: [] },
      }),
      promoteCorpus: true,
      corpusRoot: root,
      observation: { id: "obs-collect-open", timestamp: "2026-06-27T01:59:00.000Z" },
    });
    assert.equal(result.outcome, null);
    assert.equal(result.corpus.ok, false);
    assert.equal(result.corpus.writes.observation.reason, "no-terminal-outcome");
    assert.equal(existsSync(result.corpus.writes.observation.path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listTerminalPullRequests reads closed PRs from GitHub pagination", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /pulls\?state=closed/);
    return {
      ok: true,
      text: async () => JSON.stringify([
        { number: 1, state: "closed", merged_at: "2026-06-01T00:00:00Z", closed_at: "2026-06-01T00:00:00Z", title: "one", html_url: "https://example.test/1" },
        { number: 2, state: "closed", merged_at: null, closed_at: "2026-06-02T00:00:00Z", title: "two", html_url: "https://example.test/2" },
      ]),
      headers: { get: () => null },
    };
  };
  const prs = await listTerminalPullRequests({ repository: "example-org/illuci", token: "token", fetchImpl });
  assert.deepEqual(prs.map((pr) => [pr.number, pr.state]), [[1, "MERGED"], [2, "CLOSED"]]);
});

test("fetchPrOutcomeSnapshot uses PR automation snapshot plus post-merge runs", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/graphql")) {
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
                number: 65,
                title: "[A12] Add CI actuator policy visibility",
                url: "https://github.com/example-org/illuci/pull/65",
                state: "MERGED",
                merged: true,
                mergedAt: "2026-06-26T15:41:12Z",
                closedAt: "2026-06-26T15:41:12Z",
                isDraft: false,
                mergeStateStatus: "UNKNOWN",
                mergeable: "UNKNOWN",
                baseRefName: "main",
                headRefName: "mallowfluff-a12-ci-actuator-policy-visibility",
                baseRefOid: "a".repeat(40),
                headRefOid: "b".repeat(40),
                autoMergeRequest: null,
                mergeCommit: { oid: "3".repeat(40) },
                labels: { nodes: [] },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          },
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/pulls/65/files")) {
      return {
        ok: true,
        text: async () => JSON.stringify([{ filename: "notes.txt", additions: 1, deletions: 0 }]),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/required_status_checks")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ contexts: ["ci-verify"], checks: [] }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/rules/branches/main")) {
      return {
        ok: true,
        text: async () => JSON.stringify([]),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/actions/runs")) {
      assert.match(String(url), /head_sha=333/);
      return {
        ok: true,
        text: async () => JSON.stringify({ workflow_runs: [{ id: 1, name: "ci-verify", status: "completed", conclusion: "success" }] }),
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await fetchPrOutcomeSnapshot({
    repository: "example-org/illuci",
    prNumber: 65,
    token: "token",
    fetchImpl,
  });
  assert.equal(result.pullRequest.mergeCommitOid, "3".repeat(40));
  assert.equal(result.postMergeChecks.length, 1);
});

test("fetchPostMergeChecks enriches failed runs with job-start evidence", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/actions/runs?")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          workflow_runs: [{
            id: 44,
            name: "ci-verify",
            status: "completed",
            conclusion: "failure",
            html_url: "https://example.test/run/44",
          }],
        }),
        headers: { get: () => null },
      };
    }
    if (String(url).includes("/actions/runs/44/jobs")) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          jobs: [{ id: 4401, name: "ci-verify", runner_name: "", steps: [] }],
        }),
        headers: { get: () => null },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const runs = await fetchPostMergeChecks({
    repository: "example-org/illuci",
    sha: "4".repeat(40),
    token: "token",
    fetchImpl,
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].jobSummary.total, 1);
  assert.equal(runs[0].executionSubstrate.state, "blocked-before-runner");
  assert.deepEqual(runs[0].executionSubstrate.signals, ["runner-unassigned", "zero-steps"]);
});

test("backfillPrOutcomes collects supplied terminal PRs", async () => {
  const result = await backfillPrOutcomes({
    repository: "example-org/illuci",
    prs: [{ number: 65 }],
    snapshot: snapshot(),
    observation: { id: "obs-backfill" },
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.outcomes, ["pr-outcome-pr-00065"]);
});
