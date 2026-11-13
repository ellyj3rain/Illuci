/**
 * illuci/core/mcp/crucible-tools.test.js — the cross-harness crucible illuci-binding (node:test, hermetic)
 *
 * Exercises the illuci-side binding of the crucible decision-elicitation discipline:
 *   - the harness-neutral discipline (classify routing + the recommend-first invariant);
 *   - crucible_classify_v1 (read-shaped: returns a routing verdict + the recursion obligation, no surface);
 *   - crucible_elicit_v1 (binds the discipline to illuci's operator-decision surface via ctx.elicit):
 *       · fail-closed on no surface / decline / cancel (no fabricated choice);
 *       · recommendation-first render + the operator-supplied "other" path;
 *       · skip-gated decisions are NOT surfaced; spectra render as a parameter; batches hand off to mass-assault.
 *   - the Claude->illuci bridge: illuci_intent_v1 dispatches an envelope to crucible_classify_v1 / crucible_elicit_v1.
 *
 * Run: ILLUCI_GATE_MODE=headless node --test illuci/core/mcp/crucible-tools.test.js < /dev/null
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ILLUCI_GATE_MODE = process.env.ILLUCI_GATE_MODE || "headless";

const { classifyDecision, normalizeOptions } = await import("../skills/crucible/crucible.discipline.js");
const { CRUCIBLE_TOOLS } = await import("./crucible-tools.js");
const { INTENT_TOOLS } = await import("./intent-tools.js");
const { startServer } = await import("./server.js");

const TOOLS = Object.fromEntries(CRUCIBLE_TOOLS.map((t) => [t.name, t]));
// Build an accepting operator surface; the rendered elicitation request is captured on ctx._last.
function acceptCtx(choice, other) {
  const ctx = { elicit: async (req) => { ctx._last = req; return { action: "accept", content: { choice, ...(other ? { other } : {}) } }; } };
  return ctx;
}

test("discipline: skip-gate routes settled / naming / trivial to skip", () => {
  assert.equal(classifyDecision({ settled: true }).route, "skip");
  assert.equal(classifyDecision({ pureNaming: true }).skip, "naming");
  assert.equal(classifyDecision({ trivial: true }).skip, "trivial");
});

test("discipline: continuum-check routes a spectrum away from discrete options", () => {
  assert.equal(classifyDecision({ spectrum: true }).route, "continuum");
});

test("discipline: shape classification (batch / architecture / tree / default point)", () => {
  assert.equal(classifyDecision({ backlogSize: 12 }).form, "batch");
  assert.equal(classifyDecision({ architectural: true }).form, "architecture");
  assert.equal(classifyDecision({ interdependent: true }).form, "tree");
  assert.equal(classifyDecision({ question: "x" }).form, "point");
  assert.equal(classifyDecision({ shape: "tree" }).form, "tree");
});

test("discipline: normalizeOptions enforces recommended-first + single-recommended + label", () => {
  const n = normalizeOptions([{ label: "A" }, { label: "B", recommended: true }, { label: "C" }]);
  assert.match(n[0].label, /B/);
  assert.equal(n[0].recommended, true);
  assert.match(n[0].label, /\(Recommended\)/);
  assert.equal(n[1].recommended, false);
  assert.equal(n[2].recommended, false);
});

test("crucible_classify_v1: read-shaped (no requiredActions), returns form + recursion obligation", async () => {
  assert.equal(TOOLS.crucible_classify_v1.requiredActions, undefined);
  const r = await TOOLS.crucible_classify_v1.handler({ question: "Adopt event-sourcing?", architectural: true });
  assert.equal(r.form, "architecture");
  assert.equal(r.recursion.mustRecurse, true);
});

test("crucible_elicit_v1: fail-closed when the host has no elicitation surface", async () => {
  const r = await TOOLS.crucible_elicit_v1.handler(
    { question: "Ship now?", options: [{ label: "Yes", recommended: true }, { label: "No" }] },
    {},
  );
  assert.equal(r.surfaced, true);
  assert.equal(r.outcome.answered, false);
});

test("crucible_elicit_v1: accept captures the choice; recommended-first is rendered", async () => {
  const ctx = acceptCtx("Yes (Recommended)");
  const r = await TOOLS.crucible_elicit_v1.handler(
    { question: "Ship now?", options: [{ label: "Yes", recommended: true }, { label: "No" }] },
    ctx,
  );
  assert.equal(r.outcome.answered, true);
  assert.equal(r.outcome.choice, "Yes (Recommended)");
  assert.equal(r.outcome.overrodeRecommendation, false);
  assert.match(ctx._last.message, /Yes \(Recommended\)/);
  assert.ok(ctx._last.requestedSchema.properties.other, "schema offers the operator-supplied 'other' path");
});

test("crucible_elicit_v1: decline and cancel both fail closed", async () => {
  for (const action of ["decline", "cancel"]) {
    const ctx = { elicit: async () => ({ action }) };
    const r = await TOOLS.crucible_elicit_v1.handler(
      { question: "Drop it?", options: [{ label: "Keep", recommended: true }, { label: "Drop" }] },
      ctx,
    );
    assert.equal(r.outcome.answered, false);
    assert.equal(r.outcome.action, action);
  }
});

test("crucible_elicit_v1: the operator-supplied 'other' path overrides + records an override", async () => {
  const ctx = acceptCtx("Keep (Recommended)", "Defer to next batch");
  const r = await TOOLS.crucible_elicit_v1.handler(
    { question: "Keep?", options: [{ label: "Keep", recommended: true }, { label: "Drop" }] },
    ctx,
  );
  assert.equal(r.outcome.viaOther, true);
  assert.equal(r.outcome.choice, "Defer to next batch");
  assert.equal(r.outcome.overrodeRecommendation, true);
});

test("crucible_elicit_v1: skip-gated decision is not surfaced", async () => {
  const r = await TOOLS.crucible_elicit_v1.handler({ question: "Already decided?", settled: true }, acceptCtx("x"));
  assert.equal(r.surfaced, false);
  assert.equal(r.skip, "settled");
});

test("crucible_elicit_v1: a spectrum renders the parameter, not a forced binary", async () => {
  const ctx = acceptCtx("balanced");
  const r = await TOOLS.crucible_elicit_v1.handler(
    { question: "How strict?", spectrum: true, parameter: { name: "strictness", range: "loose..strict", principledDefault: "balanced" } },
    ctx,
  );
  assert.equal(r.form, "continuum");
  assert.match(ctx._last.message, /strictness/);
});

test("crucible_elicit_v1: a 10+ backlog hands off to mass-assault rather than firing", async () => {
  const r = await TOOLS.crucible_elicit_v1.handler({ question: "Clear backlog", backlogSize: 15 }, acceptCtx("x"));
  assert.equal(r.surfaced, false);
  assert.match(r.handoff, /mass-assault/);
});

test("bridge: illuci_intent_v1 dispatches an envelope to the crucible verbs", async () => {
  await startServer({ tenantId: "crucible-test", transport: "stdio" }).catch(() => {});
  const intent = INTENT_TOOLS[0];

  const classifyEnv = { version: "1.0.0", subskillId: "crucible.classify", verb: "crucible_classify_v1", params: { question: "Adopt event-sourcing?", architectural: true } };
  const c = await intent.handler(classifyEnv, {});
  assert.equal(c.ok, true);
  assert.equal(c.result.form, "architecture");

  const elicitEnv = { version: "1.0.0", subskillId: "crucible.elicit", verb: "crucible_elicit_v1", params: { question: "Dark or gated?", options: [{ label: "Dark", recommended: true }, { label: "Gated" }] } };
  const e = await intent.handler(elicitEnv, acceptCtx("Dark (Recommended)"));
  assert.equal(e.ok, true);
  assert.equal(e.result.outcome.answered, true);
  assert.equal(e.result.outcome.choice, "Dark (Recommended)");
});
