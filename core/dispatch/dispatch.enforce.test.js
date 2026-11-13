/**
 * illuci — Dispatch-path enforcement wiring tests (Phase 6, node:test)
 *
 * dispatch.js's bridges shell out to CLIs/HTTP, so (like runner.dispatch-chokepoint)
 * the structural guarantees are proven by a SOURCE-GREP test — dispatch.js is read as
 * TEXT (never imported, so no bridge graph is touched) and the wiring invariants are
 * asserted lexically. The behavioral semantics of the spine are unit-tested in
 * governance/enforce.test.js (hermetic, no bridge); this file guards the CALL SITES.
 *
 * Invariants guarded:
 *   1. Both choke points (queryModel inner + queryModelStream) call enforceDispatch
 *      BEFORE acquireSlot — the fail-closed policy check runs before bridge.query.
 *   2. The CARRIED mandate is unconditional — the old seat-guarded mandatePrefix block
 *      is GONE; carryMandate is the one mandate path; the `options.seat` guard on the
 *      mandate is removed (no `options.mandate && options.seat` co-occurrence).
 *   3. injectGovernance still receives `raw: options.raw` (the verbose preamble stays
 *      raw-gated — raw keeps its preamble-skip).
 *   4. The SOFT pass is fire-and-forget (verifyDispatchSoft is never awaited).
 *
 * Run: node --test illuci/core/dispatch/dispatch.enforce.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildDispatchBillContext, queryModel, queryModelStream } from "./dispatch.js";
import { enforceDispatchBill } from "../governance/enforcement/enforce.js";
import { scaffold } from "../skills/library.js";
import { DISPATCH_TOOLS } from "../mcp/dispatch-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "dispatch.js"), "utf-8");

// Strip comments so prose mentioning "mandate"/"seat" can't satisfy a structural assert.
function stripped(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const LIVE = stripped(SRC);

const creationDecision = () => ({
  action: "create", record: "work-record:needed-capability", requirement: "persist a new owned capability",
  existingSystem: { surfaces: [{ surface: "existing-owner-surface", revision: "reviewed-revision",
    owner: "current-owner", responsibilities: "read current state", contracts: "read-only input and result",
    demonstratedBehavior: "observed read succeeds; persistence contract absent", adequate: false,
    reason: "existing read contract cannot own persistent mutation" }] },
  gap: "persistent mutation owner", boundary: "bounded mutation contract", owner: "selected-existing-department",
});

test("creation decision: actual Bill refuses missing analysis and adequate existing responsibility", async () => {
  for (const options of [
    { consequentialAddition: true },
    { creationDecision: { action: "create" } },
    { creationDecision: { ...creationDecision(), existingSystem: { surfaces: [
      { ...creationDecision().existingSystem.surfaces[0], adequate: true },
    ] } } },
    { creationDecision: { ...creationDecision(), gap: "" } },
  ]) {
    const context = buildDispatchBillContext(options);
    assert.equal(context.consequential_addition, true);
    const result = await enforceDispatchBill(context);
    assert.equal(result.ok, false);
    assert.ok(result.blocking.some((finding) => finding.obligation === "std-14.modularity.creation-fit"));
  }
  assert.equal((await enforceDispatchBill({ consequential_addition: true })).ok, false,
    "missing facts on an actual creation cannot make the gate inapplicable");
});

test("creation decision: justified creation passes actual scope consumer; routine work remains usable", async () => {
  const context = buildDispatchBillContext({ mandate: { creationDecision: creationDecision() } });
  assert.equal(context.existing_fit_analysis_recorded, true);
  assert.equal(context.existing_responsibilities_insufficient, true);
  assert.equal((await enforceDispatchBill(context)).ok, true);
  for (const action of ["reuse", "repair", "assess", "delegate"]) {
    const ordinary = buildDispatchBillContext({ creationDecision: { action } });
    assert.equal(ordinary.consequential_addition, false);
    assert.equal((await enforceDispatchBill(ordinary)).ok, true);
  }
  assert.equal((await enforceDispatchBill(buildDispatchBillContext({}))).ok, true);
});

test("creation decision: raw and predicate fragments cannot erase selected creation applicability", async () => {
  const result = await enforceDispatchBill(buildDispatchBillContext({
    raw: true, creationDecision: { action: "create" },
  }, { consequential_addition: false, existing_fit_analysis_recorded: true,
    existing_responsibilities_insufficient: true }));
  assert.equal(result.ok, false);
  assert.ok(DISPATCH_TOOLS.find((tool) => tool.name === "dispatch_v1").inputSchema.properties.creationDecision);
});

test("native skill scaffold: refuses before mutation and creates from grounded necessary choice", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-creation-fit-"));
  try {
    const refused = scaffold("new-capability", root);
    assert.equal(refused.blocked, true);
    assert.equal(existsSync(join(root, "new-capability")), false);
    const permitted = scaffold("new-capability", root, { creationDecision: creationDecision() });
    assert.equal(permitted.manifest.name, "new-capability");
    assert.equal(existsSync(join(root, "new-capability", "skill.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected creation is refused by both real dispatch consumers before model query", async () => {
  const options = { raw: true, consequentialAddition: true,
    _probeOllamaRoute: () => ({ staticAvailable: true, status: "ok" }) };
  const buffered = await queryModel("qwen3.5", "selected creation", options);
  assert.equal(buffered.blocked, true);
  assert.equal(buffered.usage.total_tokens, 0);
  assert.match(buffered.error, /std-14.modularity.creation-fit/);
  const events = [];
  for await (const event of queryModelStream("qwen3.5", "selected creation", options)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].blocked, true);
  assert.match(events[0].error, /std-14.modularity.creation-fit/);
});

// ─── HARD: enforceDispatch is the gate, before bridge.query, in both paths ─────

test("HARD: enforceDispatch is imported and called (the dispatch-path policy gate exists)", () => {
  assert.match(SRC, /import\s*\{[^}]*\benforceDispatch\b[^}]*\}\s*from\s*["'][^"']*enforcement\/enforce\.js["']/);
  const calls = LIVE.match(/enforceDispatch\s*\(/g) || [];
  assert.ok(calls.length >= 2, `enforceDispatch must guard BOTH choke points (buffered + stream); found ${calls.length}`);
});

test("HARD: the policy verdict is consulted BEFORE acquireSlot in the buffered path", () => {
  const innerIdx = LIVE.indexOf("function _queryModelInner");
  assert.notEqual(innerIdx, -1);
  const inner = LIVE.slice(innerIdx, LIVE.indexOf("async function* queryModelStream"));
  const guardIdx = inner.indexOf("enforceDispatch");
  const slotIdx = inner.indexOf("acquireSlot");
  assert.ok(guardIdx !== -1 && slotIdx !== -1, "both enforceDispatch and acquireSlot present in the buffered path");
  assert.ok(guardIdx < slotIdx, "the fail-closed policy check must run BEFORE the throttle slot / bridge.query");
});

test("HARD: a blocked dispatch returns the SAME failure shape (blocked:true) callers already handle", () => {
  // the buffered path returns { failed:true, blocked:true, ... } so queryConcurrent/queryByRole
  // need zero new branches; the stream path yields { type:"error", blocked:true }.
  assert.match(LIVE, /blocked:\s*true/);
  assert.match(LIVE, /type:\s*["']error["'][^}]*blocked:\s*true/s);
});

// ─── CARRIED: unconditional anchor — the seat guard is GONE ─────────────────────

test("CARRIED: carryMandate is the one mandate path (both choke points route through it)", () => {
  assert.match(SRC, /import\s*\{[^}]*\bcarryMandate\b[^}]*\}\s*from/);
  const calls = LIVE.match(/carryMandate\s*\(/g) || [];
  assert.equal(calls.length, 2, `carryMandate must be called once per choke point (buffered + stream); found ${calls.length}`);
});

test("CARRIED: the OLD seat-guarded mandate block is removed (no `options.mandate && options.seat`)", () => {
  assert.doesNotMatch(LIVE, /options\.mandate\s*&&\s*options\.seat/,
    "the unconditional law removed the seat guard — a `mandate && seat` co-occurrence means it leaked back");
  // renderMandateBlock is no longer called inline in dispatch.js (it moved into carryMandate)
  assert.doesNotMatch(LIVE, /renderMandateBlock\s*\(/,
    "dispatch.js must not render the mandate inline anymore — carryMandate owns it (single renderer)");
});

// ─── RAW: the verbose preamble stays raw-gated (raw keeps its skip) ────────────

test("RAW: injectGovernance still receives raw:options.raw (verbose preamble stays raw-gated)", () => {
  const calls = LIVE.match(/injectGovernance\s*\(/g) || [];
  assert.equal(calls.length, 2, "injectGovernance is still called once per choke point");
  // carryMandate's output (`anchored`) is what injectGovernance wraps: the mandate anchor
  // rides through carryMandate, and the verbose preamble stays injectGovernance's job.
  assert.match(LIVE, /const\s+anchored\s*=\s*carryMandate\(/,
    "the mandate anchor is produced by carryMandate (the one mandate path)");
  assert.match(LIVE, /injectGovernance\(\s*composedPrefix\s*\+\s*anchored/s,
    "the governed message wraps the carryMandate output (anchored) with injectGovernance");
  assert.match(LIVE, /raw:\s*options\.raw/,
    "injectGovernance still gets raw:options.raw — raw dispatches keep skipping the verbose preamble");
});

test("SELECTED CHANNEL: dispatch loads the channel bridge in both choke points", () => {
  assert.match(SRC, /import\s*\{[^}]*\bloadBridgeModule\b[^}]*\}\s*from\s*["\'][^"\']*bridge-loaders\.js["\']/);
  const selections = LIVE.match(/const\s+selectedChannel\s*=\s*options\.channel\s*\|\|\s*null/g) || [];
  assert.equal(selections.length, 2, "selectedChannel must be resolved once per choke point");
  const bridgeLoads = LIVE.match(/selectedChannel\?\.bridge\s*\?\s*await\s+loadBridgeModule\(selectedChannel\.bridge\)\s*:\s*await\s+getBridge\(modelId\)/g) || [];
  assert.equal(bridgeLoads.length, 2, "selected channels must load their bridge in buffered + stream paths");
  const modelStamps = LIVE.match(/merged\.model\s*=\s*selectedChannel\.model/g) || [];
  assert.equal(modelStamps.length, 2, "selected channels must stamp their provider model in both paths");
  assert.doesNotMatch(LIVE, /isFleetChannelsEnabled/, "explicit selected channels must not be dropped behind the fleet flag");
});

// ─── SOFT: fire-and-forget, never awaited ──────────────────────────────────────


test("SOFT: verifyDispatchSoft runs fire-and-forget (never awaited) behind softVerifyEnabled", () => {
  assert.match(SRC, /import\s*\{[^}]*\bverifyDispatchSoft\b[^}]*\}\s*from/);
  const calls = LIVE.match(/verifyDispatchSoft\s*\(/g) || [];
  assert.ok(calls.length >= 2, `the soft pass fires on both choke points; found ${calls.length}`);
  // every soft call is gated and .catch()'d, never awaited
  assert.doesNotMatch(LIVE, /await\s+verifyDispatchSoft/,
    "verifyDispatchSoft must NEVER be awaited — it is off-critical-path and non-blocking");
  assert.match(LIVE, /verifyDispatchSoft\([^;]*\)\.catch\(/s,
    "every soft-verify call is .catch()'d so a verify fault can never surface to the dispatch");
  assert.match(LIVE, /softVerifyEnabled\(\)/, "the soft pass is config-gated (off by default)");
});
