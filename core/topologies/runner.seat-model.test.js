/**
 * The runner-side seat-model resolution: resolveSeatModel (lineup/selection/persona -> dispatch
 * target + reasoning + normalized runtime metadata) and buildSeatModelResource (which seats
 * receive a persona overlay).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetModelResourceCaches } from "../model-resource.js";
import { resolveSeatModel, buildSeatModelResource, peerIdsForLineup } from "./runner.js";

test("resolveSeatModel preserves a flat id/alias spelling while adding runtime provenance", () => {
  for (const model of ["claude-local", "opus", "claude-opus", "grok"]) {
    const resolved = resolveSeatModel(model, {});
    assert.equal(resolved.model, model);
    assert.deepEqual(resolved.reasoningOpts, {});
    assert.equal(resolved.dispatchOptions.modelRuntime.source, "legacy-dispatch-id");
    assert.equal(resolved.dispatchOptions.modelRuntime.requested, model);
  }
});

test("resolveSeatModel resolves a real selection tuple with canonical id, dial, and runtime", () => {
  const sonnet = resolveSeatModel("claude.sonnet.medium", {});
  assert.equal(sonnet.model, "claude-sonnet");
  assert.equal(sonnet.reasoningOpts.reasoning, "medium");
  assert.equal(sonnet.dispatchOptions.modelRuntime.modelResourceId, "model.claude.sonnet");
  assert.equal(sonnet.dispatchOptions.modelRuntime.controls.reasoning, "medium");

  const grok = resolveSeatModel("grok.grok-4.high", {});
  assert.equal(grok.reasoningOpts.reasoning, "high");
  assert.equal(grok.reasoningOpts.effort, undefined);
});

test("resolveSeatModel accepts public model-resource ids from the fleet catalog", () => {
  const glm = resolveSeatModel("model.glm.frontier", {});
  assert.equal(glm.model, "glm");
  assert.equal(glm.dispatchOptions.modelRuntime.source, "public-model-resource");
  assert.equal(glm.dispatchOptions.modelRuntime.modelResourceId, "model.glm.frontier");
  assert.equal(glm.dispatchOptions.modelRuntime.providerResourceId, "provider.ollama.cloud");
  assert.equal(glm.dispatchOptions.channel.transport, "ollama");
  assert.equal(glm.dispatchOptions.channel.model, "glm-5.2:cloud");
});

test("explicit antigravity transport is a real channel dispatch option", () => {
  resetModelResourceCaches();
  const prior = {
    normalized: process.env.ILLUCI_FLEET_NORMALIZED_ENABLED,
    channels: process.env.ILLUCI_FLEET_CHANNELS_ENABLED,
    agyPath: process.env.AGY_PATH,
  };
  const dir = mkdtempSync(join(tmpdir(), "illuci-runner-agy-"));
  const fakeAgy = join(dir, process.platform === "win32" ? "agy.exe" : "agy");
  writeFileSync(fakeAgy, "");

  delete process.env.ILLUCI_FLEET_NORMALIZED_ENABLED;
  delete process.env.ILLUCI_FLEET_CHANNELS_ENABLED;
  process.env.AGY_PATH = fakeAgy;

  try {
    const resolved = resolveSeatModel("claude.opus.high.antigravity", {});
    assert.equal(resolved.model, "claude-opus");
    assert.equal(resolved.reasoningOpts.reasoning, "high");
    assert.equal(resolved.dispatchOptions.channel.transport, "antigravity");
    assert.equal(resolved.dispatchOptions.channel.bridge, "agy.js");
    assert.equal(resolved.dispatchOptions.channel.provider, "google-antigravity");
    assert.equal(resolved.dispatchOptions.modelRuntime.providerResourceId, "provider.google.antigravity");
    assert.equal(resolved.dispatchOptions.modelRuntime.providerModel, "Claude Opus 4.6 (Thinking)");
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

test("resolveSeatModel applies a persona overlay only for the matching seat", () => {
  const withOverlay = resolveSeatModel("grok", { seat: "lead", seatModelResource: { lead: "claude.haiku" } });
  assert.equal(withOverlay.model, "claude-haiku");

  const noOverlay = resolveSeatModel("grok", { seat: "lead", seatModelResource: {} });
  assert.equal(noOverlay.model, "grok");
  assert.deepEqual(noOverlay.reasoningOpts, {});

  const noSeatOverlay = resolveSeatModel("grok", { seat: "lead" });
  assert.equal(noSeatOverlay.model, "grok");
  assert.deepEqual(noSeatOverlay.reasoningOpts, {});
});

test("resolveSeatModel falls back when a persona overlay is unresolvable", () => {
  const r = resolveSeatModel("grok", { seat: "lead", seatModelResource: { lead: "not-a-real-model-xyz" } });
  assert.equal(r.model, "not-a-real-model-xyz");
  assert.deepEqual(r.reasoningOpts, {});
});

test("peerIdsForLineup resolves object selections without object-coercion leaks", () => {
  const peers = peerIdsForLineup({
    lead: [{ family: "gpt", reasoning: "high", transport: "ollama" }],
    review: ["deepseek", { id: "qwen3.5", reasoning: "high" }],
    fallback: [{ family: "not-a-real-family", reasoning: "high", transport: "ollama" }],
  });

  assert.deepEqual(peers, ["gpt-oss", "deepseek", "qwen3.5", "not-a-real-family.high.ollama"]);
  assert.equal(peers.some((peer) => peer.includes("[object Object]")), false);
});

test("resolveSeatModel falls back to a stable label (never [object Object]) for an unresolvable object selection", () => {
  // The catch path must not String()-coerce a selection OBJECT — that yields "[object Object]"
  // and leaks into the seat's own "Model:" governance line. It must use the same stable label as
  // the peer roster so the seat self-id and the roster id agree for an unresolved selection.
  const selection = { family: "not-a-real-family", reasoning: "high", transport: "ollama" };
  const r = resolveSeatModel(selection, {});
  assert.equal(r.model, "not-a-real-family.high.ollama");
  assert.equal(r.model.includes("[object Object]"), false);
  assert.deepEqual(r.reasoningOpts, {});

  const [peer] = peerIdsForLineup({ seat: [selection] });
  assert.equal(r.model, peer);
});

test("buildSeatModelResource: an unpinned seat receives the persona overlay", () => {
  assert.deepEqual(
    buildSeatModelResource({ lead: { modelResource: "claude.sonnet.medium" } }, {}, {}),
    { lead: "claude.sonnet.medium" }
  );
});

test("buildSeatModelResource: an explicit ORG lineup pin is sovereign", () => {
  assert.deepEqual(
    buildSeatModelResource({ lead: { modelResource: "claude.sonnet.medium" } }, {}, { lead: "grok" }),
    {}
  );
});

test("buildSeatModelResource: an explicit CALLER lineup pin is sovereign", () => {
  assert.deepEqual(
    buildSeatModelResource({ lead: { modelResource: "claude.sonnet.medium" } }, { lead: "grok" }, {}),
    {}
  );
});

test("buildSeatModelResource: only the pinned seat is excluded; other seats still get the overlay", () => {
  assert.deepEqual(
    buildSeatModelResource(
      { lead: { modelResource: "claude.opus" }, aide: { modelResource: "grok" } },
      {}, { lead: "kimi-cloud" }
    ),
    { aide: "grok" }
  );
});

test("buildSeatModelResource: greenfield no-ops", () => {
  assert.deepEqual(buildSeatModelResource(null, {}, {}), {});
  assert.deepEqual(buildSeatModelResource({ lead: { agentSlug: "x" } }, {}, {}), {});
});
