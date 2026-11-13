import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("pipeline CLI lists compositions as the public pipeline surface", () => {
  const rows = JSON.parse(runIlluci(["pipeline", "list", "--json"]));
  const ids = rows.map((row) => row.id);

  assert.ok(ids.includes("standard"));
  assert.ok(ids.includes("governed-dev"));
  assert.ok(ids.includes("total-axes"));
});

test("pipeline CLI plans a named composition without dispatch", () => {
  const plan = JSON.parse(runIlluci(["pipeline", "plan", "standard", "--json"]));

  assert.equal(plan.id, "standard");
  assert.deepEqual(plan.stages.map((stage) => stage.topologyId), [
    "research-swarm",
    "dev-team",
    "adversarial-debate",
  ]);
});

test("pipeline CLI runs a named composition through the existing runner seam", () => {
  const pipeline = JSON.parse(runIlluci(
    ["pipeline", "run", "standard", "inspect this", "--architect", "model.codex.local", "--json"],
    { ILLUCI_PIPELINE_TEST_STUB: "1" },
  ));

  assert.equal(pipeline.status, "completed");
  assert.deepEqual(pipeline.stages.map((stage) => stage.topologyId), [
    "research-swarm",
    "dev-team",
    "adversarial-debate",
  ]);
  assert.deepEqual(pipeline.stages.map((stage) => stage.lineup), [
    { architect: "codex-local" },
    { architect: "codex-local" },
    { architect: "codex-local" },
  ]);
});

test("pipeline CLI keeps JSON output clean when runtime logs are emitted", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "pipeline",
    "run",
    "standard",
    "inspect this",
    "--architect",
    "model.codex.local",
    "--json",
  ], {
    cwd: repoRoot,
    env: { ...process.env, ILLUCI_PIPELINE_TEST_STUB: "1", ILLUCI_PIPELINE_TEST_LOG_NOISE: "1" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.trimStart().startsWith("{"));
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.match(result.stderr, /illuci pipeline test log noise/);
});

test("pipeline CLI exits non-zero when a run returns a failed trace", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "pipeline",
    "run",
    "standard",
    "inspect this",
    "--architect",
    "model.codex.local",
    "--json",
  ], {
    cwd: repoRoot,
    env: { ...process.env, ILLUCI_PIPELINE_TEST_STUB: "1", ILLUCI_PIPELINE_TEST_FAIL: "1" },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  const pipeline = JSON.parse(result.stdout);
  assert.equal(pipeline.status, "failed");
  assert.match(JSON.stringify(pipeline.stages), /stub pipeline failure/);
});

test("pipeline CLI rejects unknown composition names", () => {
  const result = spawnSync(process.execPath, [cliPath, "pipeline", "plan", "not-real"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown composition/);
});

test("pipeline CLI rejects malformed orchestration flags before dispatch", () => {
  const cases = [
    [["--agenda"], /--agenda requires a value/],
    [["--mutation-authority"], /--mutation-authority requires a value/],
    [["--tool-autonomy"], /--tool-autonomy requires a value/],
    [["--run-control"], /--run-control requires a value/],
    [["--run-control-file"], /--run-control-file requires a value/],
    [["--architect"], /--architect requires a value/],
    [["--architect-preset"], /--architect-preset requires a value/],
    [["--json", "false"], /--json does not take a value/],
  ];

  for (const [extra, pattern] of cases) {
    const result = spawnSync(process.execPath, [cliPath, "pipeline", "plan", "standard", ...extra], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1, `${extra.join(" ")} should reject before dispatch`);
    assert.match(result.stderr, pattern);
  }
});
