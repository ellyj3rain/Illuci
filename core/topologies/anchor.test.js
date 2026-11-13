/**
 * illuci — Conducted Anchor tests (node:test, hermetic — fake dispatch, no LLM)
 *
 * M4b acceptance: a delegated anchor proposes an agenda within the charter
 * bounds (DR-110); out-of-bounds proposals are rejected and the run falls back
 * (conducted → derived → ritual), never stranded, never widening permissions.
 *
 * Run: node --test illuci/core/topologies/anchor.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { planAgenda, validateAgenda, defaultAnchorModel } from "./anchor.js";
import { getTopology } from "./index.js";
import { buildMandate } from "./mandate.js";

const DEBATE = getTopology("adversarial-debate");
const M = buildMandate({ prompt: "Decide the database." });
const fakeDispatch = (json) => async () => json;

test("validateAgenda accepts a charter-valid plan and normalizes it", () => {
  const plan = { brief: "pick a db", plan: [
    { id: "open", type: "parallel", seats: ["red", "blue"], input: "prompt" },
    { id: "rule", type: "single", seat: "arbiter", input: "phase:open" },
  ]};
  const r = validateAgenda(plan, DEBATE);
  assert.equal(r.valid, true);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[1].seat, "arbiter");
});

test("AUTHORITY BOUND: a seat not in the charter is rejected (cannot invent seats)", () => {
  const plan = { plan: [
    { id: "open", type: "single", seat: "red", input: "prompt" },
    { id: "pwn", type: "single", seat: "hacker", input: "prompt" }, // not in charter
  ]};
  const r = validateAgenda(plan, DEBATE);
  assert.ok(r.errors.some((e) => /not in charter/.test(e)));
  // the valid step survives, the out-of-bounds one is dropped
  assert.deepEqual(r.steps.map((s) => s.seat), ["red"]);
  assert.equal(r.valid, false);
});

test("AUTHORITY BOUND: input referencing a non-prior step is rejected", () => {
  const plan = { plan: [{ id: "rule", type: "single", seat: "arbiter", input: "phase:nonexistent" }] };
  const r = validateAgenda(plan, DEBATE);
  assert.ok(r.errors.some((e) => /does not resolve/.test(e)));
  assert.equal(r.steps.length, 0);
});

test("planAgenda: a valid anchor plan yields conducted mode + brief", async () => {
  const json = JSON.stringify({ brief: "choose postgres vs sqlite for OTL", plan: [
    { id: "frame", type: "single", seat: "arbiter", input: "prompt" },
    { id: "argue", type: "parallel", seats: ["red", "blue"], input: "prompt+phase:frame" },
    { id: "rule", type: "single", seat: "arbiter", input: "phase:argue" },
  ]});
  const a = await planAgenda({ topology: DEBATE, mandate: M, anchorModelId: "deepseek", dispatch: fakeDispatch(json) });
  assert.equal(a.mode, "conducted");
  assert.equal(a.fallback, false);
  assert.equal(a.brief, "choose postgres vs sqlite for OTL");
  assert.equal(a.steps.length, 3);
  assert.equal(a.steps[0].seat, "arbiter", "the anchor chose to let the arbiter FRAME first — order from the task, not array index");
});

test("planAgenda: garbage from the anchor falls back to derived, recorded", async () => {
  const a = await planAgenda({ topology: DEBATE, mandate: M, anchorModelId: "deepseek", dispatch: fakeDispatch("I cannot help with that.") });
  assert.equal(a.fallback, true);
  assert.match(a.rationale, /conducted unavailable/);
  // adversarial-debate IS derivable, so the fallback is derived (not ritual)
  assert.equal(a.mode, "derived");
});

test("planAgenda: no dispatch / no anchor model → fallback (operator-anchored default)", async () => {
  const a = await planAgenda({ topology: DEBATE, mandate: M, anchorModelId: null, dispatch: null });
  assert.equal(a.fallback, true);
  assert.ok(a.steps.length > 0);
});

test("planAgenda: a fully out-of-bounds plan (all invalid seats) falls back, never strands", async () => {
  const json = JSON.stringify({ plan: [{ id: "x", type: "single", seat: "ghost", input: "prompt" }] });
  const a = await planAgenda({ topology: DEBATE, mandate: M, anchorModelId: "deepseek", dispatch: fakeDispatch(json) });
  assert.equal(a.fallback, true);
  assert.ok(a.steps.length > 0, "a valid plan is always produced (derived/ritual)");
});

// ─── [A17.6] The topology-derived default anchor (DR-114 run-start T) ──────────

test("A17.6: the first seat of the first authored phase plans first", () => {
  // adversarial-debate's first phase is parallel over [red, blue] — red plans.
  const anchor = defaultAnchorModel(DEBATE, { red: ["deepseek"], blue: ["kimi"], arbiter: ["qwen"] });
  assert.equal(anchor, "deepseek");
});

test("A17.6: a seat without a lineup entry is passed over (next candidate plans)", () => {
  const anchor = defaultAnchorModel(DEBATE, { blue: ["kimi"], arbiter: ["qwen"] });
  assert.equal(anchor, "kimi");
});

test("A17.6: an object-form model selection passes through untouched (querySeat resolves it)", () => {
  const selection = { family: "claude", variant: "sonnet", reasoning: "medium" };
  const anchor = defaultAnchorModel(DEBATE, { red: [selection] });
  assert.equal(anchor, selection);
});

test("A17.6: declared seat order is the fallback when phases name no seats; null when no one resolves", () => {
  const phaseless = { phases: [], seats: [{ id: "solo" }] };
  assert.equal(defaultAnchorModel(phaseless, { solo: "grok" }), "grok");
  assert.equal(defaultAnchorModel(phaseless, {}), null);
  assert.equal(defaultAnchorModel({}, {}), null);
  assert.doesNotThrow(() => defaultAnchorModel(undefined, undefined));
});

// ─── [A17.6] Runner wiring contract (lexical, mirrors the AMD-8 source-grep guard) ─

test("A17.6: conducted is the runner's DEFAULT agenda disposition, with the topology-derived anchor rung", () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "runner.js"), "utf-8");
  const LIVE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(LIVE, /runControlAgendaMode\(\s*runControl\s*\)/,
    "conducted must be the default agenda disposition (run-start T)");
  assert.match(LIVE, /defaultAnchorModel\(\s*topology\s*,\s*normalized\s*\)/,
    "the anchor ladder must end at the topology-derived default");
  // The caller and org rungs stay ahead of the topology-derived rung.
  const ladder = LIVE.match(/const anchorModelId\s*=([\s\S]*?);/);
  assert.ok(ladder, "the anchor ladder must exist");
  const callerIdx = ladder[1].indexOf("options.anchor");
  const orgIdx = ladder[1].indexOf("orgApplies");
  const topoIdx = ladder[1].indexOf("defaultAnchorModel");
  assert.ok(callerIdx > -1 && orgIdx > callerIdx && topoIdx > orgIdx,
    "precedence must read caller → org → topology-derived");
});
