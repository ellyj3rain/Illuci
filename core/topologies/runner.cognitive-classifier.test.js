import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMandate } from "./mandate.js";
import { buildCognitiveSeatFrame } from "./runner.js";

function withRuntimeDataHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cognitive-runner-"));
  const priorHome = process.env.ILLUCI_DATA_HOME;
  const priorPreflight = process.env.ILLUCI_COGNITIVE_PREFLIGHT;
  const priorControls = process.env.ILLUCI_COGNITIVE_CONTROLS_ENABLED;
  process.env.ILLUCI_DATA_HOME = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (priorHome === undefined) delete process.env.ILLUCI_DATA_HOME;
      else process.env.ILLUCI_DATA_HOME = priorHome;
      if (priorPreflight === undefined) delete process.env.ILLUCI_COGNITIVE_PREFLIGHT;
      else process.env.ILLUCI_COGNITIVE_PREFLIGHT = priorPreflight;
      if (priorControls === undefined) delete process.env.ILLUCI_COGNITIVE_CONTROLS_ENABLED;
      else process.env.ILLUCI_COGNITIVE_CONTROLS_ENABLED = priorControls;
      rmSync(dir, { recursive: true, force: true });
    });
}

const seatDef = { id: "reviewer", label: "Reviewer", roleHint: "review", relationships: [] };

function dispatchOpts(extra = {}) {
  return {
    mandate: buildMandate({ prompt: "Review the implementation.", operator: "Example" }),
    seatLabels: new Map([["reviewer", "Reviewer"]]),
    topology: "Test Topology",
    topologyId: "test-topology",
    sessionId: "session-1",
    runId: "run-1",
    ...extra,
  };
}

test("buildCognitiveSeatFrame injects the cognitive block and appends runtime JSONL by default", async () => {
  await withRuntimeDataHome(async (dir) => {
    const framed = await buildCognitiveSeatFrame({
      modelId: "codex-local",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts(),
      dispositionBlock: "[Behavioral Disposition]\nCareful review posture.",
      task: "Assess the diff.",
      phase: { id: "opening", mode: "respond" },
    });

    const iMandate = framed.msg.indexOf("[Mandate]");
    const iLens = framed.msg.indexOf("[Seat lens]");
    const iCog = framed.msg.indexOf("[Cognitive Classifier]");
    const iDisp = framed.msg.indexOf("[Behavioral Disposition]");
    assert.equal(iMandate, 0);
    assert.ok(iMandate < iLens && iLens < iCog && iCog < iDisp);
    assert.equal(framed.cognitiveRecord.schema, "illuci.governance.cognitive-classification/1");

    const path = join(dir, "governance", "cognitive-classifications", "records.jsonl");
    assert.equal(existsSync(path), true);
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(record.subject.seatId, "reviewer");
  });
});

test("ILLUCI_COGNITIVE_PREFLIGHT=false disables injection and trace append", async () => {
  await withRuntimeDataHome(async (dir) => {
    process.env.ILLUCI_COGNITIVE_PREFLIGHT = "false";
    const framed = await buildCognitiveSeatFrame({
      modelId: "codex-local",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts(),
      task: "Assess the diff.",
      phase: { id: "opening", mode: "respond" },
    });

    assert.equal(framed.cognitiveRecord, null);
    assert.equal(framed.msg.includes("[Cognitive Classifier]"), false);
    assert.equal(existsSync(join(dir, "governance", "cognitive-classifications", "records.jsonl")), false);
  });
});

test("cognitive preflight receives selection provenance and compute posture", async () => {
  await withRuntimeDataHome(async (dir) => {
    const framed = await buildCognitiveSeatFrame({
      modelId: "codex-local",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts({
        computePosture: "abundant",
        modelDelegation: [{
          seatId: "reviewer",
          source: "harness-role-candidate",
          selected: ["codex-local"],
          roleHint: "reviewer",
          requiredMode: "respond",
          harnessModel: "codex-local",
          candidateCount: 2,
        }],
      }),
      task: "Assess the diff.",
      phase: { id: "opening", mode: "respond" },
    });

    assert.equal(framed.cognitiveRecord.dimensions.orchestratorPosture.computePosture, "abundant");
    assert.equal(framed.cognitiveRecord.dimensions.orchestratorPosture.delegationPosture, "convenience-selected");
    assert.equal(framed.cognitiveRecord.dimensions.orchestratorPosture.governancePosture, "require-rationale");
    assert.ok(framed.msg.includes("Orchestrator: compute=abundant; delegation=convenience-selected; skepticism=bias-risk; governance=require-rationale."));

    const path = join(dir, "governance", "cognitive-classifications", "records.jsonl");
    const record = JSON.parse(readFileSync(path, "utf8").trim());
    assert.equal(record.inputs.computePosture, "abundant");
    assert.equal(record.inputs.selectionSource, "harness-role-candidate");
  });
});

test("cognitive preflight receives tool channel and frontend affordance evidence", async () => {
  await withRuntimeDataHome(async () => {
    const framed = await buildCognitiveSeatFrame({
      modelId: "codex-local",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts({
        toolChannels: ["http", "browser"],
        toolSurface: "browser-frontend",
        surfaceHints: ["frontend account verification"],
        apiEvidenceSufficient: true,
      }),
      task: "Inspect account usage in the frontend if needed.",
      phase: { id: "opening", mode: "respond" },
    });

    const posture = framed.cognitiveRecord.dimensions.toolAffordancePosture;
    assert.equal(posture.surfaceFamily, "browser-frontend");
    assert.equal(posture.governancePosture, "prefer-api");
    assert.equal(posture.integration.strategy, "api-first");
    assert.ok(framed.msg.includes("Tool surface: browser-frontend; interface=api-sufficient"));
    assert.ok(framed.msg.includes("Tool integration: api-first"));
  });
});

test("cognitive preflight receives skill-grant sandbox and MCP evidence for desktop computer use", async () => {
  await withRuntimeDataHome(async () => {
    const framed = await buildCognitiveSeatFrame({
      modelId: "codex-local",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts({
        seatGrants: {
          reviewer: {
            skillIds: ["computer-use.desktop-control"],
            mcpBridges: new Set(["jetbrains"]),
            autonomy: { sandboxRequired: true, requiresIntrospector: false },
          },
        },
      }),
      task: "Use computer use to inspect the JetBrains Air desktop screen.",
      phase: { id: "opening", mode: "respond" },
    });

    const posture = framed.cognitiveRecord.dimensions.toolAffordancePosture;
    assert.equal(posture.surfaceFamily, "desktop-gui");
    assert.equal(posture.computerUsePosture, "sandbox-required");
    assert.equal(posture.grants.sandboxRequired, true);
    assert.ok(posture.toolChannels.includes("mcp"));
    assert.equal(posture.integration.strategy, "desktop-gui-with-sandbox");
  });
});

test("--cognitive-controls style opt-in applies only supported cognitive control recommendations", async () => {
  await withRuntimeDataHome(async () => {
    const framed = await buildCognitiveSeatFrame({
      modelId: "glm",
      seatId: "reviewer",
      seatDef,
      dispatchOpts: dispatchOpts({ cognitiveControlsEnabled: true }),
      task: "Assess the diff.",
      phase: { id: "opening", mode: "respond" },
    });

    assert.equal(framed.cognitiveRecord.dimensions.controlAdvisory.enforcement, "opt-in-active");
    assert.equal(framed.cognitiveRecord.dimensions.controlAdvisory.thinking.supported, true);
    assert.equal(framed.dispatchOptions.thinking, true);
  });
});
