/**
 * [A16.2] gap-closure tests. persistRun maps a trace → durable records; orchestrate()
 * persists company-level records through the REAL seam (proving the wiring). The
 * datastore is armed against a temp DB before importing the writers.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "illuci-ds-writers-"));
process.env.ILLUCI_DATASTORE_ENABLED = "1";
process.env.ILLUCI_DATASTORE_DB = join(dir, "trunk.db");

const { persistRun } = await import("./run-writer.js");
const { openDatastore, close } = await import("./index.js");
const { orchestrate } = await import("../orchestrate/orchestrate.js");

after(() => close());

test("persistRun captures run/phase/seat/completed with OTel tokens", () => {
  const trace = {
    runId: "run-T1", sessionId: "sess-1", topologyId: "direct", topologyName: "Direct",
    halted: false, totalLatency: 42,
    phases: {
      query: {
        latency: 10, gateStatus: null, totalTokens: 30,
        responses: [
          { seat: "model", model: "claude-opus", response: "hi", reasoning: "because",
            usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } },
        ],
      },
    },
  };
  persistRun(trace);
  const recs = openDatastore().trunk.byRun("run-T1");
  const types = recs.map((r) => r.type);
  assert.ok(types.includes("run.started"));
  assert.ok(types.includes("phase.completed"));
  assert.ok(types.includes("run.completed"));
  const seat = recs.find((r) => r.type === "seat.output");
  assert.equal(seat.modelId, "claude-opus");
  assert.equal(seat.payload.response, "hi");
  assert.equal(seat.inputTokens, 12);
  assert.equal(seat.outputTokens, 18);
  assert.equal(seat.spanKind, "LLM");
});

test("persistRun is idempotent (deterministic ids)", () => {
  const trace = { runId: "run-T1", topologyId: "direct", phases: {} };
  const before = openDatastore().trunk.byRun("run-T1").length;
  persistRun(trace);
  assert.equal(openDatastore().trunk.byRun("run-T1").length, before);
});

test("orchestrate() persists company.started + company.synthesis via the real seam", async () => {
  const stub = (topologyId) => ({
    runId: `run-${topologyId}`, sessionId: null, topologyId, topologyName: topologyId,
    halted: false, phases: { p: { latency: 1, totalTokens: 0, responses: [{ seat: "s", model: "m", response: "ok" }] } },
  });
  const result = await orchestrate(
    { topologies: [{ topologyId: "alpha" }, { topologyId: "beta" }], prompt: "ping" },
    { runTopology: async (topologyId) => stub(topologyId) },
  );
  const recs = openDatastore().trunk.byCompany(result.sessionId);
  const types = recs.map((r) => r.type);
  assert.ok(types.includes("company.started"), "company.started persisted");
  assert.ok(types.includes("company.synthesis"), "company.synthesis persisted");
  const synth = recs.find((r) => r.type === "company.synthesis");
  assert.equal(synth.payload.members.length, 2);
  assert.equal(synth.payload.counts.total, 2);
});
