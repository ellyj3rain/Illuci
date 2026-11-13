/**
 * illuci — Enforcement Spine tests (Phase 6, node:test, hermetic — no LLM, no bridge)
 *
 * Proves the GZDS 3-tier law on the dispatch path:
 *   HARD    — fail-closed POLICY check (never a per-query prompt); inert by default,
 *             armed-on-config, operator-override audited.
 *   CARRIED — the [Mandate] anchor is UNCONDITIONAL: NO dispatch shape (seated,
 *             unseated, sibling, spawn, raw) escapes it. Raw loses only the preamble.
 *   SOFT    — off-critical-path, non-blocking; the 2 hard-invariant .rule fns light up.
 *
 * Run: node --test illuci/core/governance/enforce.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { enforceDispatch, carryMandate, verifyDispatchSoft, softVerifyEnabled, makeJudge } from "./enforcement/enforce.js";
import {
  evaluateDispatch, dispatchKindOf, updateDispatchPolicy, _resetDispatchPolicyForTest,
  reloadGateConfig,
} from "./enforcement/dispatch-policy.js";
import { renderMandateBlock } from "../topologies/mandate.js";

const MANDATE = { operator: { name: "Example" }, intent: { raw: "Refactor auth.", revision: 1 } };

function resetPolicy() {
  _resetDispatchPolicyForTest();
  delete process.env.ILLUCI_GATE_CONFIG;
  reloadGateConfig();
}

// ─── HARD tier: it is a POLICY verdict, NOT a prompt ───────────────────────────

test("HARD: inert by default — every dispatch allowed (back-compat, no policy armed)", () => {
  resetPolicy();
  assert.equal(enforceDispatch({ modelId: "claude-opus", options: {} }).allowed, true);
  assert.equal(enforceDispatch({ modelId: "grok", options: { seat: "red" } }).allowed, true);
  assert.equal(enforceDispatch({ modelId: "anything", options: { raw: true } }).allowed, true);
});

test("HARD: dispatch kind derives from options (spawn > raw > seat > direct)", () => {
  assert.equal(dispatchKindOf({ spawn: true, seat: "x", raw: true }), "spawn");
  assert.equal(dispatchKindOf({ raw: true, seat: "x" }), "raw");
  assert.equal(dispatchKindOf({ seat: "x" }), "seat");
  assert.equal(dispatchKindOf({}), "direct");
});

test("HARD: a denylist match denies even with enforce:false (explicit operator instruction)", () => {
  resetPolicy();
  updateDispatchPolicy({ denyModels: ["banned-model"] });
  const v = enforceDispatch({ modelId: "banned-model", options: {} });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /denylist/);
  // a non-denied model still flows
  assert.equal(enforceDispatch({ modelId: "claude-opus", options: {} }).allowed, true);
  resetPolicy();
});

test("HARD: fail-closed — armed allowlist denies a model absent from it BEFORE bridge.query", () => {
  resetPolicy();
  updateDispatchPolicy({ enforce: true, allowModels: ["claude-opus", "claude-haiku"] });
  assert.equal(enforceDispatch({ modelId: "claude-opus", options: {} }).allowed, true);
  const denied = enforceDispatch({ modelId: "some-rando", options: {} });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /allowlist/);
  resetPolicy();
});

test("HARD: an allowlist is NOT enforced while enforce:false (armed gate is opt-in)", () => {
  resetPolicy();
  updateDispatchPolicy({ enforce: false, allowModels: ["only-this"] });
  // enforce off -> the allowlist does not bite; back-compat preserved
  assert.equal(enforceDispatch({ modelId: "not-on-list", options: {} }).allowed, true);
  resetPolicy();
});

test("HARD: enforceDispatch NEVER prompts — it is a synchronous verdict (no Promise)", () => {
  resetPolicy();
  const v = enforceDispatch({ modelId: "claude-opus", options: { seat: "red" } });
  assert.equal(typeof v.allowed, "boolean");
  assert.ok(!(v instanceof Promise), "the dispatch hard tier is a synchronous policy verdict, never an async prompt");
  resetPolicy();
});

// ─── HARD tier: operator-override via GateConfig, audited ───────────────────────

test("HARD: a GateConfig trustedAgent override allows a policy-denied dispatch + audits it", async () => {
  resetPolicy();
  // arm a denying policy
  updateDispatchPolicy({ enforce: true, allowModels: ["claude-opus"] });
  // operator trusts the "trusted-seat"
  const cfgPath = join(tmpdir(), `gate-config-${Date.now()}.json`);
  writeFileSync(cfgPath, JSON.stringify({ trustedAgents: ["trusted-seat"] }));
  process.env.ILLUCI_GATE_CONFIG = cfgPath;
  reloadGateConfig();

  const v = enforceDispatch({ modelId: "denied-model", options: { seat: "trusted-seat" } });
  assert.equal(v.allowed, true, "override allows the otherwise-denied dispatch");
  assert.ok(v.override, "the verdict carries an override stamp");
  assert.equal(v.override.by, "gateconfig:trustedAgent");
  assert.equal(v.override.ruleId, "trusted-seat");

  // the bypass is recorded to the append-only audit sink (awaited — a floating .then()
  // would let the assertions run after the test resolved, silently passing on failure).
  const { readAudit } = await import("./enforcement/audit.js");
  const recs = readAudit().filter((r) => r.kind === "dispatch-override" && r.seat === "trusted-seat");
  assert.ok(recs.length >= 1, "the override wrote an append-only audit record");
  assert.equal(recs[recs.length - 1].overrideBy, "gateconfig:trustedAgent");

  rmSync(cfgPath, { force: true });
  resetPolicy();
});

test("HARD: an override whose audit write CANNOT land fails CLOSED (override-must-audit, HIGH-2)", () => {
  // AUDIT_PATH is frozen at first import (it derives from resolveIlluciHomeRoot at load), so a
  // failing-write scenario must be set up BEFORE the modules import — done in a fresh child
  // with ILLUCI_HOME pointed at a FILE, so mkdir/append under <home>/.illuci cannot succeed.
  const homeFile = join(tmpdir(), `neohome-as-file-${Date.now()}.txt`);
  const cfgPath = join(tmpdir(), `gate-config-fc-${Date.now()}.json`);
  writeFileSync(homeFile, "x");
  writeFileSync(cfgPath, JSON.stringify({ trustedAgents: ["trusted-seat"] }));
  // Inline ESM imports must be file:// URLs (an absolute Windows path is rejected as a "c:" scheme).
  const enforceUrl = pathToFileURL(join(__dirname, "enforcement", "enforce.js")).href;
  const policyUrl = pathToFileURL(join(__dirname, "enforcement", "dispatch-policy.js")).href;
  const probe = `
    import { enforceDispatch } from ${JSON.stringify(enforceUrl)};
    import { updateDispatchPolicy, reloadGateConfig } from ${JSON.stringify(policyUrl)};
    updateDispatchPolicy({ enforce: true, allowModels: ["only-this"] });
    reloadGateConfig();
    const v = enforceDispatch({ modelId: "denied-model", options: { seat: "trusted-seat" } });
    process.stdout.write(JSON.stringify(v));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, ILLUCI_HOME: homeFile, ILLUCI_GATE_CONFIG: cfgPath },
    encoding: "utf-8",
  });
  const v = JSON.parse(out);
  assert.equal(v.allowed, false, "an un-auditable override must fail closed, never silently allow an untrailed bypass");
  assert.match(v.reason, /could not be audited/);
  rmSync(homeFile, { force: true });
  rmSync(cfgPath, { force: true });
});

test("HARD: NO override configured -> a policy denial stays denied (override is opt-in)", () => {
  resetPolicy();
  updateDispatchPolicy({ enforce: true, allowModels: ["claude-opus"] });
  const v = enforceDispatch({ modelId: "denied-model", options: { seat: "untrusted" } });
  assert.equal(v.allowed, false);
  assert.equal(v.override, undefined);
  resetPolicy();
});

// ─── HARD tier: malformed gate-config is normalized, never throws (HIGH-3a) ─────

test("HARD: a malformed gate-config (trustedAgents not an array) is coerced, never throws", () => {
  resetPolicy();
  updateDispatchPolicy({ enforce: true, allowModels: ["claude-opus"] });
  const cfgPath = join(tmpdir(), `gate-config-bad-${Date.now()}.json`);
  // Operator typo: trustedAgents a STRING, overrides an ARRAY — the pre-fix shape that
  // made isAgentTrusted/checkOverride throw on the dispatch path.
  writeFileSync(cfgPath, JSON.stringify({ trustedAgents: "trusted-seat", overrides: ["x"] }));
  process.env.ILLUCI_GATE_CONFIG = cfgPath;
  reloadGateConfig();

  let v;
  assert.doesNotThrow(() => {
    v = enforceDispatch({ modelId: "denied-model", options: { seat: "trusted-seat" } });
  }, "a malformed gate-config must not throw through the dispatch hard tier");
  // the string trustedAgents degraded to empty -> the override does NOT apply -> denied
  assert.equal(v.allowed, false, "a coerced-empty trustedAgents grants no override (fail-closed)");

  rmSync(cfgPath, { force: true });
  resetPolicy();
});

// ─── CARRIED tier: the NO-ESCAPE proof ─────────────────────────────────────────

const SHAPES = [
  { name: "seated", options: { mandate: MANDATE, seat: "red" } },
  { name: "unseated", options: { mandate: MANDATE } },
  { name: "sibling (no seat, peer dispatch)", options: { mandate: MANDATE, peerIds: ["grok"] } },
  { name: "raw (anchor planning)", options: { mandate: MANDATE, raw: true } },
  { name: "spawn", options: { mandate: MANDATE, spawn: true, seat: "architect" } },
];

test("NO ESCAPE: every dispatch shape carries the [Mandate] anchor (unconditional law)", () => {
  for (const shape of SHAPES) {
    const out = carryMandate("the task body", shape.options);
    assert.ok(out.includes("[Mandate]"), `${shape.name} dispatch MUST carry [Mandate] — it escaped the law`);
    assert.ok(out.includes("Refactor auth."), `${shape.name} must carry the verbatim ask`);
    assert.ok(out.startsWith("[Mandate]"), `${shape.name} anchors the mandate FIRST`);
  }
});

test("NO ESCAPE: the EXACT spawn shape (mandate as a JSON STRING) carries the anchor, never throws", () => {
  // spawn.js sets child options.mandate = runner's carriedMandate = JSON.stringify(mandate).
  // The prior carryMandate fed that string to renderMandateBlock and threw on .intent.revision.
  const stringMandate = JSON.stringify(MANDATE);
  let out;
  assert.doesNotThrow(() => {
    out = carryMandate("the delegated sub-task body", { mandate: stringMandate, spawn: true });
  }, "carryMandate must not throw on a stringified mandate (the spawn shape)");
  assert.ok(out.startsWith("[Mandate]"), "the spawn-string shape anchors the mandate FIRST");
  assert.ok(out.includes("Refactor auth."), "the round-tripped JSON mandate carries the verbatim ask");
  assert.ok(out.includes("the delegated sub-task body"), "the task body is preserved after the anchor");
});

test("CARRIED: a non-JSON pre-rendered string mandate is wrapped under the anchor (still carries the law)", () => {
  const out = carryMandate("body", { mandate: "You serve Example. Refactor auth.", spawn: true });
  assert.ok(out.startsWith("[Mandate]"), "a plain-string mandate still anchors FIRST");
  assert.ok(out.includes("You serve Example. Refactor auth."), "the raw pre-rendered anchor is preserved verbatim");
});

test("CARRIED: idempotent — frame.js already placed [Mandate] -> no double-inject (byte-identical)", () => {
  const framed = renderMandateBlock(MANDATE) + "\n\n[Task]\ndo the thing";
  const out = carryMandate(framed, { mandate: MANDATE, seat: "red" });
  assert.equal(out, framed, "an already-anchored message is returned unchanged");
  // exactly one [Mandate] marker
  assert.equal((out.match(/\[Mandate\]/g) || []).length, 1);
});

test("CARRIED: no mandate configured -> message unchanged (back-compat for mandate-less dispatches)", () => {
  assert.equal(carryMandate("bare message", {}), "bare message");
  assert.equal(carryMandate("bare message", { seat: "red" }), "bare message");
});

test("CARRIED: raw still carries the lean anchor (the verbose preamble is injectGovernance's job, not this)", () => {
  const out = carryMandate("plan the agenda", { mandate: MANDATE, raw: true });
  assert.ok(out.includes("[Mandate]"), "raw keeps the anchor");
  // the anchor is LEAN — it is exactly renderMandateBlock + the message, nothing else
  assert.equal(out, renderMandateBlock(MANDATE) + "\n\nplan the agenda");
});

// ─── SOFT tier: off-critical-path, non-blocking, config-gated ──────────────────

test("SOFT: disabled by default — verifyDispatchSoft is a no-op (no judge call) when ILLUCI_VERIFY_SOFT unset", async () => {
  delete process.env.ILLUCI_VERIFY_SOFT;
  assert.equal(softVerifyEnabled(), false);
  let judgeCalled = false;
  await verifyDispatchSoft({ output: "anything", modelId: "x", judge: async () => { judgeCalled = true; return "{}"; } });
  assert.equal(judgeCalled, false, "the soft pass does not run (no judge invoked) when the flag is off");
});

test("SOFT: enabled — runs the verify pass; the deterministic hard rules need no judge", async () => {
  process.env.ILLUCI_VERIFY_SOFT = "1";
  assert.equal(softVerifyEnabled(), true);
  // a clean output -> the soft judge is consulted for the 4 soft invariants but the
  // 2 hard rules run deterministically. We feed a judge that always says clean.
  let judgeCalls = 0;
  await verifyDispatchSoft({
    output: "a perfectly clean output with no violations",
    modelId: "x", seat: "red",
    judge: async () => { judgeCalls += 1; return '{"violates": false, "reason": "clean"}'; },
  });
  // 6 invariants, 2 hard (no judge), 4 soft (judge) -> 4 judge calls
  assert.equal(judgeCalls, 4, "the 4 soft invariants use the judge; the 2 hard rules do not");
  delete process.env.ILLUCI_VERIFY_SOFT;
});

test("SOFT: verifyDispatchSoft resolves to void (callers never await a result) and never throws", async () => {
  process.env.ILLUCI_VERIFY_SOFT = "1";
  const r = await verifyDispatchSoft({
    output: "x", modelId: "m",
    judge: async () => { throw new Error("judge exploded"); },
  }).then(() => "resolved", () => "rejected");
  // verifyDispatchSoft is SELF-CONTAINED: its body is wrapped in try/catch, so a judge
  // throw is logged-and-dropped and the call RESOLVES (never rejects), even when a caller
  // forgets .catch(). This guards that property directly, not the old tautology.
  assert.equal(r, "resolved");
  delete process.env.ILLUCI_VERIFY_SOFT;
});

// ─── makeJudge: raw:true so the judge does not recurse into governance ─────────

test("makeJudge produces a judge that dispatches raw (no recursive governance/mandate)", async () => {
  const calls = [];
  const fakeQueryModel = async (modelId, prompt, opts) => { calls.push({ modelId, opts }); return { response: '{"violates": false}' }; };
  const judge = makeJudge(fakeQueryModel);
  const out = await judge("is this clean?");
  assert.equal(out, '{"violates": false}');
  assert.equal(calls[0].opts.raw, true, "the judge call is raw — it must not recurse into the governed path");
});
