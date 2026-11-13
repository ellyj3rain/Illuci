import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args, env) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("decisions CLI can report and filter seed/runtime sources", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-cli-decisions-"));
  try {
    const decisionsDir = join(root, "decisions");
    mkdirSync(decisionsDir, { recursive: true });
    const record = {
      id: "D-cli-runtime-source",
      timestamp: "2026-06-24T02:30:00.000Z",
      humanStatus: "operator-initiated",
      modelStatus: [{ model: "test", seat: "source-auditor" }],
      context: "cli source test",
      type: "cli-runtime-source-test",
      decision: "read from runtime source",
      inputs: null,
      outputs: null,
      metadata: null,
    };
    writeFileSync(join(decisionsDir, "decisions.jsonl"), JSON.stringify(record) + "\n", "utf8");

    const env = { ILLUCI_DATA_HOME: root, ILLUCI_DECISIONS_FILE: "", ILLUCI_DECISIONS_DIR: "" };
    const runtime = JSON.parse(runIlluci(["decisions", "--source", "runtime", "--sources", "--json"], env));
    assert.equal(runtime.records.length, 1);
    assert.equal(runtime.records[0].id, record.id);
    assert.equal(runtime.records[0]._source.kind, "runtime");
    assert.ok(runtime.sources.some((source) => source.kind === "runtime" && source.count === 1));

    const seedOnly = JSON.parse(runIlluci(["decisions", "--source", "seed", "--type", "cli-runtime-source-test", "--json"], env));
    assert.deepEqual(seedOnly, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decisions CLI rejects unknown source labels", () => {
  const result = spawnSync(process.execPath, [cliPath, "decisions", "--source", "scratch"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid decision source/);
});
