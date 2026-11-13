import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLiveness } from "./liveness.js";
import { listModelIds } from "./model-registry.js";
import { isAvailable, MODEL_CAPABILITIES } from "../matrix/capability-matrix.js";

function clearFlags() {
  delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
  delete process.env.ILLUCI_FLEET_LIVENESS_ENABLED;
}

test("resolveLiveness: faithful port of the known switch arms", () => {
  const h = {
    isCodexSdkInstalled: () => true,
    detectGeminiApiAuth: () => ({ ok: true }),
    isAgyPresent: () => true,
    isKimiInstalled: () => false,
    isGrokCliPresent: () => true,
    xaiApiKey: "k",
  };
  assert.equal(resolveLiveness("deepseek", h), true);
  assert.equal(resolveLiveness("deepseek", { ...h, isAgyPresent: () => false }), true);
  assert.equal(resolveLiveness("claude-fable", h), false);
  assert.equal(resolveLiveness("claude-opus", h), true);
  assert.equal(resolveLiveness("claude-opus", { ...h, isAgyPresent: () => false }), false);
  assert.equal(resolveLiveness("gemini-local", h), false);
  assert.equal(resolveLiveness("codex-local", h), true);
  assert.equal(resolveLiveness("kimi-local", h), false);   // injected false
  assert.equal(resolveLiveness("grok", h), true);          // key present
  assert.equal(resolveLiveness("grok-build", h), true);
  assert.equal(resolveLiveness("gemini", h), true);
  assert.equal(resolveLiveness("unknown-xyz", h), false);  // default arm
  // detectGeminiApiAuth throwing -> false (the try/catch arm)
  assert.equal(
    resolveLiveness("gemini-3.1-pro", { ...h, detectGeminiApiAuth: () => { throw new Error("no auth"); } }),
    false,
  );
});

test("isAvailable parity: flag-OFF === flag-ON for every model (byte-identical relocation)", () => {
  const ids = new Set([...Object.keys(MODEL_CAPABILITIES), ...listModelIds()]);
  for (const id of ids) {
    clearFlags();
    const off = isAvailable(id);
    process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = "true";
    process.env.ILLUCI_FLEET_LIVENESS_ENABLED = "true";
    const on = isAvailable(id);
    clearFlags();
    assert.equal(on, off, `parity mismatch for ${id}: off=${off} on=${on}`);
  }
});

test("governance suspension wins over liveness credentials", () => {
  clearFlags();
  const prior = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  try {
    assert.equal(resolveLiveness("grok", {
      isCodexSdkInstalled: () => true,
      detectGeminiApiAuth: () => ({ ok: true }),
      isAgyPresent: () => true,
      isKimiInstalled: () => true,
      isGrokCliPresent: () => true,
      xaiApiKey: "test-key",
    }), true);
    assert.equal(isAvailable("grok"), false);
  } finally {
    if (prior === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prior;
    clearFlags();
  }
});
