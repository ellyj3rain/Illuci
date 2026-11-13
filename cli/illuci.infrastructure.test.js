import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));

function infrastructureSnapshot() {
  return {
    github: {
      platform: "github",
      account: { kind: "user", login: "operator" },
      auth: { tokenPresent: true, tokenNames: ["GITHUB_TOKEN"] },
      apiEvidence: [
        { id: "identity", ok: true, evidence: { login: "operator" } },
        { id: "actions-billing", ok: true, evidence: { included_minutes: 3000, total_minutes_used: 12 } },
      ],
    },
    gitlab: {
      platform: "gitlab",
      account: { kind: "admin-or-user", login: "operator" },
      auth: { tokenPresent: true, tokenNames: ["GITLAB_TOKEN"] },
      apiEvidence: [
        { id: "identity", ok: true, evidence: { username: "operator" } },
        { id: "runners", ok: true, evidence: { total: 1, active: 1 } },
      ],
    },
    vercel: {
      platform: "vercel",
      auth: { tokenPresent: true, tokenNames: ["VERCEL_TOKEN"] },
      apiEvidence: [{ id: "identity", ok: true, evidence: { username: "operator" } }],
    },
  };
}

test("infrastructure doctor emits JSON and appends account-posture traces from a snapshot", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-infra-repo-"));
  const data = mkdtempSync(join(tmpdir(), "illuci-cli-infra-data-"));
  try {
    const snapshotPath = join(repo, "infrastructure.json");
    writeFileSync(snapshotPath, JSON.stringify(infrastructureSnapshot()), "utf8");
    const output = execFileSync(process.execPath, [
      cliPath,
      "infrastructure",
      "doctor",
      "--platform",
      "github,gitlab,vercel",
      "--snapshot-file",
      snapshotPath,
      "--json",
      "--write-trace",
    ], {
      cwd: repo,
      env: { ...process.env, ILLUCI_DATA_HOME: data },
      encoding: "utf8",
    });
    const recordSet = JSON.parse(output);
    assert.equal(recordSet.schema, "illuci.infrastructure.account-posture-set/1");
    assert.deepEqual(recordSet.platforms, ["github", "gitlab", "vercel"]);
    assert.equal(recordSet.ok, true);
    assert.equal(recordSet.recordsByPlatform, undefined);
    assert.equal(recordSet.records.find((record) => record.subject.platform === "gitlab").dimensions.action, "use-self-managed-runner");
    assert.equal(recordSet.trace.displayPath, ".illuci/data/infrastructure/account-posture/records.jsonl");
    assert.equal(existsSync(recordSet.trace.path), true);
    const lines = readFileSync(recordSet.trace.path, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.subject.platform), ["github", "gitlab", "vercel"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test("infrastructure doctor exits nonzero when requested provider account posture is blocked", () => {
  const repo = mkdtempSync(join(tmpdir(), "illuci-cli-infra-blocked-"));
  try {
    const snapshotPath = join(repo, "blocked.json");
    writeFileSync(snapshotPath, JSON.stringify({
      vercel: {
        platform: "vercel",
        auth: { tokenPresent: false },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      cliPath,
      "infrastructure",
      "doctor",
      "--platform",
      "vercel",
      "--snapshot-file",
      snapshotPath,
      "--json",
    ], {
      cwd: repo,
      env: { ...process.env },
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    const recordSet = JSON.parse(result.stdout);
    assert.equal(recordSet.records[0].action.outcome, "blocked");
    assert.ok(recordSet.records[0].action.blockedBy.includes("account-token-missing"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
