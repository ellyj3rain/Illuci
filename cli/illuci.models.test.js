import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args, env = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function fakeAgyEnv() {
  const dir = mkdtempSync(join(tmpdir(), "illuci-cli-models-agy-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");
  return { dir, env: { AGY_PATH: fakeAgy } };
}

test("models doctor CLI emits route diagnostics as JSON", () => {
  const { dir, env } = fakeAgyEnv();
  try {
    const payload = JSON.parse(runIlluci(["models", "--doctor", "claude,gpt-oss,qwen3.5", "--route-probe-timeout", "50", "--json"], { ...env, OLLAMA_URL: "http://127.0.0.1:1" }));
    const byId = new Map(payload.models.map((report) => [report.requestedId, report]));

    assert.equal(byId.get("claude").canonicalId, "claude-opus");
    assert.equal(byId.get("claude").providerId, "provider.google.antigravity");
    assert.equal(byId.get("gpt-oss").transport, "antigravity");
    assert.equal(byId.get("qwen3.5").roleCoverage.status, "role-routable");
    assert.equal(byId.get("qwen3.5").liveness.status, "route-unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("models CLI emits identity-card JSON without dispatch", () => {
  const payload = JSON.parse(runIlluci(["models", "--identity-card", "qwen3.5", "--json"]));

  assert.equal(payload.identityCard.schema, "illuci.terminal.identity-card/1");
  assert.equal(payload.identityCard.modelId, "qwen3.5");
  assert.equal(payload.route.canonicalId, "qwen3.5");
  assert.equal(payload.route.providerId, "provider.ollama.cloud");
});

test("models JSON includes compact identity-card summaries", () => {
  const payload = JSON.parse(runIlluci(["models", "--provider", "provider.xai.cli", "--json"]));
  const grok = payload.curated.find((model) => model.registryId === "grok-build");

  assert.ok(grok);
  assert.equal(grok.identityCard.schema, "illuci.terminal.identity-card/1");
  assert.equal(grok.identityCard.modelId, "grok-build");
  assert.ok(grok.identityCard.aliases.includes("grok-cli"));
  assert.match(grok.identityCard.workingStyle, /subscription/u);
});
