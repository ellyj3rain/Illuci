// core/matrix/resolve-role-reliability.test.js — [A48]/DR-128
//
// resolveRole ranks live candidates by LEARNED reliability, with static priority
// as the cold-start tiebreak. This is the operator's fix in action: a working
// lane that earns a track record rises above an installed-but-unproven premium
// default, WITHOUT any hardcoded fleet preference.
//
// Hermetic: deepseek + kimi-cloud are both ollama-cloud, so isAvailable() reads
// true for them off any network (presence-grade), and both declare `analyst`.
// Reliability is recorded in-process (no breaker touched, so availability holds).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveRole } = await import("./capability-matrix.js");
const { recordReliability, _resetReliabilityForTest } = await import("../fleet/reliability.js");

beforeEach(() => {
  process.env.ILLUCI_DRL_ENABLED = "1";
  // A FRESH persistence path per test — else _resetReliabilityForTest reloads the
  // prior test's persisted snapshot and state leaks across cases.
  process.env.ILLUCI_RELIABILITY_PATH = join(mkdtempSync(join(tmpdir(), "illuci-rel-")), "reliability.json");
  _resetReliabilityForTest();
});

test("cold start (all neutral) ranks by static priority — byte-identical to pre-[A48]", () => {
  const cold = resolveRole("analyst").map((c) => c.model);
  process.env.ILLUCI_DRL_ENABLED = "0";
  const off = resolveRole("analyst").map((c) => c.model);
  assert.deepEqual(cold, off, "neutral reliability collapses to the static order");
});

test("a lane that EARNS reliability rises above a higher-static-priority sibling", () => {
  const before = resolveRole("analyst").map((c) => c.model);
  assert.ok(before.indexOf("deepseek") > before.indexOf("kimi-cloud") || before.includes("deepseek"),
    "precondition: both present in the analyst pool");
  // kimi succeeds, deepseek fails — repeatedly.
  for (let i = 0; i < 20; i++) { recordReliability("kimi-cloud", true); recordReliability("deepseek", false); }
  const after = resolveRole("analyst").map((c) => c.model);
  assert.ok(after.indexOf("kimi-cloud") < after.indexOf("deepseek"),
    `kimi-cloud (reliable) must outrank deepseek (failing): ${after.join(", ")}`);
});

test("a working lane rises above an installed-but-unproven premium default", () => {
  const before = resolveRole("analyst").map((c) => c.model);
  // claude-sonnet is the static #1 (premium, but a dead headless lane here) and
  // still reads 'available' pre-probe; kimi-cloud earns a record and overtakes it.
  assert.equal(before[0], "claude-sonnet", "precondition: static #1 is the premium default");
  for (let i = 0; i < 20; i++) recordReliability("kimi-cloud", true);
  const after = resolveRole("analyst").map((c) => c.model);
  assert.ok(after.indexOf("kimi-cloud") < after.indexOf("claude-sonnet"),
    `a proven working lane outranks the unproven premium default: ${after.join(", ")}`);
});

test("DRL off: reliability is never consulted — pure static priority", () => {
  process.env.ILLUCI_DRL_ENABLED = "0";
  for (let i = 0; i < 50; i++) recordReliability("kimi-cloud", true); // no-op while off
  const off = resolveRole("analyst").map((c) => c.model);
  assert.equal(off[0], "claude-sonnet", "off => static order unchanged by any recording");
});
