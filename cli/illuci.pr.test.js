import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("pr classify emits JSON and appends a gitops trace", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-pr-repo-"));
  const data = mkdtempSync(join(tmpdir(), "illuci-cli-pr-data-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "illuci@example.test"]);
    git(repo, ["config", "user.name", "illuci test"]);
    writeFileSync(join(repo, "README.md"), "# test\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-qm", "initial"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["switch", "-qc", "feature"]);
    writeFileSync(join(repo, "notes.txt"), "PR classifier trace.\n", "utf8");
    git(repo, ["add", "notes.txt"]);
    git(repo, ["commit", "-qm", "change"]);

    const output = execFileSync(process.execPath, [
      cliPath,
      "pr",
      "classify",
      "--base",
      "main",
      "--json",
      "--write-trace",
      "--merge-state",
      "CLEAN",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: data },
      encoding: "utf8",
    });
    const record = JSON.parse(output);
    assert.equal(record.schema, "illuci.gitops.pr-classification/1");
    assert.equal(record.verdicts.mergeStrategy.strategy, "squash");
    assert.equal(record.trace.displayPath, ".illuci/data/gitops/pr-classifications/records.jsonl");
    assert.equal(existsSync(record.trace.path), true);
    const line = readFileSync(record.trace.path, "utf8").trim();
    assert.equal(JSON.parse(line).id, record.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("pr auto-merge dry-run emits JSON and appends an automation trace from a snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-pr-auto-repo-"));
  const data = mkdtempSync(join(tmpdir(), "illuci-cli-pr-auto-data-"));
  try {
    const snapshotPath = join(repo, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify({
      repository: {
        nameWithOwner: "example-org/illuci",
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        mergeCommitAllowed: true,
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
        statusCheckRollup: [
          { name: "ci-verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T12:00:00Z" },
          { name: "codeql", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T12:01:00Z" },
        ],
      },
      branchProtection: {
        ok: true,
        requiredContexts: ["ci-verify", "codeql"],
      },
    }), "utf8");

    const output = execFileSync(process.execPath, [
      cliPath,
      "pr",
      "auto-merge",
      "62",
      "--repo",
      "example-org/illuci",
      "--snapshot-file",
      snapshotPath,
      "--dry-run",
      "--json",
      "--write-trace",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: data },
      encoding: "utf8",
    });
    const record = JSON.parse(output);
    assert.equal(record.schema, "illuci.gitops.pr-automation/1");
    assert.equal(record.action.outcome, "skipped");
    assert.deepEqual(record.action.blockedBy, ["dry-run"]);
    assert.deepEqual(record.inputs.requiredCheckPolicy.requiredContexts, ["ci-verify", "codeql"]);
    assert.equal(record.inputs.requiredCheckPolicy.status, "ok");
    assert.equal(record.trace.displayPath, ".illuci/data/gitops/pr-automation/records.jsonl");
    assert.equal(existsSync(record.trace.path), true);
    const line = readFileSync(record.trace.path, "utf8").trim();
    assert.equal(JSON.parse(line).id, record.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("pr outcome collect emits JSON and appends outcome traces from a snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-pr-outcome-repo-"));
  const data = mkdtempSync(join(tmpdir(), "illuci-cli-pr-outcome-data-"));
  try {
    const snapshotPath = join(repo, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify({
      repository: {
        nameWithOwner: "example-org/illuci",
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        mergeCommitAllowed: true,
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
        changedFiles: [{ path: "notes.txt", additions: 1, deletions: 0 }],
        statusCheckRollup: [
          { name: "ci-verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-06-26T15:40:00Z" },
        ],
      },
      branchProtection: {
        ok: true,
        requiredContexts: ["ci-verify"],
      },
      branchRules: {
        ok: true,
        requiredContexts: [],
      },
      postMergeChecks: [
        { name: "ci-verify", status: "completed", conclusion: "success", event: "push" },
      ],
    }), "utf8");

    const output = execFileSync(process.execPath, [
      cliPath,
      "pr",
      "outcome",
      "collect",
      "65",
      "--repo",
      "example-org/illuci",
      "--snapshot-file",
      snapshotPath,
      "--json",
      "--write-trace",
      "--dry-run",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: data },
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.observation.schema, "illuci.gitops.pr-outcome-observation/1");
    assert.equal(result.outcome.schema, "illuci.gitops.pr-outcome/1");
    assert.equal(result.traces.observation.displayPath, ".illuci/data/gitops/pr-outcome-observations/records.jsonl");
    assert.equal(result.traces.outcome.displayPath, ".illuci/data/gitops/pr-outcomes/records.jsonl");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("pr outcome backfill dry-run uses fixture terminal PRs without corpus writes", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-pr-outcome-backfill-repo-"));
  try {
    const snapshotPath = join(repo, "snapshot.json");
    const terminalPath = join(repo, "terminal.json");
    writeFileSync(snapshotPath, JSON.stringify({
      repository: {
        nameWithOwner: "example-org/illuci",
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        mergeCommitAllowed: true,
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
        changedFiles: [{ path: "notes.txt", additions: 1, deletions: 0 }],
        statusCheckRollup: [],
      },
      branchProtection: { ok: true, requiredContexts: [] },
      branchRules: { ok: true, requiredContexts: [] },
      postMergeChecks: [],
    }), "utf8");
    writeFileSync(terminalPath, JSON.stringify([{ number: 65 }]), "utf8");

    const output = execFileSync(process.execPath, [
      cliPath,
      "pr",
      "outcome",
      "backfill",
      "--repo",
      "example-org/illuci",
      "--terminal",
      "--terminal-file",
      terminalPath,
      "--snapshot-file",
      snapshotPath,
      "--json",
      "--promote-corpus",
      "--dry-run",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: join(repo, ".illuci-data") },
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.total, 1);
    assert.equal(result.results[0].corpus.writes.observation.reason, "dry-run");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pr outcome audit compares terminal PRs to committed corpus and skips generated corpus PRs", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-pr-outcome-audit-repo-"));
  try {
    const corpusRoot = join(repo, "corpus");
    const terminalPath = join(repo, "terminal.json");
    mkdirSync(join(corpusRoot, "outcomes"), { recursive: true });
    writeFileSync(join(corpusRoot, "outcomes", "pr-00067.json"), "{}\n", "utf8");
    writeFileSync(terminalPath, JSON.stringify([
      { number: 67, state: "MERGED", title: "[A14] Add GitOps token readiness doctor", headRefName: "mallowfluff-a14-gitops-token-readiness" },
      { number: 69, state: "MERGED", title: "[A13] Add PR #66 outcome corpus", headRefName: "mallowfluff-a13-pr-outcome-corpus-pr-00066" },
    ]), "utf8");

    const output = execFileSync(process.execPath, [
      cliPath,
      "pr",
      "outcome",
      "audit",
      "--repo",
      "example-org/illuci",
      "--terminal-file",
      terminalPath,
      "--corpus-root",
      corpusRoot,
      "--json",
    ], {
      cwd: repo,
      encoding: "utf8",
    });
    const result = JSON.parse(output);
    assert.equal(result.schema, "illuci.gitops.pr-outcome-corpus-continuity/1");
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped.map((record) => record.prNumber), [69]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
