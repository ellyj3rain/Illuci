/**
 * Trunk contract — mirrors OTL orchestrator-core store.test.ts: append-only,
 * monotonic seq, idempotent id, fold-by-lineage, envelope round-trip. Runs over a
 * real openDatabase handle in a mkdtemp dir (no mocks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, _resetBackendForTest } from "../storage/sqlite-driver.js";
import { openTrunk } from "./trunk.js";

function freshTrunk() {
  _resetBackendForTest();
  const dir = mkdtempSync(join(tmpdir(), "illuci-datastore-"));
  const driver = openDatabase(join(dir, "trunk.db"));
  driver.pragma("journal_mode = WAL");
  driver.pragma("busy_timeout = 5000");
  return openTrunk(driver);
}

test("records fold by run in append order, payload preserved", () => {
  const t = freshTrunk();
  t.append({ id: "r1", kind: "run", type: "run.started", runId: "run-A" });
  t.append({ id: "r2", kind: "run", type: "seat.output", runId: "run-A", seatId: "s0", payload: { text: "hi" } });
  t.append({ id: "r3", kind: "run", type: "seat.output", runId: "run-B" });
  const a = t.byRun("run-A");
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((r) => r.id), ["r1", "r2"]);
  assert.equal(a[1].payload.text, "hi");
});

test("seq is monotonic and the log only grows", () => {
  const t = freshTrunk();
  t.append({ id: "a", kind: "run", type: "x" });
  t.append({ id: "b", kind: "run", type: "x" });
  const all = t.records();
  assert.ok(all[1].seq > all[0].seq);
  assert.equal(t.count(), 2);
});

test("id is idempotent — re-append is a no-op, first write wins", () => {
  const t = freshTrunk();
  t.append({ id: "dup", kind: "run", type: "x", payload: { v: 1 } });
  t.append({ id: "dup", kind: "run", type: "x", payload: { v: 2 } });
  assert.equal(t.count(), 1);
  assert.equal(t.records()[0].payload.v, 1);
});

test("fold of an unknown run is empty", () => {
  const t = freshTrunk();
  assert.deepEqual(t.byRun("nope"), []);
});

test("envelope round-trips through the row mapping incl. OTel + JSON columns", () => {
  const t = freshTrunk();
  t.append({
    id: "otel", kind: "company", type: "company.synthesis", runId: "run-X", companyId: "co-1",
    spanKind: "AGENT", inputTokens: 10, outputTokens: 20, tags: ["a", "b"],
    payload: { text: "x" }, metadata: { m: 1 },
  });
  const [r] = t.byCompany("co-1");
  assert.equal(r.companyId, "co-1");
  assert.equal(r.spanKind, "AGENT");
  assert.equal(r.inputTokens, 10);
  assert.deepEqual(r.tags, ["a", "b"]);
  assert.equal(r.payload.text, "x");
  assert.equal(r.metadata.m, 1);
  assert.equal(r.schemaVersion, "illuci.datastore.record.v1");
});

test("appendMany is atomic and returns ids", () => {
  const t = freshTrunk();
  const ids = t.appendMany([
    { id: "m1", kind: "run", type: "x", runId: "R" },
    { id: "m2", kind: "run", type: "x", runId: "R" },
  ]);
  assert.deepEqual(ids, ["m1", "m2"]);
  assert.equal(t.byRun("R").length, 2);
});
