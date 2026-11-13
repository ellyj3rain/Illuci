import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendCognitiveClassificationTrace,
  buildCognitiveClassification,
  COGNITIVE_CLASSIFICATION_SCHEMA,
  renderCognitiveBlock,
} from "./cognitive-classifier.js";

const supportedControls = {
  reasoning: { supported: true, control: "think", tiers: ["low", "medium", "high"], default: "medium" },
  thinking: { supported: true, values: [true, false], control: "think" },
};

test("buildCognitiveClassification emits the cognitive schema and governed-verdict-compatible signals", () => {
  const record = buildCognitiveClassification({
    topologyId: "judiciary",
    phaseId: "opening",
    seatId: "prosecutor",
    modelId: "codex-local",
    task: "Assess the patch.",
  }, { timestamp: "2026-06-27T00:00:00.000Z" });

  assert.equal(record.schema, COGNITIVE_CLASSIFICATION_SCHEMA);
  assert.equal(record.verdict.schema, "illuci.governance.classifier-verdict/1");
  assert.equal(record.verdict.classifier, "illuci.governance.cognitive");
  assert.equal(record.dimensions.evidence.status, "unverified");
  assert.equal(record.dimensions.toolAffordancePosture.surfaceFamily, "unknown");
  assert.equal(record.dimensions.toolAffordancePosture.computerUsePosture, "not-needed");
  assert.ok(record.verdict.signals.some((signal) => signal.code === "evidence-unverified"));
});

test("model boundary distinguishes closed observable-boundary from internal-steerable posture", () => {
  const closed = buildCognitiveClassification({
    modelId: "codex-local",
    modelResource: { id: "model.codex.local", label: "Codex" },
    modelRuntime: { providerResourceId: "provider.openai.sdk", transport: "sdk" },
  });
  const internal = buildCognitiveClassification({
    modelId: "glm",
    modelResource: { id: "model.glm.frontier", label: "GLM Frontier" },
    modelRuntime: { providerResourceId: "provider.ollama.cloud", transport: "ollama" },
  });

  assert.equal(closed.dimensions.modelBoundary.kind, "observable-boundary");
  assert.equal(internal.dimensions.modelBoundary.kind, "internal-steerable");
  assert.equal(internal.dimensions.modelBoundary.trainableLater, true);
});

test("controls are advisory by default and only become apply-intent when explicitly enabled", () => {
  const advisory = buildCognitiveClassification({
    modelId: "glm",
    modelResource: { id: "model.glm.frontier", label: "GLM Frontier", controls: supportedControls },
    modelControls: supportedControls,
    controlsEnforcementEnabled: false,
  });
  const active = buildCognitiveClassification({
    modelId: "glm",
    modelResource: { id: "model.glm.frontier", label: "GLM Frontier", controls: supportedControls },
    modelControls: supportedControls,
    controlsEnforcementEnabled: true,
  });

  assert.equal(advisory.dimensions.controlAdvisory.enforcement, "advisory-only");
  assert.equal(advisory.dimensions.controlAdvisory.reasoning.apply, false);
  assert.equal(advisory.dimensions.controlAdvisory.thinking.apply, false);
  assert.equal(active.dimensions.controlAdvisory.enforcement, "opt-in-active");
  assert.equal(active.dimensions.controlAdvisory.reasoning.apply, true);
  assert.equal(active.dimensions.controlAdvisory.thinking.apply, true);
});

test("orchestrator posture records abundant dogfood compute as use-available-compute", () => {
  const record = buildCognitiveClassification({
    modelId: "claude-opus",
    computePosture: "abundant",
    selectionProvenance: {
      source: "role-auto-fill",
      selected: ["claude-opus"],
      roleHint: "arbiter",
      requiredMode: "respond",
      candidateCount: 4,
    },
    delegationRationale: "selected for governed synthesis breadth",
  });

  assert.equal(record.dimensions.orchestratorPosture.computePosture, "abundant");
  assert.equal(record.dimensions.orchestratorPosture.dogfoodPosture, "utilize-available-compute");
  assert.ok(record.dimensions.orchestratorPosture.motivationalVectors.includes("use-available-compute-when-dogfooding"));
  assert.equal(record.dimensions.orchestratorPosture.governancePosture, "proceed");
});

test("unknown compute posture stays portable instead of assuming abundance", () => {
  const record = buildCognitiveClassification({
    modelId: "claude-opus",
    selectionProvenance: {
      source: "explicit-lineup",
      selected: ["claude-opus"],
    },
  });

  assert.equal(record.dimensions.orchestratorPosture.computePosture, "unknown");
  assert.equal(record.dimensions.orchestratorPosture.dogfoodPosture, "portability-default");
  assert.equal(record.dimensions.orchestratorPosture.delegationPosture, "explicit");
});

test("convenience-selected delegation emits bias-risk and requires rationale without overriding", () => {
  const record = buildCognitiveClassification({
    modelId: "codex-local",
    computePosture: "abundant",
    selectionProvenance: {
      source: "harness-role-candidate",
      selected: ["codex-local"],
      roleHint: "reviewer",
      requiredMode: "respond",
      harnessModel: "codex-local",
      candidateCount: 3,
    },
  });

  assert.equal(record.dimensions.orchestratorPosture.delegationPosture, "convenience-selected");
  assert.equal(record.dimensions.orchestratorPosture.skepticismPosture, "bias-risk");
  assert.equal(record.dimensions.orchestratorPosture.governancePosture, "require-rationale");
  assert.ok(record.verdict.signals.some((signal) => signal.code === "delegation-bias-risk"));
  assert.equal(record.verdict.allowed, true);
});

test("open-weight or OSS models are not categorically penalized", () => {
  const record = buildCognitiveClassification({
    modelId: "gpt-oss",
    modelResource: { id: "model.gpt-oss.frontier", label: "GPT-OSS Frontier" },
    modelRuntime: { providerResourceId: "provider.google-antigravity", transport: "antigravity" },
    selectionProvenance: {
      source: "explicit-lineup",
      selected: ["gpt-oss"],
      roleHint: "analyst",
    },
  });

  assert.equal(record.dimensions.modelBoundary.kind, "internal-steerable");
  assert.equal(record.dimensions.orchestratorPosture.delegationPosture, "explicit");
  assert.equal(record.dimensions.orchestratorPosture.skepticismPosture, "weakly-examined");
  assert.equal(record.dimensions.orchestratorPosture.governancePosture, "proceed");
  assert.equal(record.verdict.signals.some((signal) => signal.code === "delegation-bias-risk"), false);
});

test("tool affordance posture prefers API when frontend evidence is not required", () => {
  const record = buildCognitiveClassification({
    task: "Inspect account usage in the frontend if needed.",
    evidenceStatus: "sufficient",
    apiEvidenceSufficient: true,
    toolChannels: ["http", "browser"],
    toolSurface: "browser-frontend",
  });

  const posture = record.dimensions.toolAffordancePosture;
  assert.equal(posture.surfaceFamily, "browser-frontend");
  assert.equal(posture.interfacePosture, "api-sufficient");
  assert.equal(posture.computerUsePosture, "not-needed");
  assert.equal(posture.governancePosture, "prefer-api");
  assert.equal(posture.integration.strategy, "api-first");
  assert.ok(record.verdict.signals.some((signal) => signal.code === "api-preferred-for-tool-evidence"));
});

test("browser payment or billing surfaces pause before frontend computer-use action", () => {
  const record = buildCognitiveClassification({
    task: "Verify the GitHub billing plan in a logged-in browser frontend.",
    toolChannels: ["browser"],
  });

  const posture = record.dimensions.toolAffordancePosture;
  assert.equal(posture.surfaceFamily, "browser-frontend");
  assert.equal(posture.interfacePosture, "frontend-required");
  assert.equal(posture.safetyPosture, "payment-risk");
  assert.equal(posture.computerUsePosture, "blocked");
  assert.equal(posture.governancePosture, "pause");
  assert.equal(record.verdict.allowed, false);
  assert.ok(record.verdict.signals.some((signal) => signal.code === "tool-affordance-pause"));
});

test("desktop professional tools require operator grant when credentials are involved", () => {
  const blocked = buildCognitiveClassification({
    task: "Use DataGrip with saved database credentials to inspect the schema.",
    toolChannels: ["filesystem"],
  });
  // [A38]/CAP-2: the input boolean is DEAD — a grant arrives ONLY through the
  // trusted resolver option (here a fake resolving computer-use=granted).
  const granted = buildCognitiveClassification(
    {
      task: "Use DataGrip with saved database credentials to inspect the schema.",
      toolChannels: ["filesystem"],
      seatId: "seat-test",
    },
    { capabilityResolver: () => ({ capabilities: { "computer-use": { state: "granted", via: ["grant-test"] } } }) },
  );
  // the OLD spoof path must be dead: the boolean alone changes nothing and is recorded as evidence.
  const spoofed = buildCognitiveClassification({
    task: "Use DataGrip with saved database credentials to inspect the schema.",
    toolChannels: ["filesystem"],
    computerUseGrant: true,
  });
  assert.equal(spoofed.dimensions.toolAffordancePosture.governancePosture, "require-operator-grant");
  assert.deepEqual(spoofed.dimensions.toolAffordancePosture.grants.spoofedClaims, ["computerUseGrant"]);

  assert.equal(blocked.dimensions.toolAffordancePosture.surfaceFamily, "database");
  assert.equal(blocked.dimensions.toolAffordancePosture.interfacePosture, "desktop-control-candidate");
  assert.equal(blocked.dimensions.toolAffordancePosture.safetyPosture, "credential-sensitive");
  assert.equal(blocked.dimensions.toolAffordancePosture.governancePosture, "require-operator-grant");
  assert.equal(blocked.verdict.allowed, false);
  assert.equal(granted.dimensions.toolAffordancePosture.governancePosture, "proceed");
  assert.equal(granted.dimensions.toolAffordancePosture.computerUsePosture, "desktop-gui");
});

test("desktop computer-use integrates through sandbox posture before control", () => {
  const record = buildCognitiveClassification({
    task: "Use computer use to click through the JetBrains Air desktop screen.",
    toolChannels: ["shell"],
  });

  const posture = record.dimensions.toolAffordancePosture;
  assert.equal(posture.surfaceFamily, "desktop-gui");
  assert.equal(posture.interfacePosture, "desktop-control-candidate");
  assert.equal(posture.computerUsePosture, "sandbox-required");
  assert.equal(posture.governancePosture, "require-sandbox");
  assert.equal(posture.integration.strategy, "desktop-gui-with-sandbox");
});

test("render and append cognitive classification traces as runtime JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cognitive-classifier-"));
  try {
    const path = join(dir, "records.jsonl");
    const record = buildCognitiveClassification({ modelId: "codex-local", seatId: "reviewer" });
    const block = renderCognitiveBlock(record);
    assert.ok(block.includes("[Cognitive Classifier]"));
    const trace = appendCognitiveClassificationTrace(record, { path });
    assert.equal(trace.ok, true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).schema, COGNITIVE_CLASSIFICATION_SCHEMA);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
