/**
 * illuci — Mandate + Seat Frame tests (node:test)
 *
 * M1 of the orchestration reconception. Proves the operator anchor is a
 * structural property of every framed dispatch: the verbatim operator request
 * is the FIRST block, the seat is rendered as a subordinate lens with the
 * escape clause, and the [Task] no longer carries (or can erase) the ask.
 *
 * Run: node --test illuci/core/topologies/mandate.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMandate, reviseMandate, renderMandateBlock } from "./mandate.js";
import { composeSeatFrame, renderSeatLens, buildSeatLabels } from "./frame.js";

const PROMPT = "Refactor the auth module to use the new token service.";

test("buildMandate requires a verbatim prompt and preserves it immutably", () => {
  assert.throws(() => buildMandate({ prompt: "" }), /verbatim operator prompt/);
  const m = buildMandate({ prompt: PROMPT, operator: "Example" });
  assert.equal(m.intent.raw, PROMPT);
  assert.equal(m.intent.revision, 1);
  assert.equal(m.operator.name, "Example");
});

test("renderMandateBlock puts operator identity + verbatim ask first", () => {
  const m = buildMandate({ prompt: PROMPT, operator: "Example" });
  const block = renderMandateBlock(m);
  assert.ok(block.startsWith("[Mandate]"));
  assert.match(block, /You serve Example/);
  assert.ok(block.includes(PROMPT), "verbatim ask present");
});

test("reviseMandate bumps revision and surfaces the revision marker", () => {
  const m1 = buildMandate({ prompt: PROMPT });
  const m2 = reviseMandate(m1, "Actually, just add tests for it.");
  assert.equal(m2.intent.revision, 2);
  assert.equal(m1.intent.revision, 1, "original is not mutated");
  assert.match(renderMandateBlock(m2), /revised ×2/);
  assert.ok(renderMandateBlock(m2).includes("Actually, just add tests"));
});

test("renderSeatLens renders edges as addressed relationships + the escape clause", () => {
  const seatDef = {
    id: "arbiter", label: "Arbiter",
    relationships: [{ type: "integrates-from", target: "red" }, { type: "integrates-from", target: "blue" }],
  };
  const labels = new Map([["red", "Red Team"], ["blue", "Blue Team"]]);
  const lens = renderSeatLens(seatDef, labels);
  assert.ok(lens.startsWith("[Seat lens]"));
  assert.match(lens, /you sit as the "Arbiter"/);
  assert.match(lens, /integrate the work of Red Team/);
  assert.match(lens, /integrate the work of Blue Team/);
  // the load-bearing collaborator-first escape clause
  assert.match(lens, /the mandate wins/);
  assert.match(lens, /does not limit your competence/);
});

test("composeSeatFrame: mandate FIRST, then lens, then cognitive classifier, then disposition, then task", () => {
  const m = buildMandate({ prompt: PROMPT, operator: "Example" });
  const seatDef = { id: "red", label: "Red Team", relationships: [{ type: "adversarial-to", target: "blue" }] };
  const labels = new Map([["blue", "Blue Team"]]);
  const msg = composeSeatFrame({
    mandate: m, seatDef, seatLabels: labels,
    cognitiveBlock: "[Cognitive Classifier]\nDecision posture: proceed.",
    dispositionBlock: "[Behavioral Disposition]\nhigh skepticism",
    task: "Open the debate with your strongest position.",
    modeSuffix: "",
    injections: [],
  });
  const iMandate = msg.indexOf("[Mandate]");
  const iLens = msg.indexOf("[Seat lens]");
  const iCognitive = msg.indexOf("[Cognitive Classifier]");
  const iDisp = msg.indexOf("[Behavioral Disposition]");
  const iTask = msg.indexOf("[Task]");
  assert.equal(iMandate, 0, "mandate is the first block");
  assert.ok(iMandate < iLens && iLens < iCognitive && iCognitive < iDisp && iDisp < iTask, "fixed block order holds");
  assert.ok(msg.includes(PROMPT), "operator ask present even though the task is something else");
  assert.match(msg, /\[Task\]\nOpen the debate/);
});

test("the [Task] body no longer carries the operator ask — the regression that motivated M1", () => {
  // Simulate a later phase whose resolved input is ONLY prior-phase output (the
  // 'phase:opening' case that erased the operator today). The ask must still reach the seat.
  const m = buildMandate({ prompt: PROMPT });
  const seatDef = { id: "arbiter", label: "Arbiter", relationships: [] };
  const msg = composeSeatFrame({
    mandate: m, seatDef, task: "[Red Team]: ...\n\n[Blue Team]: ...", // prior outputs only
  });
  assert.ok(msg.includes(PROMPT), "operator ask survives via the mandate even when the task is only prior outputs");
});

test("includeLens=false still carries the mandate (auxiliary dispatches)", () => {
  const m = buildMandate({ prompt: PROMPT });
  const msg = composeSeatFrame({ mandate: m, includeLens: false, task: "Merge the contributions." });
  assert.ok(msg.startsWith("[Mandate]"));
  assert.ok(!msg.includes("[Seat lens]"));
});

test("buildSeatLabels maps a topology's seats to labels", () => {
  const topo = { seats: [{ id: "red", label: "Red Team" }, { id: "arbiter", label: "Arbiter" }] };
  const labels = buildSeatLabels(topo);
  assert.equal(labels.get("red"), "Red Team");
  assert.equal(labels.get("arbiter"), "Arbiter");
});
