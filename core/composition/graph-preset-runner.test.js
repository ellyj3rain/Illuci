import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeGraphPreset } from "./graph-preset.js";
import { _resetGraphPresetStoreCache, createRuntimeGraphPreset } from "./graph-preset-store.js";
import { scaffoldRuntimeGraphPreset } from "./graph-preset-scaffold.js";
import { existsSync } from "node:fs";
import {
  _resetGraphPresetRecordStoreCache,
  listGraphPresetRecords,
  readGraphPresetTranscript,
} from "./graph-preset-record-store.js";
import { compileGraphPresetToNodeTree, planGraphPreset, runGraphPreset } from "./graph-preset-runner.js";

function tempFiles() {
  const root = mkdtempSync(join(tmpdir(), "illuci-graph-runner-"));
  return {
    root,
    storeFile: join(root, "graph-presets.json"),
    recordStoreFile: join(root, "graph-preset-records.json"),
  };
}

const nestedPreset = normalizeGraphPreset({
  id: "nested-runtime-graph",
  nodes: [
    { id: "orchestrator", type: "orchestrator", customization: { roleRefs: ["operator"] } },
    { id: "company.root", type: "company", spec: { concurrency: 2 } },
    { id: "pipeline.discovery", type: "pipeline", spec: {} },
    { id: "topology.research", type: "topology", ref: "research-swarm", spec: { lineup: { researcher: "default-research" } } },
    { id: "topology.devops", type: "topology", ref: "devops-pipeline" },
    { id: "company.review", type: "company", spec: {} },
    { id: "topology.critic", type: "topology", ref: "peer-review-ring" },
    { id: "seat.researcher", type: "seat", spec: { seatId: "researcher" } },
    { id: "model.primary", type: "model", ref: "model.default" },
    { id: "boundary.dispatch", type: "permission-boundary", ref: "dispatch-level" },
  ],
  edges: [
    { from: "orchestrator", to: "company.root", type: "delegates-to" },
    { from: "company.root", to: "pipeline.discovery", type: "contains", metadata: { sequence: 0 } },
    { from: "company.root", to: "company.review", type: "contains", metadata: { sequence: 1 } },
    { from: "pipeline.discovery", to: "topology.research", type: "contains", metadata: { sequence: 0 } },
    { from: "pipeline.discovery", to: "topology.devops", type: "contains", metadata: { sequence: 1 } },
    { from: "company.review", to: "topology.critic", type: "contains", metadata: { sequence: 0 } },
    { from: "seat.researcher", to: "model.primary", type: "assigns" },
    { from: "orchestrator", to: "boundary.dispatch", type: "constrains" },
  ],
  governance: { rootNodeId: "company.root" },
});

afterEach(() => {
  _resetGraphPresetStoreCache();
  _resetGraphPresetRecordStoreCache();
});

test("graph presets compile into recursive runNode topology/company/pipeline trees", () => {
  const compiled = compileGraphPresetToNodeTree(nestedPreset, {
    prompt: "Investigate this failure",
    lineup: { researcher: "operator-override", reviewer: "gpt-oss" },
  });

  assert.equal(compiled.rootKind, "company");
  assert.equal(compiled.compiledNode.kind, "company");
  assert.equal(compiled.compiledNode.prompt, "Investigate this failure");
  assert.equal(compiled.compiledNode.members[0].kind, "pipeline");
  assert.equal(compiled.compiledNode.members[0].stages[0].kind, "topology");
  assert.equal(compiled.compiledNode.members[0].stages[0].topologyId, "research-swarm");
  assert.equal(compiled.compiledNode.members[1].kind, "company");
  assert.equal(compiled.defaultLineup.researcher, "model.default");
  assert.equal(compiled.resolvedLineup.researcher, "operator-override");
  assert.equal(compiled.summary.nodeCount, 6);
  assert.equal(compiled.metaOrchestrator[0].layer, "meta-orchestrator");
  assert.deepEqual(compiled.permissionBoundaryRefs, ["dispatch-level"]);
});

test("graph preset plans and runs write additive runtime records", async () => {
  const { root, storeFile, recordStoreFile } = tempFiles();
  try {
    const preset = scaffoldRuntimeGraphPreset("runtime-pipeline", "pipeline", {
      stages: [
        { id: "research", topologyId: "research-swarm" },
        { id: "devops", topologyId: "devops-pipeline" },
      ],
    });
    const created = createRuntimeGraphPreset(preset, { storeFile, now: "2026-06-24T00:00:00.000Z" });
    assert.equal(created.created, true);

    const plan = planGraphPreset("runtime-pipeline", {
      storeFile,
      recordStoreFile,
      prompt: "Fix dependabot governance",
      lineup: { worker: "gpt-oss" },
    });
    assert.equal(plan.planned, true);
    assert.equal(plan.compiledNode.kind, "pipeline");
    assert.equal(plan.record.kind, "plan");

    const refused = await runGraphPreset("runtime-pipeline", {
      storeFile,
      recordStoreFile,
      prompt: "Fix dependabot governance",
      env: {},
    });
    assert.equal(refused.ran, false);
    assert.equal(refused.reason, "preset-run-disabled");

    const ran = await runGraphPreset("runtime-pipeline", {
      storeFile,
      recordStoreFile,
      prompt: "Fix dependabot governance",
      env: { ILLUCI_PRESET_RUN_ENABLED: "1" },
      lineup: { worker: "gpt-oss" },
    }, {
      runNode: async (node) => ({ ok: true, kind: node.kind, status: "complete", sessionId: "stub-session", node }),
    });
    assert.equal(ran.ran, true);
    assert.equal(ran.resultSummary.status, "complete");
    assert.equal(ran.record.kind, "run");

    const records = listGraphPresetRecords({ recordStoreFile });
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.kind), ["plan", "run", "run"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── [A116]/DR-203/F-143 — a completed run's full deliverable must be
// recoverable from disk. Before this, the record persisted only resultSummary;
// the heavy `result` trace (every phase response at full length) lived only in
// the returned envelope and died with the process. The per-run transcript file
// persists the full trace by default; `--record-trace false` (recordTrace:false)
// opts out.
test("runGraphPreset persists the full run trace recoverably; recordTrace:false opts out (F-143)", async () => {
  const { root, storeFile, recordStoreFile } = tempFiles();
  const transcriptDir = join(root, "transcripts");
  try {
    createRuntimeGraphPreset(
      { id: "runtime-pipeline", nodes: [{ id: "orchestrator", type: "orchestrator" }, { id: "topology.direct", type: "topology", ref: "direct" }], edges: [{ from: "orchestrator", to: "topology.direct", type: "delegates-to" }] },
      { storeFile },
    );

    // A deliverable far larger than the retired 500-char telemetry cap.
    const bigDeliverable = "RULING ".repeat(4000); // ~28000 chars
    const runNode = async (node) => ({
      ok: true,
      kind: node.kind,
      status: "complete",
      sessionId: "stub-session",
      trace: { phases: { ruling: { responses: [{ seat: "arbiter", model: "glm", response: bigDeliverable }] } } },
    });

    const ran = await runGraphPreset("runtime-pipeline", {
      storeFile, recordStoreFile, transcriptDir,
      prompt: "produce a long ruling", env: { ILLUCI_PRESET_RUN_ENABLED: "1" },
    }, { runNode });

    assert.equal(ran.ran, true);
    assert.ok(ran.record.tracePath, "record carries a transcript pointer by default");
    assert.ok(ran.record.traceBytes > bigDeliverable.length, "trace byte size reflects the full content");

    // The whole deliverable is recoverable from disk, untruncated.
    const recovered = readGraphPresetTranscript(ran.record.id, { transcriptDir });
    const recoveredText = recovered.result.trace.phases.ruling.responses[0].response;
    assert.equal(recoveredText, bigDeliverable);
    assert.equal(recoveredText.length, bigDeliverable.length);

    // Opt-out: recordTrace:false writes the compact record but no transcript.
    const optedOut = await runGraphPreset("runtime-pipeline", {
      storeFile, recordStoreFile, transcriptDir, recordTrace: false,
      prompt: "no trace please", env: { ILLUCI_PRESET_RUN_ENABLED: "1" },
    }, { runNode });
    assert.equal(optedOut.ran, true);
    assert.equal(optedOut.record.tracePath, undefined, "opt-out carries no transcript pointer");
    assert.equal(existsSync(join(transcriptDir, `${optedOut.record.id}.json`)), false);
  } finally {
    _resetGraphPresetStoreCache();
    _resetGraphPresetRecordStoreCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── [A106]/DR-199 — company memberDefaults fan + preamble; [A106]/F-137 — the
// identity-context thread runGraphPreset always dropped. All strictly opt-in:
// the synthetic presets above compile byte-identically (no memberDefaults key,
// no preamble key on their compiled nodes — compactObject drops undefined).

const defaultsPreset = normalizeGraphPreset({
  id: "member-defaults-graph",
  nodes: [
    { id: "orchestrator", type: "orchestrator" },
    {
      id: "company.root",
      type: "company",
      spec: {
        preamble: "Shared world doc.",
        memberDefaults: { params: { num_predict: 6000 }, timeoutMs: 111, runControl: { agenda: { strategy: "ritual" } } },
      },
    },
    { id: "topology.plain", type: "topology", ref: "research-swarm" },
    { id: "topology.opinionated", type: "topology", ref: "peer-review-ring", spec: { options: { timeoutMs: 999 } } },
    { id: "company.nested", type: "company", spec: { members: [{ topologyId: "devops-pipeline" }] } },
  ],
  edges: [
    { from: "orchestrator", to: "company.root", type: "delegates-to" },
    { from: "company.root", to: "topology.plain", type: "contains", metadata: { sequence: 0 } },
    { from: "company.root", to: "topology.opinionated", type: "contains", metadata: { sequence: 1 } },
    { from: "company.root", to: "company.nested", type: "contains", metadata: { sequence: 2 } },
  ],
  governance: { rootNodeId: "company.root" },
});

test("company memberDefaults fan into leaf members; a member's own options win; composites pass through", () => {
  const compiled = compileGraphPresetToNodeTree(defaultsPreset, { prompt: "task" });
  const node = compiled.compiledNode;
  assert.equal(node.preamble, "Shared world doc.");
  const [plain, opinionated, nested] = node.members;
  assert.equal(plain.options.params.num_predict, 6000);
  assert.equal(plain.options.timeoutMs, 111);
  assert.equal(plain.options.runControl.agenda.strategy, "ritual");
  assert.equal(opinionated.options.timeoutMs, 999, "member's own option wins per key");
  assert.equal(opinionated.options.params.num_predict, 6000, "non-overridden defaults still fan");
  assert.equal(nested.kind, "company");
  assert.equal(nested.options, undefined, "composite members are not fanned into");
  assert.equal(nested.preamble, undefined, "no preamble leaks into nested companies");
});

test("a company without memberDefaults/preamble compiles without those keys (byte-identity)", () => {
  const compiled = compileGraphPresetToNodeTree(nestedPreset, { prompt: "x" });
  assert.equal("preamble" in compiled.compiledNode, false);
  for (const member of compiled.compiledNode.members) {
    if (member.kind === "topology") assert.deepEqual(member.options, {});
  }
});

test("runGraphPreset threads options.genome/options.agents into the runNode ctx; absent stays absent (F-137)", async () => {
  const { root, storeFile, recordStoreFile } = tempFiles();
  try {
    const scaffolded = scaffoldRuntimeGraphPreset("ctx-thread-pipeline", "pipeline", { stages: [{ topologyId: "research-swarm" }] });
    createRuntimeGraphPreset(scaffolded, { storeFile });

    const seenCtx = [];
    const capture = async (node, ctx = {}) => { seenCtx.push(ctx); return { ok: true, status: "complete", sessionId: "s" }; };

    const genome = { projectDir: "/tmp/x", precedence: "seed", childIdentity: "inherit" };
    const agents = { agents: { a: { model: "gpt-oss" } }, seats: {} };
    await runGraphPreset("ctx-thread-pipeline", {
      storeFile, recordStoreFile, prompt: "p", env: { ILLUCI_PRESET_RUN_ENABLED: "1" }, record: false,
    }, { runNode: capture });
    await runGraphPreset("ctx-thread-pipeline", {
      storeFile, recordStoreFile, prompt: "p", env: { ILLUCI_PRESET_RUN_ENABLED: "1" }, record: false, genome, agents,
    }, { runNode: capture });

    assert.equal("genome" in seenCtx[0], false, "unarmed run carries no genome key");
    assert.equal("agents" in seenCtx[0], false, "unarmed run carries no agents key");
    assert.deepEqual(seenCtx[1].genome, genome);
    assert.deepEqual(seenCtx[1].agents, agents);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F-138: a preset run passes NO mandate unless the caller built one (the prompt-string default crashed every real run)", async () => {
  const { root, storeFile, recordStoreFile } = tempFiles();
  try {
    const scaffolded = scaffoldRuntimeGraphPreset("mandate-convention", "company", { members: [{ topologyId: "research-swarm" }] });
    createRuntimeGraphPreset(scaffolded, { storeFile });

    const seen = [];
    const captureTopology = async (topologyId, lineup, prompt, options, parentSessionId) => {
      seen.push({ topologyId, prompt, mandate: options.mandate, parentSessionId });
      return { topologyId, runId: "r1", sessionId: parentSessionId, halted: false, phases: {} };
    };

    // deps.runTopology exercises the REAL runNode company path (the layer the
    // stub-injected tests skipped — where the string mandate used to crash).
    const ran = await runGraphPreset("mandate-convention", {
      storeFile, recordStoreFile, prompt: "the operator ask", env: { ILLUCI_PRESET_RUN_ENABLED: "1" }, record: false,
    }, { runTopology: captureTopology });

    assert.equal(ran.ran, true, JSON.stringify(ran.resultSummary));
    assert.equal(ran.resultSummary.status, "complete");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, "the operator ask", "the ask flows as the member prompt");
    assert.equal(seen[0].mandate, undefined, "no caller mandate -> none forwarded; the runner builds from prompt (flat-run convention)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
