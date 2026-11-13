import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAll,
  getStatus,
  HEALTH_RESOURCES,
  isUp,
  PROVIDERS,
  SERVICES,
} from "./monitor.js";

test("provider health resources use gateway provider ids, not model aliases", () => {
  assert.ok(PROVIDERS.includes("provider.ollama.cloud"));
  assert.ok(PROVIDERS.includes("provider.xai.cli"));
  assert.ok(PROVIDERS.includes("provider.google.antigravity"));
  assert.ok(PROVIDERS.includes("provider.moonshot.cli"));
  assert.ok(!PROVIDERS.includes("deepseek"));
  assert.ok(!PROVIDERS.includes("kimi-local"));
  assert.ok(!PROVIDERS.includes("grok"));

  assert.ok(SERVICES.includes("service.burp"));
  assert.ok(HEALTH_RESOURCES.includes("service.burp"));
});

test("initial status exposes provider labels and can omit services", () => {
  const status = getStatus({ includeServices: false });
  assert.deepEqual(Object.keys(status).sort(), [...PROVIDERS].sort());
  assert.equal(status["provider.ollama.cloud"].label, "Ollama Cloud");
  assert.equal(status["provider.xai.cli"].kind, "provider");
  assert.equal(status["provider.ollama.cloud"].status, "unknown");
});

test("checkAll performs non-token provider presence checks with injected env/fetch", async () => {
  const env = {
    OLLAMA_URL: "http://ollama.example",
    XAI_API_KEY: "xai-test",
    ANTHROPIC_API_KEY: "anthropic-test",
    GEMINI_API_KEY: "gemini-test",
  };
  const calls = [];
  const status = await checkAll({
    includeServices: false,
    env,
    now: () => 12345,
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    },
  });

  assert.equal(status["provider.ollama.cloud"].status, "up");
  assert.equal(status["provider.ollama.local"].status, "up");
  assert.equal(status["provider.xai.api"].status, "up");
  assert.equal(status["provider.anthropic.api"].status, "up");
  assert.equal(status["provider.google.api"].status, "up");
  assert.equal(status["provider.google.api"].detail, "developer");
  assert.equal(status["provider.ollama.cloud"].lastCheck, 12345);
  assert.ok(calls.every((url) => url === "http://ollama.example/api/tags"));
  assert.ok(!Object.hasOwn(status, "service.burp"));
  assert.equal(isUp("ollama-cloud"), true);
});

test("missing API credentials are down without probing generation endpoints", async () => {
  const status = await checkAll({
    includeServices: false,
    env: { OLLAMA_URL: "http://ollama.example" },
    now: () => 54321,
    fetch: async () => ({ ok: true, status: 200 }),
  });

  assert.equal(status["provider.xai.api"].status, "down");
  assert.match(status["provider.xai.api"].error, /XAI_API_KEY/);
  assert.equal(status["provider.anthropic.api"].status, "down");
  assert.match(status["provider.anthropic.api"].error, /ANTHROPIC_API_KEY/);
});

test("service health is explicit and separate from provider health", async () => {
  const calls = [];
  const status = await checkAll({
    env: { OLLAMA_URL: "http://ollama.example", BURP_BRIDGE_URL: "http://burp.example" },
    now: () => 777,
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    },
  });

  assert.equal(status["service.burp"].kind, "service");
  assert.equal(status["service.burp"].status, "up");
  assert.equal(status["service.burp"].detail, "http://burp.example");
  assert.ok(calls.includes("http://burp.example/health"));
});
