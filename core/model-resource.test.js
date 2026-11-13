/**
 * The model-resource selection layer + the back-compat invariants the live dev-team +
 * adversarial-debate company pinned. Hermetic: pure registry data, no model/bridge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { select, resolve, aliasIndex, resetModelResourceCaches } from "./model-resource.js";
import { resolveModelId, buildModelDefaults, listModelIds } from "./bridges/model-registry.js";

// ─── Back-compat: the debate's invariants (the real risk) ───

test("legacy claude-local stays explicit Fable while bare claude resolves to Opus", () => {
  assert.equal(resolve("claude-local").entry.id, "claude-fable");
  assert.equal(resolve("claude").entry.id, "claude-opus");
  assert.equal(resolve("anthropic").entry.id, "claude-opus");
  assert.equal(resolve("opus").entry.id, "claude-opus"); // cliAlias
  assert.equal(resolve("grok").entry.id, "grok");        // canonical id
});

test("aliasIndex maps every spelling to the SAME dispatch target it always did", () => {
  assert.equal(aliasIndex["claude-local"], "claude-fable");
  assert.equal(aliasIndex["opus"], "claude-opus");
  assert.equal(aliasIndex["anthropic"], "claude-opus");
  assert.equal(aliasIndex["glm-5:cloud"], "glm");          // the Phase 1 back-compat alias
  assert.equal(aliasIndex["kimi-k2.6:cloud"], "kimi-cloud");
});

test("the registry contract is re-exported unchanged (no fabrication, no shape pollution)", () => {
  // resolveModelId is identical behavior.
  assert.equal(resolveModelId("claude-local"), "claude-fable");
  assert.equal(resolveModelId("totally-unknown"), null);
  // buildModelDefaults keys stay canonical-only (the debate's invariant).
  assert.deepEqual(Object.keys(buildModelDefaults()).sort(), listModelIds().sort());
  // a v2 field (variant/transport) did NOT leak into the dispatch defaults.
  assert.equal("variant" in buildModelDefaults()["claude-opus"], false);
  assert.equal("transport" in buildModelDefaults()["claude-opus"], false);
});

// ─── New selection: family + variant/reasoning/transport ───

test("an explicit family selection uses the FRONTIER default variant", () => {
  // The OBJECT form is not the "claude" alias, so it takes the family default (opus).
  assert.equal(resolve({ family: "claude" }).entry.id, "claude-opus");
  assert.equal(resolve({ family: "grok" }).entry.id, "grok-build"); // grok-4 via the Grok Build CLI
  assert.equal(resolve({ family: "gemini" }).entry.id, "gemini");
});

test("variant selects within a family", () => {
  assert.equal(resolve({ family: "claude", variant: "sonnet" }).entry.id, "claude-sonnet");
  assert.equal(resolve({ family: "claude", variant: "haiku" }).entry.id, "claude-haiku");
  assert.equal(resolve({ family: "grok", variant: "composer-2.5" }).entry.id, "grok-composer-2.5-fast");
  assert.equal(resolve({ family: "grok", variant: "build-0.1" }).entry.id, "grok-build");
});

test("transport disambiguates same-variant entries", () => {
  // grok-4 exists on two transports: the Grok Build CLI and the API.
  assert.equal(resolve({ family: "grok", variant: "grok-4", transport: "api" }).entry.id, "grok");
  assert.equal(resolve({ family: "grok", variant: "grok-4", transport: "grok-build" }).entry.id, "grok-build");
});

test("explicit antigravity transport selects the agy channel when agy is present", () => {
  resetModelResourceCaches();
  const prior = {
    normalized: process.env.ILLUCI_FLEET_NORMALIZED_ENABLED,
    channels: process.env.ILLUCI_FLEET_CHANNELS_ENABLED,
    agyPath: process.env.AGY_PATH,
  };
  const dir = mkdtempSync(join(tmpdir(), "illuci-agy-channel-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");

  process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = "1";
  process.env.ILLUCI_FLEET_CHANNELS_ENABLED = "1";
  process.env.AGY_PATH = fakeAgy;

  try {
    const r = resolve({ family: "gpt", reasoning: "high", transport: "antigravity" });
    assert.equal(r.entry.id, "gpt-oss");
    assert.equal(r.channel.transport, "antigravity");
    assert.equal(r.channel.bridge, "agy.js");
    assert.equal(r.channel.model, "GPT-OSS 120B (Medium)");
  } finally {
    if (prior.normalized === undefined) delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
    else process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = prior.normalized;
    if (prior.channels === undefined) delete process.env.ILLUCI_FLEET_CHANNELS_ENABLED;
    else process.env.ILLUCI_FLEET_CHANNELS_ENABLED = prior.channels;
    if (prior.agyPath === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prior.agyPath;
    rmSync(dir, { recursive: true, force: true });
    resetModelResourceCaches();
  }
});

test("cached string selections are returned as mutation-isolated copies", () => {
  resetModelResourceCaches();
  const first = select("claude.sonnet.medium");
  first.variant = "haiku";

  const second = select("claude.sonnet.medium");
  assert.notEqual(first, second);
  assert.equal(second.variant, "sonnet");
  assert.equal(second.reasoning, "medium");
});

test("model-resource cache reset preserves resolver behavior", () => {
  resetModelResourceCaches();
  assert.equal(resolve({ family: "grok", variant: "grok-4", transport: "api" }).entry.id, "grok");
  assert.equal(resolve("grok-composer-2.5-fast").entry.id, "grok-composer-2.5-fast");

  resetModelResourceCaches();
  assert.equal(resolve({ family: "grok", variant: "grok-4", transport: "api" }).entry.id, "grok");
  assert.equal(resolve("grok-composer-2.5-fast").entry.id, "grok-composer-2.5-fast");
});

test("a single-entry family resolves to its one entry", () => {
  assert.equal(resolve({ family: "deepseek" }).entry.id, "deepseek");
  assert.equal(resolve({ family: "minimax" }).entry.id, "minimax");
});

test("the reasoning dial rides in params, mapped not dropped", () => {
  const r = resolve({ family: "claude", variant: "sonnet", reasoning: "medium" });
  assert.equal(r.entry.id, "claude-sonnet");
  assert.equal(r.params.reasoning, "medium");
  // no reasoning -> empty params (no spurious knob)
  assert.deepEqual(resolve({ family: "claude", variant: "sonnet" }).params, {});
});

test("string colon-tuple selection works when it is not a known alias", () => {
  // not a known id/alias -> parsed as family:variant
  assert.equal(resolve("claude:haiku").entry.id, "claude-haiku");
  assert.equal(select("claude:sonnet:high").reasoning, "high");
});

test("select precedence: a known alias pins the id before any tuple parse", () => {
  assert.equal(select("claude-local")._pinnedId, "claude-fable");
  assert.equal(select("opus")._pinnedId, "claude-opus");
});

test("resolve throws (never fabricates) on an unknown family or spelling", () => {
  assert.throws(() => resolve({ family: "nonesuch" }), /unknown family/);
  // a no-colon unknown string is read as a (bogus) family -> still throws, never fabricates
  assert.throws(() => resolve("not-a-model-and-not-a-family"), /unknown family/);
  assert.throws(() => resolve(""), /no known id\/alias and no family/);
});

// ─── Hardened selection sugar (colosseum + darwinian mutator cases) ───

test("dot-notation selects within a family with a reasoning dial", () => {
  assert.equal(select("claude.sonnet.medium").variant, "sonnet");
  assert.equal(select("claude.sonnet.medium").reasoning, "medium");
  const r = resolve("claude.sonnet.medium");
  assert.equal(r.entry.id, "claude-sonnet");
  assert.equal(r.params.reasoning, "medium");
});

test("case 6: a real id that contains dots is matched as an id, NOT dot-parsed", () => {
  assert.equal(resolve("grok-composer-2.5-fast").entry.id, "grok-composer-2.5-fast");
  assert.equal(resolve("gemini-3.1-pro").entry.id, "gemini-3.1-pro");
  assert.equal(select("grok-composer-2.5-fast")._pinnedId, "grok-composer-2.5-fast");
});

test("dot-sugar fires only for a known multi-variant family", () => {
  // deepseek is a single-entry family (not in FAMILIES); "deepseek.foo" is not sugar -> bogus family
  assert.throws(() => resolve("deepseek.foo"), /unknown family/);
});

test("too many selection segments throws (never silently mis-parsed)", () => {
  assert.throws(() => resolve("claude.opus.high.cli.extra"), /too many segments/);
});

test("object-pin form: {id} pins; a variant on a pinned id is ignored, unknown id throws", () => {
  assert.equal(select({ id: "claude-opus" })._pinnedId, "claude-opus");
  assert.equal(resolve({ id: "claude-opus" }).entry.id, "claude-opus");
  assert.equal(resolve({ id: "claude-opus", variant: "sonnet" }).entry.id, "claude-opus"); // variant ignored
  assert.throws(() => select({ id: "no-such-id" }), /unknown id/);
});

// ─── The dispatch choke-point's byte-identity contract (resolveSeatModel relies on this) ───

test("CHOKE-POINT CONTRACT: a flat id resolves to itself with EMPTY params (no dial leaks)", () => {
  // This is the exact step the runner's resolveSeatModel performs for a back-compat flat id.
  // Pinned-id path: reasoning is null -> buildParams returns {} -> no reasoning knob is injected.
  for (const id of ["claude-local", "opus", "grok", "grok-cli", "claude-fable"]) {
    const r = resolve(id);
    assert.equal(r.entry.id, resolveModelId(id), `flat id "${id}" must resolve to its canonical dispatch target`);
    assert.deepEqual(r.params, {}, `flat id "${id}" must carry no params (byte-identity)`);
  }
});

test("explicit transport pins select channels without requiring normalized fleet flags", () => {
  resetModelResourceCaches();
  const prior = {
    normalized: process.env.ILLUCI_FLEET_NORMALIZED_ENABLED,
    channels: process.env.ILLUCI_FLEET_CHANNELS_ENABLED,
    agyPath: process.env.AGY_PATH,
  };
  const dir = mkdtempSync(join(tmpdir(), "illuci-explicit-channel-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");

  delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
  delete process.env.ILLUCI_FLEET_CHANNELS_ENABLED;
  process.env.AGY_PATH = fakeAgy;

  try {
    const r = resolve("claude.opus.high.antigravity");
    assert.equal(r.entry.id, "claude-opus");
    assert.equal(r.channel.transport, "antigravity");
    assert.equal(r.channel.bridge, "agy.js");
    assert.equal(r.channel.model, "Claude Opus 4.6 (Thinking)");
  } finally {
    if (prior.normalized === undefined) delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
    else process.env.ILLUCI_FLEET_NORMALIZED_ENABLED = prior.normalized;
    if (prior.channels === undefined) delete process.env.ILLUCI_FLEET_CHANNELS_ENABLED;
    else process.env.ILLUCI_FLEET_CHANNELS_ENABLED = prior.channels;
    if (prior.agyPath === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prior.agyPath;
    rmSync(dir, { recursive: true, force: true });
    resetModelResourceCaches();
  }
});
