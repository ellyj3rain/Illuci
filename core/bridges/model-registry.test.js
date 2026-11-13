/**
 * model-registry tests - the single source of truth for model identity.
 * Guards: resolution from every spelling, no duplicate identities, derived
 * defaults shape, and the claude-local dedupe (alias, not a second row).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_REGISTRY,
  isSuspended,
  getEntry,
  resolveModelId,
  listModelIds,
  buildModelDefaults,
} from "./model-registry.js";
import { knownBridgeFiles } from "./bridge-loaders.js";

test("every canonical id resolves to itself", () => {
  for (const id of listModelIds()) {
    assert.equal(resolveModelId(id), id);
  }
});

test("ids, aliases, and cli shortcuts never collide", () => {
  const seen = new Map();
  for (const e of MODEL_REGISTRY) {
    for (const key of [e.id, e.cliAlias, ...(e.aliases ?? [])]) {
      if (!key) continue;
      assert.ok(!seen.has(key), `duplicate identity "${key}" on ${e.id} and ${seen.get(key)}`);
      seen.set(key, e.id);
    }
  }
});

test("legacy Fable spellings stay separate from default Claude", () => {
  for (const legacy of ["fable", "claude-local"]) {
    assert.equal(resolveModelId(legacy), "claude-fable", legacy);
  }
  for (const current of ["claude", "anthropic"]) {
    assert.equal(resolveModelId(current), "claude-opus", current);
  }
});

test("grok-cli is a compatibility spelling for canonical Grok Build", () => {
  assert.equal(resolveModelId("grok-cli"), "grok-build");
  assert.ok(!listModelIds().includes("grok-cli"), "grok-cli must not be a canonical dispatch id");
  assert.equal(getEntry("grok-cli").id, "grok-build");
  // [A94]/DR-187: the illuci id stays grok-build; the provider MODEL string
  // tracks the Grok CLI's rename (grok-4.5, live-verified — the old string
  // 400s "unknown model id").
  assert.equal(getEntry("grok-cli").model, "grok-4.5");
});

test("cli shortcuts resolve to their sub-models", () => {
  assert.equal(resolveModelId("opus"), "claude-opus");
  assert.equal(resolveModelId("sonnet"), "claude-sonnet");
  assert.equal(resolveModelId("haiku"), "claude-haiku");
});

test("provider model strings resolve", () => {
  assert.equal(resolveModelId("claude-opus-4-8"), "claude-fable");
  assert.equal(resolveModelId("deepseek-v4-pro:cloud"), "deepseek");
});

test("unknown spellings return null (forward-compat is the caller's call)", () => {
  assert.equal(getEntry("totally-new-model"), null);
  assert.equal(resolveModelId(""), null);
  assert.equal(resolveModelId(null), null);
});

test("claude-local is an alias, not a second enumerated row", () => {
  const defaults = buildModelDefaults();
  assert.ok(!("claude-local" in defaults), "claude-local must not be a canonical key");
  assert.equal(defaults["claude-fable"].model, "claude-opus-4-8");
});

test("temporary API route hold is expressed as reversible model status", () => {
  for (const id of ["grok", "claude-api", "gemini-3.1-pro"]) {
    assert.equal(isSuspended(id), true, id);
  }
  assert.equal(isSuspended("grok-build"), false);
  assert.equal(isSuspended("grok-cli"), false);
});

test("derived defaults carry only dispatch fields", () => {
  const defaults = buildModelDefaults();
  for (const [id, d] of Object.entries(defaults)) {
    assert.ok(d.family && d.provider, id);
    for (const k of Object.keys(d)) {
      assert.ok(["model", "family", "provider", "reasoning", "adaptive"].includes(k), `${id}.${k}`);
    }
  }
});

test("every entry's bridge file is one of the known loaders", () => {
  const known = new Set(knownBridgeFiles());
  for (const e of MODEL_REGISTRY) assert.ok(known.has(e.bridge), e.id);
});

test("agy-routed identity dispatches via getBridge (the loader is registered, not just a known name)", async () => {
  const { getBridge } = await import("./index.js");
  const mod = await getBridge("gemini"); // resolves to the agy.js channel
  assert.ok(mod && (mod.query || mod.default?.query), "agy.js must be in BRIDGE_LOADERS so the agy channel can dispatch, not only probe");
});
