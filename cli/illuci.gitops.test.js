import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));

function readySnapshot() {
  return {
    repository: { nameWithOwner: "example-org/illuci" },
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
  };
}

test("gitops doctor emits JSON and appends a token-readiness trace from a snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-gitops-repo-"));
  const data = mkdtempSync(join(tmpdir(), "illuci-cli-gitops-data-"));
  try {
    const snapshotPath = join(repo, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(readySnapshot()), "utf8");
    const output = execFileSync(process.execPath, [
      cliPath,
      "gitops",
      "doctor",
      "--repo",
      "example-org/illuci",
      "--snapshot-file",
      snapshotPath,
      "--json",
      "--write-trace",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: data },
      encoding: "utf8",
    });
    const record = JSON.parse(output);
    assert.equal(record.schema, "illuci.gitops.token-readiness/1");
    assert.equal(record.action.outcome, "ready");
    assert.equal(record.trace.displayPath, ".illuci/data/gitops/token-readiness/records.jsonl");
    assert.equal(existsSync(record.trace.path), true);
    assert.equal(JSON.parse(readFileSync(record.trace.path, "utf8").trim()).id, record.id);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("gitops doctor exits nonzero when readiness is blocked", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-gitops-blocked-"));
  try {
    const snapshotPath = join(repo, "blocked.json");
    writeFileSync(snapshotPath, JSON.stringify({
      ...readySnapshot(),
      tokenSources: {
        policy: { name: "ILLUCI_GITOPS_TOKEN", present: false, authority: "required-check policy read" },
        corpus: { name: "ILLUCI_GITOPS_CORPUS_TOKEN", present: false, authority: "corpus promotion readiness" },
        mutation: { name: "GITHUB_TOKEN|GH_TOKEN", present: false, authority: "PR auto-merge mutation" },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      cliPath,
      "gitops",
      "doctor",
      "--repo",
      "example-org/illuci",
      "--snapshot-file",
      snapshotPath,
      "--json",
    ], {
      cwd: repo,
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    const record = JSON.parse(result.stdout);
    assert.equal(record.action.outcome, "blocked");
    assert.ok(record.action.blockedBy.includes("policy-token-missing"));
    assert.ok(record.action.blockedBy.includes("corpus-token-missing"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
