import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRuntimeDataPath, runtimeDataHome, runtimeDataPath } from "./paths.js";

test("runtime data paths are typed and rooted under ILLUCI_DATA_HOME", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "illuci-data-paths-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    assert.equal(runtimeDataHome(), root);
    assert.equal(runtimeDataPath("decisions", "decisions.jsonl"), join(root, "decisions", "decisions.jsonl"));
    assert.equal(
      runtimeDataPath("gitops", join("pr-classifications", "records.jsonl")),
      join(root, "gitops", "pr-classifications", "records.jsonl"),
    );
    assert.equal(
      runtimeDataPath("infrastructure", join("account-posture", "records.jsonl")),
      join(root, "infrastructure", "account-posture", "records.jsonl"),
    );
    const path = ensureRuntimeDataPath("governance", "floor-audit.jsonl");
    assert.equal(existsSync(join(root, "governance")), true);
    assert.equal(path, join(root, "governance", "floor-audit.jsonl"));
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown data kinds fail closed", () => {
  assert.throws(() => runtimeDataPath("misc", "x.jsonl"), /unknown illuci data kind/);
});
