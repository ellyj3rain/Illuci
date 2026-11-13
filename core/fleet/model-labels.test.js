import test from "node:test";
import assert from "node:assert/strict";

import { listModelLabels, modelLabelFor } from "./model-labels.js";

test("model labels keep default Claude distinct from legacy Fable", () => {
  const current = modelLabelFor("claude");
  const legacy = modelLabelFor("claude-local");

  assert.equal(current.canonicalId, "claude-opus");
  assert.equal(current.publicModelId, "model.claude.opus");
  assert.equal(current.providerId, "provider.google.antigravity");
  assert.equal(legacy.canonicalId, "claude-fable");
  assert.equal(legacy.publicModelId, "model.claude.fable");
});

test("model labels expose graph-ready facets and edges", () => {
  const label = modelLabelFor("gpt-oss");
  const relations = new Set(label.graph.edges.map((edge) => edge.relation));

  assert.equal(label.graph.node.id, "model.gpt-oss.frontier");
  assert.equal(label.family, "gpt");
  assert.equal(label.transport, "antigravity");
  assert.equal(label.bridge, "agy.js");
  assert.ok(relations.has("provided-by"));
  assert.ok(relations.has("in-family"));
  assert.ok(relations.has("uses-transport"));
  assert.ok(relations.has("provider-model"));
});

test("general Qwen and Qwen Code labels stay separate", () => {
  const general = modelLabelFor("qwen3.5");
  const code = modelLabelFor("qwen-code");

  assert.equal(general.publicModelId, "model.qwen.frontier");
  assert.equal(general.tier, "frontier");
  assert.equal(code.publicModelId, "model.qwen.code");
  assert.equal(code.tier, "code-focused");
});

test("Grok labels distinguish suspended API identity from subscription alias", () => {
  const api = modelLabelFor("grok");
  const compat = modelLabelFor("grok-cli");
  const relations = new Set(api.graph.edges.map((edge) => edge.relation));

  assert.equal(api.canonicalId, "grok");
  assert.equal(api.routeStatus, "suspended");
  assert.ok(relations.has("has-route-status"));
  assert.equal(compat.canonicalId, "grok-build");
  assert.equal(compat.publicModelId, "model.grok.build");
  assert.equal(compat.routeStatus, "available");
});

test("unknown labels are stable graph nodes, not fabricated registry ids", () => {
  const unknown = modelLabelFor("not-real-model");

  assert.equal(unknown.known, false);
  assert.equal(unknown.canonicalId, null);
  assert.equal(unknown.graph.node.id, "model.unknown.not.real.model");
  assert.deepEqual(unknown.graph.edges, []);
});

test("listModelLabels returns requested labels in order", () => {
  const labels = listModelLabels(["claude", "qwen3.5"]);

  assert.deepEqual(labels.map((label) => label.canonicalId), ["claude-opus", "qwen3.5"]);
});
