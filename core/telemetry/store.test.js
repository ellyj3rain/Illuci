import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEvents, recordEvent, telemetryDbPath } from "./store.js";

function withTelemetryEnv(fn) {
  const priorHome = process.env.ILLUCI_DATA_HOME;
  const priorSqlite = process.env.ILLUCI_TELEMETRY_SQLITE;
  const root = mkdtempSync(join(tmpdir(), "illuci-telemetry-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    process.env.ILLUCI_TELEMETRY_SQLITE = "0";
    fn(root);
  } finally {
    if (priorHome == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = priorHome;
    if (priorSqlite == null) delete process.env.ILLUCI_TELEMETRY_SQLITE;
    else process.env.ILLUCI_TELEMETRY_SQLITE = priorSqlite;
    rmSync(root, { recursive: true, force: true });
  }
}

test("telemetry records queryable JSONL observations when SQLite is disabled", () => {
  withTelemetryEnv((root) => {
    recordEvent({
      run_id: "run-jsonl",
      session_id: "session-jsonl",
      event_type: "model_response",
      topology_id: "research-swarm",
      phase_id: "p1",
      seat_id: "analyst",
      model_id: "gpt-oss",
      payload: { latency: 22, total_tokens: 33 },
    });

    assert.equal(existsSync(join(root, "telemetry", "events.jsonl")), true);
    const rows = getEvents({ event_type: "model_response", run_id: "run-jsonl" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "session-jsonl");
    assert.equal(rows[0].payload.total_tokens, 33);
  });
});

test("telemetry database path resolves into the typed data plane by default", () => {
  withTelemetryEnv((root) => {
    assert.equal(telemetryDbPath(), join(root, "telemetry", "context.db"));
  });
});
