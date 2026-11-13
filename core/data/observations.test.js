import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationPath, readObservations, recordObservation } from "./observations.js";

test("observations write normalized JSONL records into the typed data plane", () => {
  const prior = process.env.ILLUCI_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "illuci-observations-"));
  try {
    process.env.ILLUCI_DATA_HOME = root;
    const record = recordObservation("telemetry", {
      type: "model_response",
      runId: "run-1",
      sessionId: "session-1",
      topologyId: "research-swarm",
      phaseId: "p1",
      seatId: "analyst",
      modelId: "gpt-oss",
      payload: { latency: 12 },
      tags: ["latency"],
    });

    assert.equal(record.schemaVersion, "illuci.observation.v1");
    assert.equal(record.kind, "telemetry");
    assert.equal(existsSync(observationPath("telemetry")), true);

    const rows = readObservations("telemetry", { type: "model_response", runId: "run-1" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.latency, 12);
    assert.equal(rows[0].tags[0], "latency");
  } finally {
    if (prior == null) delete process.env.ILLUCI_DATA_HOME;
    else process.env.ILLUCI_DATA_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("observations fail closed on unknown data kinds", () => {
  assert.throws(() => recordObservation("loose", { type: "x" }), /unknown illuci data kind/);
});
