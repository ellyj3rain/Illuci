import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_REGISTRY, buildModelDefaults } from "./model-registry.js";

// P4 first increment (DR-134): identities gain an optional channels[] array.
// The emperor's binding condition from the colosseum dogfood: channels[] is opt-in
// and ABSENT (not []) on single-transport rows; byte-identity proven dark-off.
const MULTI = ["gpt-oss", "claude-opus", "claude-sonnet"];

test("channels: ONLY the declared multi-channel identities carry channels[] (absent, not [], elsewhere)", () => {
  for (const m of MODEL_REGISTRY) {
    if (MULTI.includes(m.id)) {
      assert.ok(Array.isArray(m.channels), `${m.id} should have channels[]`);
      assert.ok(m.channels.length >= 2, `${m.id} should declare >= 2 channels`);
    } else {
      assert.equal("channels" in m, false, `${m.id} must NOT have a channels key (absent, not [])`);
    }
  }
});

test("channels: channels[0] mirrors the row's primary transport/model (byte-compat primary)", () => {
  for (const id of MULTI) {
    const row = MODEL_REGISTRY.find((m) => m.id === id);
    assert.equal(row.channels[0].transport, row.transport, `${id}: channels[0] must mirror top-level transport`);
    assert.equal(row.channels[0].model, row.model, `${id}: channels[0] must mirror top-level model`);
    assert.ok(row.channels.some((c) => c.transport === "antigravity"), `${id}: should carry an agy/antigravity channel`);
    for (const c of row.channels) {
      for (const k of ["transport", "bridge", "provider", "auth", "model"]) {
        assert.ok(c[k], `${id}: channel missing ${k}`);
      }
    }
  }
});

test("channels: byte-identical — channels never leak into buildModelDefaults (dispatch unaffected)", () => {
  const defs = buildModelDefaults();
  for (const [id, d] of Object.entries(defs)) {
    assert.equal("channels" in d, false, `${id}: MODEL_DEFAULTS must not carry channels`);
  }
});
