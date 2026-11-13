import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeRoutePreflightFailure, describeUnavailableModel, modelDoctorReport, modelDoctorReportLive } from "./model-doctor.js";

function withFakeAgy(fn) {
  const prior = process.env.AGY_PATH;
  const dir = mkdtempSync(join(tmpdir(), "illuci-doctor-agy-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");
  process.env.AGY_PATH = fakeAgy;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("doctor keeps claude-local explicit and unavailable for auto-selection", () => {
  const report = modelDoctorReport("claude-local");

  assert.equal(report.canonicalId, "claude-fable");
  assert.equal(report.availableForAutoSelection, false);
  assert.equal(report.liveness.status, "suspended");
  assert.match(report.suggestedFix, /claude-opus/);
  assert.equal(describeUnavailableModel("claude-local").code, "MODEL_UNAVAILABLE");
});

test("doctor routes bare Claude to Opus through Antigravity when configured", () => withFakeAgy(() => {
  const report = modelDoctorReport("claude");

  assert.equal(report.canonicalId, "claude-opus");
  assert.equal(report.providerId, "provider.google.antigravity");
  assert.equal(report.providerKey, "google-antigravity");
  assert.equal(report.transport, "antigravity");
  assert.equal(report.auth.present, true);
  assert.equal(report.availableForAutoSelection, true);
}));

test("doctor makes GPT-OSS default provider and alternate channel explicit", () => withFakeAgy(() => {
  const report = modelDoctorReport("gpt-oss");

  assert.equal(report.canonicalId, "gpt-oss");
  assert.equal(report.providerId, "provider.google.antigravity");
  assert.equal(report.transport, "antigravity");
  assert.equal(report.availableForAutoSelection, true);
  assert.ok(report.channels.some((channel) => channel.providerId === "provider.ollama.cloud"));
}));

test("doctor distinguishes general Qwen from Qwen Code", () => {
  const general = modelDoctorReport("qwen3.5");
  const code = modelDoctorReport("qwen-code");

  assert.equal(general.canonicalId, "qwen3.5");
  assert.equal(code.canonicalId, "qwen-code");
  assert.equal(general.roleCoverage.status, "role-routable");
  assert.ok(general.roleCoverage.roles.some((role) => role.role === "analyst"));
  assert.match(code.suggestedFix, /qwen3\.5/);
});

test("doctor distinguishes Gemini Antigravity from suspended Gemini API ids", () => withFakeAgy(() => {
  const live = modelDoctorReport("gemini");
  const api = modelDoctorReport("gemini-3.1-pro");

  assert.equal(live.canonicalId, "gemini");
  assert.equal(live.providerId, "provider.google.antigravity");
  assert.equal(live.availableForAutoSelection, true);
  assert.equal(api.canonicalId, "gemini-3.1-pro");
  assert.equal(api.availableForAutoSelection, false);
  assert.match(api.suggestedFix, /live Gemini routes/);
}));

test("doctor reports temporary API-route holds before auth fixes", () => {
  // [A19.5] hermes4 retired with the Nous lane — the hold list is grok + claude-api.
  for (const id of ["grok", "claude-api"]) {
    const report = modelDoctorReport(id);

    assert.equal(report.availableForAutoSelection, false, id);
    assert.equal(report.liveness.status, "suspended", id);
    assert.match(report.suggestedFix, /productization hold|temporary/i, id);
    assert.equal(describeUnavailableModel(id).code, "MODEL_UNAVAILABLE");
  }
});

test("doctor resolves grok-cli as a compatibility spelling for Grok Build", () => {
  const report = modelDoctorReport("grok-cli");

  assert.equal(report.canonicalId, "grok-build");
  assert.equal(report.providerId, "provider.xai.cli");
  assert.equal(report.transport, "grok-build");
  assert.ok(report.aliases.includes("grok-cli"));
});


test("model doctor exposes graph-ready label facets", () => withFakeAgy(() => {
  const report = modelDoctorReport("claude");

  assert.equal(report.displayName, "Claude Opus");
  assert.equal(report.modelLabel.publicModelId, "model.claude.opus");
  assert.equal(report.graph.node.id, "model.claude.opus");
  assert.ok(report.graph.edges.some((edge) => edge.relation === "provided-by" && edge.to === "provider.google.antigravity"));
}));

test("live doctor marks unreachable Ollama routes unavailable", async () => {
  const probe = async (options) => ({
    status: "unreachable",
    staticAvailable: false,
    probe: "ollama-tags",
    endpoint: "http://127.0.0.1:1",
    providerKey: options.providerKey,
    providerModelString: options.model,
    modelListed: null,
    modelCount: null,
    timeoutMs: 25,
    lastError: "fetch failed",
  });

  const report = await modelDoctorReportLive("qwen3.5", { _probeOllamaRoute: probe });

  assert.equal(report.canonicalId, "qwen3.5");
  assert.equal(report.availableForAutoSelection, false);
  assert.equal(report.auth.present, false);
  assert.equal(report.liveness.status, "route-unavailable");
  assert.equal(report.liveness.probe, "ollama-tags");
  assert.equal(report.channels[0].liveness.status, "route-unavailable");
  assert.match(report.suggestedFix, /OLLAMA_URL|Ollama/);
});

test("live doctor folds an unreachable NVIDIA NIM route into route-unavailable; reachable is presence-ok", async () => {
  const prior = process.env.NVIDIA_NIM_API_KEY;
  process.env.NVIDIA_NIM_API_KEY = "nvapi-DOCTOR-TEST-KEY";
  try {
    const unreachable = async (options) => ({
      status: "unreachable",
      staticAvailable: false,
      probe: "nvidia-nim",
      endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
      providerKey: options.providerKey,
      providerModelString: options.model,
      modelListed: null,
      timeoutMs: 25,
      lastError: "fetch failed",
    });

    const down = await modelDoctorReportLive("nim-deepseek-v4-pro", { _probeNvidiaRoute: unreachable });
    assert.equal(down.canonicalId, "nim-deepseek-v4-pro");
    assert.equal(down.availableForAutoSelection, false);
    assert.equal(down.liveness.status, "route-unavailable");
    assert.equal(down.liveness.probe, "nvidia-nim");
    assert.equal(down.channels[0].liveness.status, "route-unavailable");

    const reachable = async (options) => ({
      status: "reachable",
      staticAvailable: true,
      probe: "nvidia-nim",
      endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
      providerKey: options.providerKey,
      providerModelString: options.model,
      modelListed: null,
      timeoutMs: 25,
      lastError: null,
    });

    const up = await modelDoctorReportLive("nim-deepseek-v4-pro", { _probeNvidiaRoute: reachable });
    assert.equal(up.availableForAutoSelection, true);
    assert.equal(up.liveness.status, "presence-ok");
    assert.equal(up.auth.present, true);
  } finally {
    if (prior === undefined) delete process.env.NVIDIA_NIM_API_KEY;
    else process.env.NVIDIA_NIM_API_KEY = prior;
  }
});

test("route preflight returns a structured Ollama route failure", async () => {
  const failure = await describeRoutePreflightFailure("qwen3.5", {
    _probeOllamaRoute: async (options) => ({
      status: "unreachable",
      staticAvailable: false,
      probe: "ollama-tags",
      endpoint: "http://127.0.0.1:1",
      providerKey: options.providerKey,
      providerModelString: options.model,
      modelListed: null,
      modelCount: null,
      timeoutMs: 25,
      lastError: "fetch failed",
    }),
  });

  assert.equal(failure.code, "BRIDGE_ROUTE_UNAVAILABLE");
  assert.equal(failure.canonicalId, "qwen3.5");
  assert.equal(failure.providerId, "provider.ollama.cloud");
  assert.equal(failure.transport, "ollama");
  assert.equal(failure.bridge, "ollama.js");
  assert.equal(failure.message, "fetch failed");
});
