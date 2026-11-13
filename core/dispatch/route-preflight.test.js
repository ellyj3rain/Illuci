import test from "node:test";
import assert from "node:assert/strict";

import { queryModel, queryModelStream } from "./dispatch.js";

function deadOllamaProbe(options) {
  return {
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
  };
}

test("queryModel fails fast with structured Ollama route preflight failure", async () => {
  const result = await queryModel("qwen3.5", "ping", {
    raw: true,
    _probeOllamaRoute: deadOllamaProbe,
  });

  assert.equal(result.failed, true);
  assert.equal(result.unavailable, true);
  assert.equal(result.bridgeFailure.code, "BRIDGE_ROUTE_UNAVAILABLE");
  assert.equal(result.bridgeFailure.providerKey, "ollama-cloud");
  assert.equal(result.bridgeFailure.providerModelString, "qwen3.5:397b-cloud");
  assert.equal(result.error, "fetch failed");
});

test("queryModelStream emits a structured Ollama route preflight error", async () => {
  const events = [];
  for await (const event of queryModelStream("qwen3.5", "ping", {
    raw: true,
    _probeOllamaRoute: deadOllamaProbe,
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].bridgeFailure.code, "BRIDGE_ROUTE_UNAVAILABLE");
  assert.equal(events[0].error, "fetch failed");
});