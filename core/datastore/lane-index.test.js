/**
 * [A19] Universal lane indexer — folds operational + file-canonical lanes into the
 * trunk, idempotently and incrementally, and honors the authority boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, _resetBackendForTest } from "../storage/sqlite-driver.js";
import { openTrunk } from "./trunk.js";
import { recordObservation } from "../data/observations.js";
import { logDecision } from "../decisions/logger.js";
import { writeRecord, AuthorityViolation } from "./record-writer.js";
import { indexLanes } from "./lane-index.js";

function withTempHome(fn) {
  _resetBackendForTest();
  const dir = mkdtempSync(join(tmpdir(), "illuci-lane-idx-"));
  const prev = process.env.ILLUCI_DATA_HOME;
  process.env.ILLUCI_DATA_HOME = dir;
  try { return fn(dir); }
  finally { if (prev === undefined) delete process.env.ILLUCI_DATA_HOME; else process.env.ILLUCI_DATA_HOME = prev; }
}

test("indexLanes folds operational + file-canonical lanes; file-canonical marked read-only", () => {
  withTempHome((dir) => {
    recordObservation("telemetry", { type: "topology_start", runId: "r1", payload: { x: 1 } }, { fileName: "events.jsonl" });
    logDecision({ humanStatus: "operator-initiated", modelStatus: { model: "m" }, context: "test", type: "lineup", decision: "seated" });

    const trunk = openTrunk(openDatabase(join(dir, "trunk.db")));
    const res = indexLanes({ trunk });
    assert.ok(res.indexed >= 2, `indexed ${res.indexed}`);

    assert.ok(trunk.records({ kind: "telemetry" }).length >= 1, "telemetry projected");
    const decs = trunk.records({ kind: "decisions" });
    assert.ok(decs.length >= 1, "decisions projected");
    assert.equal(decs[0].source, "file-canonical");
    assert.equal(decs[0].metadata._authority, "file-canonical");
  });
});

test("authority boundary: file-canonical is PROJECTED read-only but never WRITABLE via record-writer", () => {
  withTempHome(() => {
    for (const kind of ["decisions", "governance", "memory"]) {
      assert.throws(() => writeRecord({ kind, type: "x" }), AuthorityViolation, `${kind} must be guard-rejected`);
    }
  });
});

test("indexLanes is idempotent + incremental (re-index adds nothing)", () => {
  withTempHome((dir) => {
    recordObservation("telemetry", { type: "a", runId: "r1" }, { fileName: "events.jsonl" });
    const trunk = openTrunk(openDatabase(join(dir, "trunk.db")));
    indexLanes({ trunk });
    const count1 = trunk.count();
    const second = indexLanes({ trunk });
    assert.equal(second.indexed, 0, "re-index indexes nothing (offset skip)");
    assert.equal(trunk.count(), count1, "count unchanged on re-index");
  });
});

test("includeFileCanonical:false omits the file-canonical lanes", () => {
  withTempHome((dir) => {
    logDecision({ humanStatus: "operator-initiated", modelStatus: { model: "m" }, context: "test", type: "t", decision: "d" });
    const trunk = openTrunk(openDatabase(join(dir, "trunk.db")));
    indexLanes({ trunk, includeFileCanonical: false });
    assert.equal(trunk.records({ kind: "decisions" }).length, 0, "decisions not projected when excluded");
  });
});
