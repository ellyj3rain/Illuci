/**
 * illuci — Capability Spine tests (node:test)
 *
 * Proves the model-family capability spine is the real source of truth the
 * core-loop audit found missing: sub-models are selectable, reasoning/speed
 * tiers resolve (not cosmetic), Claude self-call exposes its sub-models, and
 * unknown ids degrade safely.
 *
 * Run: node --test illuci/core/bridges/capabilities.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getCapabilities,
  resolveReasoningTier,
  resolveSpeedTier,
  listFamilies,
  CLAUDE_SUBMODELS,
} from "./capabilities.js";

test("Claude family exposes the four sub-models with current dispatch model ids", () => {
  const cap = getCapabilities("claude-local");
  assert.equal(cap.family, "claude");
  assert.equal(cap.known, true);
  const ids = cap.subModels.map((s) => s.id);
  assert.deepEqual(ids, ["claude-fable", "claude-opus", "claude-sonnet", "claude-haiku"]);
  const fable = CLAUDE_SUBMODELS.find((s) => s.id === "claude-fable");
  assert.equal(fable.model, "claude-opus-4-8");
  // No cliAlias for Fable: the CLI has no "fable" shortcut (404 verified live);
  // dispatch goes by the full model id.
  assert.equal(fable.cliAlias, undefined);
});

test("Claude sub-model ids resolve to their own descriptors", () => {
  assert.equal(getCapabilities("claude-fable").family, "claude");
  assert.equal(getCapabilities("claude-haiku").reasoning.default, "fast");
  assert.equal(getCapabilities("claude-api").billing, "api");
  assert.equal(getCapabilities("claude-api").streaming, true);
});

test("Grok exposes a real effort tier set and a fast speed sub-model", () => {
  const cap = getCapabilities("grok-build");
  assert.equal(cap.family, "grok");
  assert.deepEqual(cap.reasoning.tiers, ["max", "xhigh", "high", "medium", "low"]);
  assert.equal(cap.reasoning.control, "effort");
  assert.ok(cap.subModels.some((s) => s.id === "grok-composer-2.5-fast" && s.tier === "fast"));
});

test("grok-composer is a fast model with reasoning disabled", () => {
  const cap = getCapabilities("grok-composer-2.5-fast");
  assert.equal(cap.reasoning.supported, false);
});

test("Gemini sub-models and thinking-tier control are modeled", () => {
  const cap = getCapabilities("gemini-3.1-pro");
  assert.equal(cap.family, "gemini");
  assert.equal(cap.reasoning.control, "thinking");
  assert.equal(cap.contextWindow, 1000000);
  assert.equal(getCapabilities("gemini-3.1-flash-lite").reasoning.default, "low");
});

test("Ollama cloud OSS models map to the ollama-cloud family profile with native tools + think tiers", () => {
  const cap = getCapabilities("deepseek");
  assert.equal(cap.family, "ollama-cloud");
  assert.equal(cap.nativeTools, true);
  assert.equal(cap.streaming, true);
  assert.equal(cap.reasoning.control, "think");
  assert.equal(cap.provider, "ollama-cloud");
});

test("resolveReasoningTier honors requested tier, falls back to default, null when unsupported", () => {
  assert.equal(resolveReasoningTier("grok-build", "max"), "max");
  assert.equal(resolveReasoningTier("grok-build", "bogus"), "high"); // default
  assert.equal(resolveReasoningTier("grok-composer-2.5-fast", "max"), null); // unsupported
  assert.equal(resolveReasoningTier("ollama", "high"), null); // local, no reasoning
});

test("resolveSpeedTier honors requested tier within the family's set", () => {
  assert.equal(resolveSpeedTier("gemini-3.1-pro", "flash"), "flash");
  assert.equal(resolveSpeedTier("gemini-3.1-pro", "bogus"), "pro"); // default
  assert.equal(resolveSpeedTier("deepseek", "fast"), null); // ollama-cloud has no speed tiers
});

test("listFamilies returns every family with its sub-model roster", () => {
  const fams = listFamilies();
  const keys = fams.map((f) => f.family);
  for (const k of ["claude", "grok", "gemini", "ollama-cloud", "ollama-local", "gpt", "kimi"]) {
    assert.ok(keys.includes(k), `missing family ${k}`);
  }
  const claude = fams.find((f) => f.family === "claude");
  assert.equal(claude.subModels.length, 4);
  assert.equal(claude.ultra.available, true);
});

test("unknown model id degrades to a minimal safe descriptor (never throws)", () => {
  const cap = getCapabilities("no-such-model-xyz");
  assert.equal(cap.known, false);
  assert.equal(cap.reasoning.supported, false);
  assert.deepEqual(cap.subModels, []);
});
