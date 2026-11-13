import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const CLI = "core/governance/authortime/commit-message-cli.mjs";

test("commit-message gate accepts batch-prefixed subjects", () => {
  const out = execFileSync("node", [CLI, "--message", "[A2] compose specialist roles"], { encoding: "utf8" });
  assert.match(out, /OK/);
});

test("commit-message gate reads the positional commit-message file used by git hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-commit-message-"));
  const file = join(dir, "COMMIT_EDITMSG");
  try {
    writeFileSync(file, "[A2] compose specialist roles\n", "utf8");
    const out = execFileSync("node", [CLI, file], { encoding: "utf8" });
    assert.match(out, /OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commit-message gate rejects subjects without a batch prefix", () => {
  const result = spawnSync("node", [CLI, "--message", "compose specialist roles"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /batch prefix/);
});

test("commit-message gate accepts GitHub merge commits only when explicitly allowed and body has a batch title", () => {
  const message = "Merge pull request #21 from example-org/mallowfluff-a4-4\n\n[A4.4] Graph-preset dogfood bridge";
  const out = execFileSync("node", [CLI, "--allow-github-merge-body", "--message", message], { encoding: "utf8" });
  assert.match(out, /OK/);
  assert.match(out, /merge body/);
});

test("commit-message gate blocks GitHub merge commits without the explicit merge-body flag", () => {
  const message = "Merge pull request #21 from example-org/mallowfluff-a4-4\n\n[A4.4] Graph-preset dogfood bridge";
  const result = spawnSync("node", [CLI, "--message", message], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED/);
});

test("commit-message gate blocks GitHub merge commits when the body lacks a batch title", () => {
  const message = "Merge pull request #21 from example-org/mallowfluff-a4-4\n\nGraph-preset dogfood bridge";
  const result = spawnSync("node", [CLI, "--allow-github-merge-body", "--message", message], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub merge commit subject requires/);
});

test("[A15.5.10] commit-message gate accepts a GitLab merge commit by extracting the batch from the branch name", () => {
  // The dual-forge FF onto GitHub main lands this exact subject shape.
  const message = "Merge branch 'batch/a15.5.10-gitlab-merge-prefix' into 'main'";
  const out = execFileSync("node", [CLI, "--allow-github-merge-body", "--message", message], { encoding: "utf8" });
  assert.match(out, /OK/);
  assert.match(out, /A15\.5\.10/);
});

test("[A15.5.10] GitLab merge extraction handles a plain [A#] batch branch", () => {
  const out = execFileSync(
    "node",
    [CLI, "--allow-github-merge-body", "--message", "Merge branch 'batch/a24.5-warehouse-belt' into 'main'"],
    { encoding: "utf8" },
  );
  assert.match(out, /OK/);
  assert.match(out, /A24\.5/);
});

test("[A15.5.10] a GitLab merge of a non-batch branch is still blocked", () => {
  const result = spawnSync(
    "node",
    [CLI, "--allow-github-merge-body", "--message", "Merge branch 'some-random-branch' into 'main'"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitLab merge commit must name a batch/);
});

test("[A15.5.10] a GitLab merge commit without the merge-body flag is still blocked (parity with GitHub)", () => {
  const result = spawnSync("node", [CLI, "--message", "Merge branch 'batch/a15.5.10-x' into 'main'"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED/);
});
