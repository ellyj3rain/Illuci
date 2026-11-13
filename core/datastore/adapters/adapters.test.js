/**
 * [A19] Lane adapters — pure toRecord mapping per envelope dialect (no fs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TELEMETRY_ADAPTER } from "./observations.js";
import { INFRASTRUCTURE_ADAPTER } from "./infrastructure.js";
import { DECISIONS_ADAPTER, GOVERNANCE_ADAPTER, MEMORY_ADAPTER } from "./decisions.js";
import { SESSIONS_ADAPTER, RUNS_ADAPTER } from "./sessions.js";
import { LANE_ADAPTERS } from "./index.js";

test("registry enumerates all 10 lanes honoring the adapter contract", () => {
  assert.equal(LANE_ADAPTERS.length, 10);
  for (const a of LANE_ADAPTERS) {
    assert.ok(a.lane && a.kind, `adapter missing lane/kind: ${JSON.stringify(a)}`);
    assert.ok(["operational", "file-canonical"].includes(a.authority), `bad authority: ${a.lane}`);
    assert.equal(typeof a.sources, "function");
    assert.equal(typeof a.toRecord, "function");
  }
});

test("telemetry passes illuci.observation.v1 through as a record superset", () => {
  const obs = { schemaVersion: "illuci.observation.v1", id: "obs-1", timestamp: "2026-01-01T00:00:00Z", kind: "telemetry", type: "topology_start", runId: "r1", payload: { x: 1 } };
  const rec = TELEMETRY_ADAPTER.toRecord(obs);
  assert.equal(rec.id, "obs-1");
  assert.equal(rec.kind, "telemetry");
  assert.equal(rec.runId, "r1");
  assert.equal(rec.ts, "2026-01-01T00:00:00Z");
});

test("infrastructure lifts nested-subject lineage + preserves the whole envelope", () => {
  const raw = { schema: "illuci.infrastructure.account-posture/1", id: "infra-1", timestamp: "2026-01-01T00:00:00Z", subject: { kind: "account-posture", runId: "r9" } };
  const rec = INFRASTRUCTURE_ADAPTER.toRecord(raw);
  assert.equal(rec.id, "infra-1");
  assert.equal(rec.kind, "infrastructure");
  assert.equal(rec.type, "account-posture");
  assert.equal(rec.runId, "r9");
  assert.deepEqual(rec.payload, raw);
});

test("decisions/governance/memory are stamped file-canonical (read-only projection)", () => {
  const dec = DECISIONS_ADAPTER.toRecord({ id: "D-1", timestamp: "2026-01-01T00:00:00Z", type: "lineup", decision: "seated" });
  assert.equal(dec.kind, "decisions");
  assert.equal(dec.source, "file-canonical");
  assert.equal(dec.metadata._authority, "file-canonical");
  assert.equal(dec.metadata._projection, "read-only");
  for (const A of [GOVERNANCE_ADAPTER, MEMORY_ADAPTER]) {
    const rec = A.toRecord({ id: "x", timestamp: "2026-01-01T00:00:00Z" });
    assert.equal(rec.source, "file-canonical");
    assert.equal(rec.metadata._authority, "file-canonical");
  }
});

test("runs synthesizes a deterministic id from the file path (idempotent, never time-based)", () => {
  const src = { path: "/runs/r1/01.raw.txt", runId: "r1", format: "text" };
  const a = RUNS_ADAPTER.toRecord("transcript text", src);
  const b = RUNS_ADAPTER.toRecord("different text", src);
  assert.equal(a.id, b.id, "runs id must be stable for a given file path");
  assert.ok(a.id.startsWith("run-"));
  assert.equal(a.kind, "runs");
  assert.equal(a.runId, "r1");
});

test("sessions maps sessionId -> id and startedAt -> ts", () => {
  const rec = SESSIONS_ADAPTER.toRecord({ sessionId: "s1", topologyId: "direct", startedAt: "2026-01-01T00:00:00Z" });
  assert.equal(rec.id, "s1");
  assert.equal(rec.sessionId, "s1");
  assert.equal(rec.ts, "2026-01-01T00:00:00Z");
});
