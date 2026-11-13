import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { probeRoute, resetRouteProbeCache } from "./ollama.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRouteProbeCache();
});

test("probeRoute marks an unreachable Ollama endpoint unavailable", async () => {
  globalThis.fetch = async () => { throw new Error("fetch failed"); };

  const probe = await probeRoute({
    baseUrl: "http://127.0.0.1:1",
    providerKey: "ollama-cloud",
    model: "qwen3.5:397b-cloud",
    timeoutMs: 25,
    noCache: true,
  });

  assert.equal(probe.status, "unreachable");
  assert.equal(probe.staticAvailable, false);
  assert.equal(probe.probe, "ollama-tags");
  assert.equal(probe.lastError, "fetch failed");
});

test("probeRoute requires local Ollama tags to be listed", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: "qwen36-abl:fast", size: 1, details: {} }] }),
  });

  const probe = await probeRoute({
    baseUrl: "http://ollama.test",
    providerKey: "ollama-local",
    model: "hermes3:8b",
    timeoutMs: 25,
    noCache: true,
  });

  assert.equal(probe.status, "model-missing");
  assert.equal(probe.staticAvailable, false);
  assert.equal(probe.modelListed, false);
  assert.match(probe.lastError, /hermes3:8b/);
});

test("probeRoute treats reachable Ollama Cloud as route-present even when a tag is not listed", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: "qwen36-abl:fast", size: 1, details: {} }] }),
  });

  const probe = await probeRoute({
    baseUrl: "http://ollama.test",
    providerKey: "ollama-cloud",
    model: "qwen3.5:397b-cloud",
    timeoutMs: 25,
    noCache: true,
  });

  assert.equal(probe.status, "reachable");
  assert.equal(probe.staticAvailable, true);
  assert.equal(probe.modelListed, false);
  assert.equal(probe.lastError, null);
});