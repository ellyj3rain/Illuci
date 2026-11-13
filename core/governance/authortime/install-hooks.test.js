// node:test — the SAFE hook installer. We test ONLY the dry-run path: the pure plan
// builder, the dry-run output, and (critically) that a dry run against a real tmp git
// repo leaves git config UNCHANGED. The --arm mutation path is never exercised here — by
// contract this suite must not change any git config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, runInstaller } from "./install-hooks.mjs";

const HOOKS = "/abs/hooks";

test("buildPlan defaults to dry run (no --arm) and targets cwd", () => {
  const plan = buildPlan([], HOOKS);
  assert.equal(plan.arm, false);
  assert.equal(plan.hooksDir, HOOKS);
  assert.equal(plan.repo, process.cwd());
  assert.deepEqual(plan.configArgs, ["-C", process.cwd(), "config", "core.hooksPath", HOOKS]);
});

test("buildPlan sets arm only when --arm is present", () => {
  assert.equal(buildPlan(["--arm"], HOOKS).arm, true);
  assert.equal(buildPlan(["--repo", "/r"], HOOKS).arm, false);
});

test("buildPlan honors --repo <path>", () => {
  const plan = buildPlan(["--repo", "/some/repo"], HOOKS);
  assert.equal(plan.repo, "/some/repo");
  assert.deepEqual(plan.configArgs, ["-C", "/some/repo", "config", "core.hooksPath", HOOKS]);
});

test("buildPlan.wouldRun is a deterministic, human-readable command string", () => {
  const plan = buildPlan(["--repo", "/r"], HOOKS);
  assert.equal(plan.wouldRun, `git -C /r config core.hooksPath ${HOOKS}`);
});

test("runInstaller dry run prints the plan, changes nothing, returns armed:false", () => {
  let out = "";
  const r = runInstaller(buildPlan(["--repo", "/r"], HOOKS), (s) => { out += s; });
  assert.equal(r.ok, true);
  assert.equal(r.armed, false);
  assert.match(out, /DRY RUN/);
  assert.match(out, /git -C \/r config core\.hooksPath/);
  assert.match(out, /--arm/); // tells the operator how to actually apply
});

test("a dry run against a real tmp git repo leaves core.hooksPath UNCHANGED", () => {
  const dir = mkdtempSync(join(tmpdir(), "gzds-hooktest-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });

    // Baseline: a fresh repo has no core.hooksPath set.
    const before = readHooksPath(dir);
    assert.equal(before, null, "precondition: fresh repo has no core.hooksPath");

    // Run the installer in its DEFAULT (dry-run) mode. It must NOT touch git config.
    const r = runInstaller(buildPlan(["--repo", dir], "/would/be/hooks"), () => {});
    assert.equal(r.armed, false);

    const after = readHooksPath(dir);
    assert.equal(after, before, "dry run must not change git config");
    assert.equal(after, null, "core.hooksPath still unset after a dry run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Read core.hooksPath from a repo's local config, returning null if unset (git exits 1).
function readHooksPath(repo) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const REAL_HOOKS = join(dirname(fileURLToPath(import.meta.url)), "hooks");

test("armed hooks resolve governance CLIs from hook directory, not attached repo root", () => {
  const preCommit = readFileSync(join(REAL_HOOKS, "pre-commit"), "utf8");
  const commitMsg = readFileSync(join(REAL_HOOKS, "commit-msg"), "utf8");
  assert.ok(preCommit.includes('HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)'));
  assert.ok(preCommit.includes('node "$HOOK_DIR/../floor-check-cli.mjs" "$REPO_ROOT"'));
  assert.ok(!preCommit.includes('node "$REPO_ROOT/core/governance/authortime/floor-check-cli.mjs"'));
  assert.ok(commitMsg.includes('HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)'));
  assert.ok(commitMsg.includes('node "$HOOK_DIR/../commit-message-cli.mjs" "$MSG_FILE"'));
  assert.ok(!commitMsg.includes('node "$REPO_ROOT/core/governance/authortime/commit-message-cli.mjs"'));
});
