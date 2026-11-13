import test from "node:test";
import assert from "node:assert/strict";

import { compactPortrait, normalizeHexColor, renderCompactModelCard, renderLogo } from "./design.js";
import {
  extractIdentityCardJson,
  identityCardGenerationPrompt,
  listModelIdentityCards,
  modelIdentityCardFor,
  normalizeGeneratedIdentityCard,
  validateIdentityCard,
} from "./identity-cards.js";

test("terminal logo preserves lowercase illuci engine naming", () => {
  const logo = renderLogo({ color: false });
  assert.match(logo, /illuci/u);
  assert.doesNotMatch(logo, /N E O/u);
});

test("color normalization accepts named, short, and long hex colors", () => {
  assert.equal(normalizeHexColor("cyan"), "#00ffcc");
  assert.equal(normalizeHexColor("#abc"), "#aabbcc");
  assert.equal(normalizeHexColor("D4A574"), "#d4a574");
  assert.equal(normalizeHexColor("nope", "#123456"), "#123456");
});

test("compactPortrait trims empty lines and bounds the visible card", () => {
  const lines = compactPortrait("\n  abcdef\n  ghijkl\n", { maxLines: 1, maxWidth: 5 });
  assert.deepEqual(lines, ["  abc"]);
});

test("identity cards resolve registry aliases without flattening distinct qwen lanes", () => {
  assert.equal(modelIdentityCardFor("claude").modelId, "claude-opus");
  assert.equal(modelIdentityCardFor("qwen3.5").modelId, "qwen3.5");
  assert.equal(modelIdentityCardFor("qwen-code").modelId, "qwen-code");
});

test("seeded registry cards satisfy the display schema", () => {
  for (const card of listModelIdentityCards()) {
    assert.deepEqual(validateIdentityCard(card), [], card.modelId);
  }
});

test("unknown ids receive a bounded fallback card", () => {
  const card = modelIdentityCardFor("not-real");
  assert.equal(card.origin, "registry-fallback");
  assert.equal(card.canonicalId, null);
  assert.deepEqual(validateIdentityCard(card), []);
});

test("compact model-card render includes identity and route data", () => {
  const card = modelIdentityCardFor("grok-cli");
  const text = renderCompactModelCard(card, { color: false, liveness: "presence-ok", provider: "xAI Grok CLI" });
  assert.match(text, /Grok Build \[grok-build\] aliases grok-cli/u);
  assert.match(text, /route: xAI Grok CLI/u);
  assert.match(text, /strengths:/u);
});

test("generation prompt marks cards as display metadata only", () => {
  const prompt = identityCardGenerationPrompt("grok-cli");
  assert.match(prompt, /display metadata only/u);
  assert.match(prompt, /illuci\.terminal\.identity-card\/1/u);
  assert.match(prompt, /JSON only/u);
});

test("generated card JSON normalizes into the same display schema", () => {
  const raw = extractIdentityCardJson("```json\n{\"displayName\":\"Grok Self\",\"portrait\":{\"ascii\":\"<o>\\n/|/\",\"color\":\"0fc\"},\"strengths\":[\"spark\"],\"weaknesses\":[\"none\"],\"avoidTasks\":[],\"workingStyle\":\"Fast.\"}\n```");
  const card = normalizeGeneratedIdentityCard(raw, "grok-cli");
  assert.equal(card.schema, "illuci.terminal.identity-card/1");
  assert.equal(card.modelId, "grok-build");
  assert.equal(card.portrait.color, "#00ffcc");
  assert.deepEqual(validateIdentityCard(card), []);
});
