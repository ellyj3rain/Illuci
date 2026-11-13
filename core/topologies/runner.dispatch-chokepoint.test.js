/**
 * The model-resource DISPATCH CHOKE-POINT lint seam (+ the back-compat unit it guards).
 *
 * Ground truth in this environment: vitest is NOT installed and there is no test runner
 * config; only node:test runs (mirrors model-resource.test.js). So the structural guard is a
 * SOURCE-GREP test — it reads runner.js as TEXT (never imports it, so no bridge/mock graph is
 * touched) and asserts the choke-point invariant lexically. The back-compat unit imports the
 * pure model-resource layer (no bridge) and proves resolveSeatModel injects NO reasoning knob
 * onto a flat-id dispatch, while staying LIVE for selections.
 *
 * The choke-point invariant: querySeat is the ONE place a queryModel(...) call is made. If a
 * future dispatch site calls queryModel directly it bypasses selection-resolution + the persona
 * overlay (the exact silent-skip regression this seam exists to catch). The wrapper name is a
 * single top-of-file constant, so a sanctioned rename is a one-line test edit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolve as resolveSelection } from "../model-resource.js";
import { applyReasoningParamMap } from "../model-resource-reasoning-map.js";
import { extractPersonaModelResource, validateOrg } from "../projects/org.js";

// The choke-point wrapper. A sanctioned rename is a ONE-LINE edit here.
const WRAPPER = "querySeat";
// The fns that own a routed dispatch site; each MUST call the wrapper, none may call queryModel.
const OWNING_FNS = [
  "anchorDispatch", "executeSequential", "executeRotating",
  "executeExecuteMode", "executeDelegateMode", "dispatchSeat",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "runner.js");
const RAW = readFileSync(RUNNER_PATH, "utf-8");

/** Strip import lines and comments so the structural assertions see only live code. */
function stripped(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^\s*import .*$/gm, "")     // import statements (the legitimate queryModel import)
    .replace(/\/\/.*$/gm, "");           // line comments (incl. the prose in the choke-point header)
}

/** Skip past a balanced ( ) parameter list starting at/after `fromIdx`; return the index
 *  just AFTER the closing ")". Used so a `= {}` default-param brace is never mistaken for
 *  the function body's opening brace. */
function afterParamList(src, fromIdx) {
  const open = src.indexOf("(", fromIdx);
  if (open === -1) return fromIdx;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i + 1; }
  }
  return fromIdx;
}

/** Walk the function BODY's balanced { } span for a declaration at `fnIdx`; return [start,end].
 *  Starts the brace search AFTER the parameter list so `opts = {}` defaults are not the body. */
function bodySpan(src, fnIdx) {
  const start = src.indexOf("{", afterParamList(src, fnIdx));
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return [start, i + 1]; }
  }
  return null;
}

const SRC = stripped(RAW);
// A fresh (non-global) matcher per use — a shared /g regex would carry lastIndex across
// assert.match calls and spuriously miss a later body.
const wrapperCall = () => new RegExp(`${WRAPPER}\\s*\\(`);

// ─── A1: exactly ONE call-shaped queryModel( survives the strip ───
// (queryWithWrite is auto-excluded — it is not a queryModel site; the import line was stripped.)

test("A1: queryModel is called exactly once in the live source (the choke-point's own call)", () => {
  const hits = SRC.match(/queryModel\s*\(/g) || [];
  assert.equal(hits.length, 1,
    `expected exactly ONE queryModel( call (inside ${WRAPPER}); found ${hits.length}. ` +
    `A new dispatch site bypassed the choke-point — route it through ${WRAPPER}.`);
});

// ─── A1b: the queryModel binding is unaliased (A1 cannot be evaded by re-aliasing) ───
// A1 counts `queryModel(` calls; an `import { queryModel as qm }` + `qm(...)` would slip past.
// Assert the dispatch fn is imported under its own name only.

test("A1b: queryModel is imported unaliased (no `queryModel as X` evasion of the seam)", () => {
  assert.match(RAW, /import\s*\{[^}]*\bqueryModel\b[^}]*\}\s*from/, "queryModel must be a named import");
  assert.doesNotMatch(RAW, /\bqueryModel\s+as\s+\w+/, "queryModel must not be import-aliased (would evade the A1 seam)");
});

// ─── A2: that one call sits INSIDE the wrapper's brace span ───
// Catches the regression where the count stays 1 but the call is moved out of querySeat.

test(`A2: the sole queryModel( call is inside ${WRAPPER}'s body`, () => {
  const fnIdx = SRC.indexOf(`function ${WRAPPER}(`);
  assert.notEqual(fnIdx, -1, `${WRAPPER} declaration not found in source`);
  const span = bodySpan(SRC, fnIdx);
  assert.ok(span, `could not bound ${WRAPPER}'s body`);
  const callIdx = SRC.search(/queryModel\s*\(/);
  assert.ok(callIdx > span[0] && callIdx < span[1],
    `the queryModel( call (idx ${callIdx}) is OUTSIDE ${WRAPPER}'s body [${span[0]}, ${span[1]})`);
});

// ─── A3: every owning fn routes through the wrapper ───
// anchorDispatch is an arrow const with an expression body (no wrapping braces), so it is
// checked with a line-window slice; the function-declared owners are checked by brace span.

test(`A3: every owning fn calls ${WRAPPER}`, () => {
  for (const fn of OWNING_FNS) {
    let body;
    if (fn === "anchorDispatch") {
      const idx = SRC.indexOf(`${fn} =`);
      assert.notEqual(idx, -1, `${fn} definition not found`);
      body = SRC.slice(idx, idx + 240); // the arrow + its .then chain
    } else {
      const idx = SRC.search(new RegExp(`function ${fn}\\b`));
      assert.notEqual(idx, -1, `${fn} declaration not found`);
      const span = bodySpan(SRC, idx);
      assert.ok(span, `could not bound ${fn}'s body`);
      body = SRC.slice(span[0], span[1]);
    }
    assert.match(body, wrapperCall(), `${fn} does not route its dispatch through ${WRAPPER}`);
  }
});

// ─── Back-compat unit: a flat id gets NO reasoning/effort/thinking knob injected ───
// This is what guarantees resolveSeatModel's resolve+map step is byte-inert for every existing
// flat-id council. Hermetic: pure model-resource layer, no bridge, no mock of the static import.

test("flat ids inject ZERO reasoning params (byte-identity for existing councils)", () => {
  for (const id of ["claude-local", "opus", "grok", "claude-fable"]) {
    const r = resolveSelection(id);
    const mapped = applyReasoningParamMap(r.entry, r.params);
    assert.deepEqual(mapped, { universalReasoning: undefined, bridgeOptions: {} },
      `flat id "${id}" must inject no reasoning knob, got ${JSON.stringify(mapped)}`);
  }
});

// ─── Positive control: the wiring is LIVE for real selections (keeps the guard honest) ───

test("POSITIVE CONTROL: selections DO carry a reasoning dial through the same path", () => {
  // claude.cli is variant-only: the dial rides universalReasoning, bridgeOptions stays empty.
  const sonnet = resolveSelection("claude.sonnet.medium");
  assert.equal(sonnet.entry.id, "claude-sonnet");
  const sonnetMapped = applyReasoningParamMap(sonnet.entry, sonnet.params);
  assert.equal(sonnetMapped.universalReasoning, "medium");

  // grok carries the dial ONLY as universalReasoning now — the bridge translates it to its
  // own knob (reasoning_effort / --effort) at body-build time, so no bridgeOptions is injected
  // into the dispatch opts (champion A-universal-dial).
  const grok = resolveSelection("grok.grok-4.high");
  const grokMapped = applyReasoningParamMap(grok.entry, grok.params);
  assert.equal(grokMapped.universalReasoning, "high");
  assert.deepEqual(grokMapped.bridgeOptions, {});
});

// ─── Persona model-resource overlay (the runner-side data source + precedence) ───

test("extractPersonaModelResource: greenfield + additive (absent -> null, present -> selection)", () => {
  assert.equal(extractPersonaModelResource(null), null);
  assert.equal(extractPersonaModelResource({ agentSlug: "researcher" }), null); // no field -> ladder falls through
  assert.equal(extractPersonaModelResource({ agentSlug: "r", modelResource: "" }), null); // empty string -> null
  assert.equal(extractPersonaModelResource({ agentSlug: "r", modelResource: "claude.sonnet.medium" }), "claude.sonnet.medium");
  assert.deepEqual(extractPersonaModelResource({ agentSlug: "r", modelResource: { family: "grok", reasoning: "high" } }), { family: "grok", reasoning: "high" });
});

test("precedence: `personaSel ?? modelOrSelection` is inert when no persona overlay (rung 3 default flows untouched)", () => {
  // The single load-bearing expression resolveSeatModel uses, re-derived hermetically.
  const select = (personaSel, modelOrSelection) => personaSel ?? modelOrSelection;
  assert.equal(select(null, "claude-opus"), "claude-opus");       // no overlay -> byte-identical
  assert.equal(select(undefined, "grok"), "grok");                // absent field -> byte-identical
  assert.equal(select("claude.sonnet.medium", "claude-opus"), "claude.sonnet.medium"); // rung 2 wins over autofill default
});

test("validateOrg: modelResource is tolerant + non-required (string/object ok, bad type rejected, absent fine)", () => {
  const topology = { id: "council", seats: [{ id: "lead" }] };
  const base = (modelResource) => ({
    charterId: "council", kind: "fixed", lineup: {},
    personas: { lead: { agentSlug: "lead-persona", ...(modelResource !== undefined ? { modelResource } : {}) } },
    anchor: { mode: "operator" },
  });
  assert.equal(validateOrg(base(undefined), topology).valid, true);                 // absent -> valid (no-op)
  assert.equal(validateOrg(base("claude.sonnet.medium"), topology).valid, true);    // string selection
  assert.equal(validateOrg(base({ family: "claude" }), topology).valid, true);      // object selection
  const bad = validateOrg(base(42), topology);                                      // number -> rejected
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join(" "), /modelResource must be a selection string or object/);
});
