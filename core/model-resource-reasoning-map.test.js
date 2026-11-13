/**
 * The reasoning map RETIRED-AS-TRANSLATOR (champion "A-universal-dial", 2026-06-17).
 *
 * applyReasoningParamMap no longer injects a per-provider knob: the dial rides ONLY as
 * options.reasoning (universalReasoning), and bridgeOptions is ALWAYS empty — each bridge
 * translates the live dial to its own param at body-build time via illuci/core/reasoning/dial.js.
 * These tests pin the new dial-only output and the (unchanged) flat-id choke-point contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReasoningParamMap } from "./model-resource-reasoning-map.js";

test("the dial rides on universalReasoning; bridgeOptions is always empty (per-provider knob moved to the bridges)", () => {
  // a set dial -> carried through on universalReasoning, no second knob injected
  const grok = applyReasoningParamMap({ family: "grok", transport: "grok-build" }, { reasoning: "high" });
  assert.equal(grok.universalReasoning, "high");
  assert.deepEqual(grok.bridgeOptions, {});

  const api = applyReasoningParamMap({ family: "claude", transport: "api" }, { reasoning: "xhigh" });
  assert.equal(api.universalReasoning, "xhigh");
  assert.deepEqual(api.bridgeOptions, {});

  const off = applyReasoningParamMap({ family: "claude", transport: "api" }, { reasoning: "off" });
  assert.equal(off.universalReasoning, "off");
  assert.deepEqual(off.bridgeOptions, {});

  const ds = applyReasoningParamMap({ family: "deepseek", transport: "ollama-cloud" }, { reasoning: "high" });
  assert.equal(ds.universalReasoning, "high");
  assert.deepEqual(ds.bridgeOptions, {});
});

test("case 5: claude CLI is variant-only — the dial still rides universalReasoning, never a knob", () => {
  const r = applyReasoningParamMap({ family: "claude", transport: "cli" }, { reasoning: "high" });
  assert.deepEqual(r.bridgeOptions, {});       // no knob injected (and never a variant)
  assert.equal(r.universalReasoning, "high");  // kept on options.reasoning for the bridges + adaptive path
});

test("case 7: no dial leaks no field; the result shape is stable for any entry", () => {
  assert.deepEqual(applyReasoningParamMap({ family: "claude", transport: "cli" }, {}), { universalReasoning: undefined, bridgeOptions: {} });
  assert.deepEqual(applyReasoningParamMap({ family: "deepseek", transport: "ollama-cloud" }, { reasoning: null }), { universalReasoning: undefined, bridgeOptions: {} });
  assert.deepEqual(applyReasoningParamMap({ family: "grok", transport: "api" }, { reasoning: "" }), { universalReasoning: undefined, bridgeOptions: {} });
});

test("CHOKE-POINT CONTRACT: empty params -> {universalReasoning:undefined, bridgeOptions:{}} (resolveSeatModel reasoningOpts={})", () => {
  // The runner's resolveSeatModel reads only universalReasoning now; for a flat id params={},
  // so the result MUST be the empty shape -> reasoningOpts={} -> queryModel(flatId, msg, {...opts}).
  for (const entry of [
    { family: "claude", transport: "cli" },
    { family: "grok", transport: "grok-build" },
    { family: "deepseek", transport: "ollama-cloud" },
  ]) {
    assert.deepEqual(applyReasoningParamMap(entry, {}), { universalReasoning: undefined, bridgeOptions: {} });
  }
});
