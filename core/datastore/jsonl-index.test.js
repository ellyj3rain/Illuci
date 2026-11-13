/**
 * [A16.7] JSONL observation-lane indexing — folds per-kind observations.jsonl into the
 * trunk as records, 1:1 and idempotently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, _resetBackendForTest } from "../storage/sqlite-driver.js";
import { openTrunk } from "./trunk.js";
import { recordObservation } from "../data/observations.js";
import { indexObservationLanes } from "./jsonl-index.js";

test("indexObservationLanes folds observation lanes into the trunk, idempotently", () => {
  _resetBackendForTest();
  const dir = mkdtempSync(join(tmpdir(), "illuci-jsonl-idx-"));
  const prevHome = process.env.ILLUCI_DATA_HOME;
  process.env.ILLUCI_DATA_HOME = dir; // observations + the trunk both resolve under here
  try {
    recordObservation("governance", { type: "gate.pass", runId: "r1", payload: { gate: "floor" } });
    recordObservation("gitops", { type: "pr.merged", runId: "r2", payload: { pr: 42 } });

    const trunk = openTrunk(openDatabase(join(dir, "trunk.db")));

    const first = indexObservationLanes({ trunk });
    assert.equal(first.indexed, 2);
    assert.equal(trunk.count(), 2);
    assert.equal(trunk.byRun("r1").length, 1);
    assert.equal(trunk.records({ kind: "gitops", type: "pr.merged" }).length, 1);

    // re-index is a no-op on row count (INSERT OR IGNORE on the preserved observation id)
    indexObservationLanes({ trunk });
    assert.equal(trunk.count(), 2);
  } finally {
    if (prevHome === undefined) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prevHome;
  }
});
