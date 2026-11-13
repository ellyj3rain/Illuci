/**
 * illuci — Capability Spine: no-drift invariants (node:test)
 *
 * Front 4 (capability re-home) seeds a deep-cloned, deep-frozen capability
 * descriptor per registered model and serves it from getCapabilities. These
 * tests lock the contract that the SEEDED served descriptor can NEVER drift
 * from a fresh computeCapabilities, that alias spellings keep getting the
 * canonical descriptor with the raw .modelId stamped, that the long-standing
 * `reasoningDefault === undefined` quirk budget.js relies on is preserved, and
 * that unknown ids still degrade to the minimal safe descriptor.
 *
 * Run: node --test illuci/core/bridges/capabilities-no-drift.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getCapabilities, _computeCapabilitiesForTest as computeCapabilities } from "./capabilities.js";
import { listModelIds } from "./model-registry.js";

test("served descriptor never drifts from a fresh computation, for every registered id", () => {
  for (const id of listModelIds()) {
    assert.deepEqual(
      getCapabilities(id),
      computeCapabilities(id),
      `drift between seeded getCapabilities and computeCapabilities for "${id}"`,
    );
  }
});

test("alias spellings get the canonical descriptor with the raw .modelId stamped", () => {
  const aliases = ["claude-local", "fable", "claude", "anthropic", "glm-5:cloud", "agy", "gemini-pro"];
  for (const alias of aliases) {
    const viaAlias = getCapabilities(alias);
    // The raw spelling is stamped verbatim (byte-identical with the legacy stamp).
    assert.equal(viaAlias.modelId, alias, `modelId not stamped to raw spelling for "${alias}"`);

    // Everything else equals the canonical descriptor minus its modelId.
    const canonical = computeCapabilities(alias); // computeCapabilities canonicalizes internally
    const { modelId: _aliasModelId, ...aliasRest } = viaAlias;
    const { modelId: _canonModelId, ...canonRest } = canonical;
    assert.deepEqual(aliasRest, canonRest, `descriptor body diverged for alias "${alias}"`);
  }
});

test("reasoningDefault is undefined on every served descriptor (pre-existing quirk budget.js relies on)", () => {
  for (const id of listModelIds()) {
    assert.equal(
      getCapabilities(id).reasoningDefault,
      undefined,
      `reasoningDefault leaked onto the descriptor for "${id}"`,
    );
  }
});

test("unknown ids degrade to the minimal safe descriptor (matches computeCapabilities, never throws)", () => {
  const unknown = "no-such-model-zzz";
  const cap = getCapabilities(unknown);
  assert.equal(cap.known, false);
  assert.deepEqual(cap, computeCapabilities(unknown));
});
