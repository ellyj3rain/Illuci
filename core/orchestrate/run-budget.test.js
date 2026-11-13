/**
 * The Run-wide governor (Phase F). Synchronous counter discipline; the default
 * (no limits) is a pure no-op so a pre-governor run is byte-identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunBudget } from "./run-budget.js";

test("default (no limits) is a pure no-op — every method grants/allows", () => {
  const b = createRunBudget();
  for (let i = 0; i < 1000; i++) assert.equal(b.reserveSlot().ok, true); // unlimited
  assert.equal(b.check(999999).allowed, true);
  b.charge(999999);
  assert.equal(b.check().allowed, true);
  assert.equal(b.isHalted(), false);
  assert.deepEqual(b.snapshot(), { maxConcurrent: null, active: 0, tokenCeiling: null, tokensSpent: 0, halted: false });
});

test("maxConcurrent: reserves up to the limit, then denies; release frees a slot", () => {
  const b = createRunBudget({ maxConcurrent: 2 });
  assert.equal(b.reserveSlot().ok, true);
  assert.equal(b.reserveSlot().ok, true);
  const denied = b.reserveSlot();
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /concurrency limit 2 reached/);
  b.releaseSlot();
  assert.equal(b.reserveSlot().ok, true); // freed slot reusable
  assert.equal(b.snapshot().active, 2);
});

test("releaseSlot never underflows below zero", () => {
  const b = createRunBudget({ maxConcurrent: 1 });
  b.releaseSlot(); b.releaseSlot(); // no reserve yet
  assert.equal(b.snapshot().active, 0);
  assert.equal(b.reserveSlot().ok, true);
});

test("tokenCeiling: check allows under, denies the call that would exceed; halt is sticky", () => {
  const b = createRunBudget({ tokenCeiling: 100 });
  assert.equal(b.check(60).allowed, true);
  b.charge(60);
  assert.equal(b.check(30).allowed, true);   // 60+30 <= 100
  const over = b.check(50);                    // 60+50 > 100
  assert.equal(over.allowed, false);
  assert.match(over.reason, /token ceiling 100 would be exceeded/);
  // the denying check tripped the sticky halt: every later check denies
  assert.equal(b.check(0).allowed, false);
  assert.equal(b.isHalted(), true);
});

test("charge trips the halt at the ceiling; a halted budget denies forever (member halts, not crashes)", () => {
  const b = createRunBudget({ tokenCeiling: 50 });
  b.charge(20); assert.equal(b.isHalted(), false);
  b.charge(40); assert.equal(b.isHalted(), true); // 60 >= 50
  assert.equal(b.check().allowed, false);
  assert.match(b.check().reason, /token budget exhausted/);
});

test("non-positive / non-finite limits are treated as unlimited (defensive)", () => {
  for (const bad of [0, -5, NaN, Infinity, "x"]) {
    const b = createRunBudget({ maxConcurrent: bad, tokenCeiling: bad });
    assert.equal(b.reserveSlot().ok, true);
    assert.equal(b.check(1e9).allowed, true);
  }
});
