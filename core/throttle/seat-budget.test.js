// node:test — the seat/member budget cascade v1 (DR-189, WO-2 ruling).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBudgetControl,
  createSeatBudget,
  SeatBudgetConfigError,
} from "./seat-budget.js";

// ── normalization: fail-closed, off-by-default ─────────────────────────────

test("null / empty budget → off (byte-identical control posture)", () => {
  assert.equal(normalizeBudgetControl(null), null);
  assert.equal(normalizeBudgetControl({}), null);
  assert.equal(normalizeBudgetControl({ seats: {} }), null);
});

test("normalizes member cap, seat floors/caps, reseatingMin", () => {
  const c = normalizeBudgetControl({
    member: { cap: 100000 },
    seats: { arbiter: { floor: 20000 }, investigator: { cap: 30000 } },
    reseatingMin: 5000,
  });
  assert.equal(c.memberCap, 100000);
  assert.deepEqual(c.seats.arbiter, { floor: 20000 });
  assert.deepEqual(c.seats.investigator, { cap: 30000 });
  assert.equal(c.reseatingMin, 5000);
});

test("fail-closed on malformed shapes (DR-129: never a silent downgrade)", () => {
  assert.throws(() => normalizeBudgetControl(42), SeatBudgetConfigError);
  assert.throws(() => normalizeBudgetControl({ member: { cap: -1 } }), SeatBudgetConfigError);
  assert.throws(() => normalizeBudgetControl({ member: { cap: 0 } }), SeatBudgetConfigError);
  assert.throws(() => normalizeBudgetControl({ seats: { x: { floor: "big" } } }), SeatBudgetConfigError);
  assert.throws(() => normalizeBudgetControl({ seats: { x: { floor: 50, cap: 10 } } }), SeatBudgetConfigError);
  assert.throws(() => normalizeBudgetControl({ reseatingMin: 1.5 === 1.5 ? -3 : 1 }), SeatBudgetConfigError);
});

// ── off: observation only, everything Infinity ─────────────────────────────

test("unconfigured ledger tracks spend for observation but enforces nothing", () => {
  const b = createSeatBudget(null);
  assert.equal(b.enforced, false);
  assert.equal(b.effectiveDispatchCap("red", 6000), 6000); // configured passes through
  assert.equal(b.effectiveDispatchCap("red"), Infinity);
  b.charge("red", 4000);
  assert.equal(b.seatSpent("red"), 4000);
  assert.equal(b.memberSpent(), 4000);
  assert.equal(b.seatExhausted("red"), false);
  const snap = b.snapshot();
  assert.equal(snap.enforced, false);
  assert.equal(snap.seats.red.spent, 4000);
  assert.equal(snap.seats.red.remaining, null); // no enforcement → no remaining
});

// ── floors: non-borrowable admission-control reservation ───────────────────

test("a floor is reserved: peers cannot borrow it from the member pool", () => {
  // member 100k; arbiter floor 30k; investigator uncapped.
  const c = normalizeBudgetControl({ member: { cap: 100000 }, seats: { arbiter: { floor: 30000 } } });
  const b = createSeatBudget(c);
  // investigator may draw the member pool MINUS the arbiter's reserved floor = 70k.
  assert.equal(b.effectiveDispatchCap("investigator"), 70000);
  // arbiter may draw its own floor + the unreserved pool = 30k + 70k = 100k.
  assert.equal(b.effectiveDispatchCap("arbiter"), 100000);
  // investigator spends 70k → member pool down to 30k, all reserved for arbiter.
  b.charge("investigator", 70000);
  assert.equal(b.effectiveDispatchCap("investigator"), 0); // starved of the unreserved pool
  assert.equal(b.seatExhausted("investigator"), true);
  // arbiter still has its full 30k floor — it was never borrowable.
  assert.equal(b.effectiveDispatchCap("arbiter"), 30000);
  assert.equal(b.seatExhausted("arbiter"), false);
});

test("floors exceeding the member cap fail closed at construction", () => {
  const c = normalizeBudgetControl({ member: { cap: 40000 }, seats: { a: { floor: 30000 }, b: { floor: 20000 } } });
  assert.throws(() => createSeatBudget(c), SeatBudgetConfigError);
});

// ── the derived per-dispatch cap = min of the whole chain ──────────────────

test("effectiveDispatchCap is min(configured, seat, member, company)", () => {
  const c = normalizeBudgetControl({ member: { cap: 50000 }, seats: { red: { cap: 20000 } } });
  const b = createSeatBudget(c, { companyRemaining: () => 8000 });
  // configured 6000 < company 8000 < seat 20000 < member 50000 → 6000
  assert.equal(b.effectiveDispatchCap("red", 6000), 6000);
  // no configured cap → company 8000 is the binding floor
  assert.equal(b.effectiveDispatchCap("red"), 8000);
});

test("seat cap binds independently of member remaining", () => {
  const c = normalizeBudgetControl({ member: { cap: 100000 }, seats: { red: { cap: 10000 } } });
  const b = createSeatBudget(c);
  assert.equal(b.effectiveDispatchCap("red"), 10000);
  b.charge("red", 9000);
  assert.equal(b.effectiveDispatchCap("red"), 1000);
  b.charge("red", 1000);
  assert.equal(b.seatExhausted("red"), true);
});

// ── reseatingMin: DRL consult ──────────────────────────────────────────────

test("reseatBlocked fires when a seat's remaining < reseatingMin", () => {
  const c = normalizeBudgetControl({ member: { cap: 100000 }, seats: { red: { cap: 10000 } }, reseatingMin: 5000 });
  const b = createSeatBudget(c);
  assert.equal(b.reseatBlocked("red"), false); // 10000 >= 5000
  b.charge("red", 6000); // 4000 remaining < 5000
  assert.equal(b.reseatBlocked("red"), true);
});

test("no reseatingMin → reseat never blocked by budget", () => {
  const b = createSeatBudget(normalizeBudgetControl({ seats: { red: { cap: 1 } } }));
  b.charge("red", 100);
  assert.equal(b.reseatBlocked("red"), false);
});

// ── member exhaustion ──────────────────────────────────────────────────────

test("memberExhausted trips when the member pool is spent", () => {
  const b = createSeatBudget(normalizeBudgetControl({ member: { cap: 10000 } }));
  assert.equal(b.memberExhausted(), false);
  b.charge("a", 6000);
  b.charge("b", 4000);
  assert.equal(b.memberExhausted(), true);
});

// ── snapshot: the observation surface ──────────────────────────────────────

test("snapshot reports per-seat spent/floor/cap/remaining + member figures", () => {
  const c = normalizeBudgetControl({ member: { cap: 50000 }, seats: { red: { cap: 20000 }, arbiter: { floor: 10000 } }, reseatingMin: 2000 });
  const b = createSeatBudget(c);
  b.charge("red", 5000);
  b.charge("arbiter", 3000);
  const s = b.snapshot();
  assert.equal(s.enforced, true);
  assert.equal(s.memberCap, 50000);
  assert.equal(s.memberSpent, 8000);
  assert.equal(s.memberRemaining, 42000);
  assert.equal(s.reseatingMin, 2000);
  assert.equal(s.seats.red.spent, 5000);
  assert.equal(s.seats.red.cap, 20000);
  assert.equal(s.seats.arbiter.floor, 10000);
  assert.equal(typeof s.seats.arbiter.remaining, "number");
});
