// core/governance/defaults-registry.test.js — [A50]/DR-130
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, defaultsSnapshot, renderDefaults, defaultsNotice, shouldShowNotice, NOTICE_INTERVAL_MS } from "./defaults-registry.js";

test("every default control declares the required disclosure fields", () => {
  for (const d of DEFAULTS) {
    assert.ok(d.id && d.title && d.rationale, `${d.id}: id/title/rationale`);
    assert.ok(Array.isArray(d.states) && d.states.length >= 2, `${d.id}: >=2 states`);
    assert.equal(typeof d.resolve, "function", `${d.id}: resolve is a live deriver`);
    assert.ok(d.since, `${d.id}: batch provenance`);
    assert.ok(d.change && (d.change.env || d.change.run || d.change.note), `${d.id}: how-to-change`);
  }
});

test("the current state is DERIVED live from the real readers — never drifts from the engine", () => {
  // DRL default ON (A48); flipping the env flips the disclosure.
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "resilience-drl").current, "on");
  assert.equal(defaultsSnapshot({ ILLUCI_DRL_ENABLED: "0" }).controls.find((c) => c.id === "resilience-drl").current, "off");
  // preflight default 'config' (A50); env can move it.
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "preflight").current, "config");
  assert.equal(defaultsSnapshot({ ILLUCI_PREFLIGHT_ENABLED: "0" }).controls.find((c) => c.id === "preflight").current, "off");
  assert.equal(defaultsSnapshot({ ILLUCI_PREFLIGHT_PROBE: "1" }).controls.find((c) => c.id === "preflight").current, "probe");
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "run-control").current, "conducted/gated/directed");
  assert.equal(defaultsSnapshot({ ILLUCI_VERSION: "6.0.0.0-alpha" }).controls.find((c) => c.id === "posture-profile").current, "productDefault");
  assert.equal(
    defaultsSnapshot({ ILLUCI_VERSION: "6.0.0.0-alpha", ILLUCI_POSTURE_PROFILE: "{\"variables\":{\"contextReach\":0.9}}" }).controls.find((c) => c.id === "posture-profile").current,
    "operatorProfile",
  );
  // capability floor default enforce (A40); warn is the hatch.
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "capability-floor").current, "enforce");
  assert.equal(defaultsSnapshot({ ILLUCI_CAPABILITY_MODE: "warn" }).controls.find((c) => c.id === "capability-floor").current, "warn");
  // genome wiring default OFF (A80/DR-173); per-run opt-in, no env knob.
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "genome-precedence").current, "off");
  // auto-seal threshold default 32 (A85/DR-178); per-run, 0 disables.
  assert.equal(defaultsSnapshot({}).controls.find((c) => c.id === "genome-seal-threshold").current, "32");
});

test("the snapshot carries a stable schema and one row per control", () => {
  const snap = defaultsSnapshot({});
  assert.equal(snap.schema, "illuci.governance.defaults/1");
  assert.equal(snap.controls.length, DEFAULTS.length);
});

test("renderDefaults is human-readable and names each control + its change path", () => {
  const text = renderDefaults({});
  assert.match(text, /active defaults/i);
  assert.match(text, /readiness gate/i);
  assert.match(text, /--preflight/);
  assert.match(text, /illuci defaults --json/);
});

test("defaultsNotice is a one-line reminder of the ACTIVE (non-inert) defaults", () => {
  const notice = defaultsNotice({});
  assert.match(notice, /Illuci defaults active/);
  assert.match(notice, /resilience-drl=on/);
  assert.match(notice, /preflight=config/);
  assert.doesNotMatch(notice, /run-control=conducted\/gated\/directed/, "the inert/quiet run-control default is not nagged in the one-liner");
});

test("shouldShowNotice: onboarding once, then periodic, suppressed by quiet", () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldShowNotice({ lastShownMs: NaN, now }), true, "never shown => onboarding");
  assert.equal(shouldShowNotice({ lastShownMs: now - 1000, now }), false, "shown a second ago => quiet");
  assert.equal(shouldShowNotice({ lastShownMs: now - NOTICE_INTERVAL_MS - 1, now }), true, "past the interval => periodic reminder");
  assert.equal(shouldShowNotice({ lastShownMs: NaN, now, quiet: true }), false, "quiet suppresses even onboarding");
});

// [A91]/DR-184: the child-identity control row — default none, four ratified states.
test("genome-child-identity discloses default none with the four ratified states", () => {
  const row = defaultsSnapshot({}).controls.find((c) => c.id === "genome-child-identity");
  assert.ok(row, "the row exists");
  assert.equal(row.current, "none");
  assert.deepEqual(row.states, ["none", "inherit", "derive", "explicit"]);
});

// [A121]/DR-208: the worktree-sweep row — report-only default, apply is explicit.
test("worktree-sweep discloses plan as the default posture", () => {
  const row = defaultsSnapshot({}).controls.find((c) => c.id === "worktree-sweep");
  assert.ok(row, "the row exists");
  assert.equal(row.current, "plan");
  assert.ok(row.states.some((s) => s.includes("apply")), "apply is a named state");
});
