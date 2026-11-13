/**
 * illuci — Seat + Agent type tests (node:test)
 *
 * Phase F harden, batch 1 — the STRESS suite for the TYPES lane. Proves:
 *   1. BACK-COMPAT (byte-identity): every existing topology's seats round-trip
 *      through createSeat JSON-identically vs the live TOPOLOGIES registry, AND
 *      the registry's own definition-time normalize pass left every seat shaped
 *      exactly as createSeat would re-emit it.
 *   2. EARLY FAILURE: each implicit invariant violation (min>max, weight out of
 *      [0,1], unknown roleHint, unknown relationship type, empty semantics,
 *      broken shape) throws a SeatError with a field-specific message.
 *   3. TOLERANCE: null roleHint passes, min0 seats pass, self-targeting
 *      relationships pass (no hard error), dangling targets are advisory only.
 *   4. VOCABULARY is a DERIVED superset of every roleHint/relationship type the
 *      registry actually uses — no existing seat can trip the vocab check.
 *   5. AGENT never-loosened mandate floor: an Agent with a revision below floor
 *      is rejected; at/above floor is accepted.
 *
 * node:test only (the sibling relationships.test.js is vitest and cannot run in
 * this harness). Reads TOPOLOGIES directly from index.js.
 *
 * Run: node --test illuci/core/topologies/seat-type.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SeatError,
  KNOWN_ROLE_HINTS,
  KNOWN_RELATIONSHIP_TYPES,
  getKnownRelationshipTypes,
  validateSeat,
  createSeat,
  normalizeSeats,
  createAgent,
  validateAgent,
} from "./seat-type.js";
import { TOPOLOGIES, RELATIONSHIP_TYPES } from "./index.js";
import { getRoles } from "../matrix/capability-matrix.js";
import { buildMandate, reviseMandate } from "./mandate.js";

/** Run fn, return the error it threw (or fail the test if it didn't throw). */
function catchError(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected the call to throw, but it did not");
}

// A canonical, fully-valid seat literal in the registry's field order.
const GOOD_SEAT = {
  id: "arbiter", label: "Arbiter", min: 1, max: 1, roleHint: "arbiter", weight: 1.0,
  relationships: [{ type: "integrates-from", target: "red", semantics: "evaluates" }],
};

// ─── 1. BACK-COMPAT: byte-identity round-trip ───────────────────────────────────

test("every existing seat round-trips through createSeat byte-identically", () => {
  let seatsChecked = 0;
  for (const id of Object.keys(TOPOLOGIES)) {
    const seats = TOPOLOGIES[id].seats;
    const knownSeatIds = new Set(seats.map((s) => s.id));
    for (const seat of seats) {
      seatsChecked++;
      const rebuilt = createSeat(seat, { topologyId: id, knownSeatIds });
      assert.equal(
        JSON.stringify(rebuilt),
        JSON.stringify(seat),
        `seat "${seat.id}" in "${id}" must round-trip byte-identically`,
      );
    }
  }
  assert.ok(seatsChecked >= 100, `sanity: expected to check the full registry, got ${seatsChecked}`);
});

test("the definition-time normalize pass left every registry seat in canonical shape", () => {
  // Re-normalizing an already-normalized registry must be a no-op (idempotent),
  // which proves the import-time pass produced the same shape createSeat emits.
  for (const id of Object.keys(TOPOLOGIES)) {
    const before = JSON.stringify(TOPOLOGIES[id].seats);
    const after = JSON.stringify(normalizeSeats(TOPOLOGIES[id].seats, { topologyId: id }));
    assert.equal(after, before, `normalizeSeats must be idempotent for "${id}"`);
  }
});

test("createSeat applies the exact registry defaults to a bare seat", () => {
  const seat = createSeat({ id: "x" });
  assert.deepEqual(seat, { id: "x", label: "x", min: 1, max: 1, roleHint: null, weight: 1.0, relationships: [] });
  // field order must match the literal
  assert.equal(JSON.stringify(seat), '{"id":"x","label":"x","min":1,"max":1,"roleHint":null,"weight":1,"relationships":[]}');
});

// ─── 2. VOCABULARY is a derived superset ─────────────────────────────────────────

test("KNOWN_ROLE_HINTS is the full matrix role enumeration", () => {
  assert.deepEqual([...KNOWN_ROLE_HINTS].sort(), [...getRoles()].sort());
});

test("KNOWN_ROLE_HINTS is a superset of every roleHint used in the registry", () => {
  const used = new Set();
  for (const id of Object.keys(TOPOLOGIES)) {
    for (const seat of TOPOLOGIES[id].seats) {
      if (seat.roleHint !== null && seat.roleHint !== undefined) used.add(seat.roleHint);
    }
  }
  for (const hint of used) {
    assert.ok(KNOWN_ROLE_HINTS.has(hint), `roleHint "${hint}" used in registry but not in KNOWN_ROLE_HINTS`);
  }
  assert.ok(used.size >= 10, `expected the 10 known roleHints in use, got ${used.size}`);
});

test("KNOWN_RELATIONSHIP_TYPES equals RELATIONSHIP_TYPES and covers every edge in the registry", () => {
  assert.deepEqual([...getKnownRelationshipTypes()].sort(), [...RELATIONSHIP_TYPES].sort());
  for (const id of Object.keys(TOPOLOGIES)) {
    for (const seat of TOPOLOGIES[id].seats) {
      for (const rel of seat.relationships) {
        assert.ok(KNOWN_RELATIONSHIP_TYPES.has(rel.type), `edge type "${rel.type}" in "${id}" not in vocab`);
      }
    }
  }
});

// ─── 3. HARD INVARIANT VIOLATIONS throw a field-specific SeatError ───────────────

test("min > max throws a cardinality SeatError naming the min field", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, min: 3, max: 1 }, { topologyId: "t" }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /min \(3\) must be <= max \(1\)/);
  assert.equal(err.topologyId, "t");
  assert.equal(err.seatId, "arbiter");
});

test("weight 1.1 throws a weight SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, weight: 1.1 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /weight must be a number in \[0,1\], got 1\.1/);
});

test("weight -0.1 throws a weight SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, weight: -0.1 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /weight must be a number in \[0,1\], got -0\.1/);
});

test('unknown roleHint "architekt" throws a roleHint SeatError', () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, roleHint: "architekt" }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /roleHint "architekt" is not a known capability hint/);
});

test('unknown relationship type "rival-of" throws a relationship-type SeatError', () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, relationships: [{ type: "rival-of", target: "red", semantics: "spars" }] }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /type "rival-of" is not a known relationship type/);
});

test("empty semantics throws a semantics SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, relationships: [{ type: "integrates-from", target: "red", semantics: "" }] }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /semantics must be a non-empty string/);
});

test("non-string id throws a shape SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, id: 42 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /id must be a non-empty string/);
});

test("negative min throws a cardinality SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, min: -1, max: 2 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /min must be an integer >= 0/);
});

test("non-integer max throws a cardinality SeatError", () => {
  const err = catchError(() => createSeat({ ...GOOD_SEAT, min: 1, max: 2.5 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /max must be an integer >= 1/);
});

// ─── 4. TOLERANCE: legitimate shapes must NOT throw ──────────────────────────────

test("null roleHint passes", () => {
  assert.doesNotThrow(() => createSeat({ ...GOOD_SEAT, roleHint: null }));
  const r = validateSeat({ ...GOOD_SEAT, roleHint: null });
  assert.equal(r.valid, true);
});

test("min 0 seats pass (judiciary witness, commune outsider)", () => {
  assert.doesNotThrow(() => createSeat({ id: "witness", label: "Witness", min: 0, max: 3, roleHint: "analyst", weight: 0.5, relationships: [] }));
  assert.doesNotThrow(() => createSeat({ id: "outsider", label: "Outsider", min: 0, max: 1, roleHint: "reviewer", weight: 0.5, relationships: [] }));
});

test("weight at the [0,1] boundaries passes", () => {
  assert.doesNotThrow(() => createSeat({ ...GOOD_SEAT, weight: 0 }));
  assert.doesNotThrow(() => createSeat({ ...GOOD_SEAT, weight: 1 }));
});

test("self-targeting relationships pass (war-room, perception-council)", () => {
  const seat = {
    id: "participant", label: "Participant", min: 3, max: 6, roleHint: "analyst", weight: 1.0,
    relationships: [{ type: "peer-of", target: "participant", semantics: "collaborates" }],
  };
  assert.doesNotThrow(() => createSeat(seat, { topologyId: "war-room", knownSeatIds: new Set(["participant"]) }));
  const r = validateSeat(seat, { topologyId: "war-room", knownSeatIds: new Set(["participant"]) });
  assert.equal(r.valid, true);
  assert.equal(r.warnings.length, 0, "self-target is not even a warning");
});

test("a dangling relationship target is an advisory WARNING, never a hard error", () => {
  const seat = { ...GOOD_SEAT, relationships: [{ type: "integrates-from", target: "ghost", semantics: "evaluates" }] };
  // No throw — referential integrity is advisory.
  assert.doesNotThrow(() => createSeat(seat, { topologyId: "t", knownSeatIds: new Set(["arbiter"]) }));
  const r = validateSeat(seat, { topologyId: "t", knownSeatIds: new Set(["arbiter"]) });
  assert.equal(r.valid, true, "dangling target does not invalidate the seat");
  assert.equal(r.warnings.length, 1, "but it is surfaced as a warning");
  assert.match(r.warnings[0].message, /target "ghost" does not match any sibling seat/);
});

test("referential check is silent when knownSeatIds is omitted", () => {
  const seat = { ...GOOD_SEAT, relationships: [{ type: "integrates-from", target: "ghost", semantics: "evaluates" }] };
  const r = validateSeat(seat, { topologyId: "t" });
  assert.equal(r.valid, true);
  assert.equal(r.warnings.length, 0, "no referential pass without sibling ids");
});

// ─── 5. AGENT never-loosened mandate floor ──────────────────────────────────────

test("createAgent accepts a mandate at the floor revision", () => {
  const mandate = buildMandate({ prompt: "Refactor auth." });
  const agent = createAgent({ modelId: "claude-local", seatId: "architect", roleHint: "architect", weight: 1.0, mandate });
  assert.equal(agent.modelId, "claude-local");
  assert.equal(agent.seatId, "architect");
  assert.equal(agent.mandate.intent.revision, 1);
});

test("createAgent accepts a mandate ABOVE the floor (forward revision)", () => {
  const mandate = reviseMandate(buildMandate({ prompt: "Refactor auth." }), "Actually, add tests too.");
  assert.equal(mandate.intent.revision, 2);
  assert.doesNotThrow(() => createAgent(
    { modelId: "claude-local", seatId: "qa", mandate },
    { floorRevision: 2 },
  ));
});

test("createAgent REJECTS a mandate revision below the floor — inheritance is never loosened", () => {
  const stale = buildMandate({ prompt: "Old ask." }); // revision 1
  const err = catchError(() => createAgent({ modelId: "claude-local", seatId: "implementer", mandate: stale }, { floorRevision: 3 }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /revision \(1\) must be >= floor revision \(3\)/);
  assert.match(err.message, /never loosened/);
});

test("validateAgent reports the floor violation without throwing", () => {
  const stale = buildMandate({ prompt: "Old ask." });
  const r = validateAgent({ modelId: "m", seatId: "s", mandate: stale }, { floorRevision: 5 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /never loosened/.test(e.message)));
});

test("createAgent rejects an empty mandate intent.raw (mirrors buildMandate's guard)", () => {
  const broken = { intent: { raw: "", revision: 1 } };
  const err = catchError(() => createAgent({ modelId: "m", seatId: "s", mandate: broken }));
  assert.ok(err instanceof SeatError);
  assert.match(err.message, /mandate\.intent\.raw must be a non-empty string/);
});

test("createAgent rejects a missing modelId / seatId", () => {
  const mandate = buildMandate({ prompt: "x" });
  assert.throws(() => createAgent({ seatId: "s", mandate }), SeatError);
  assert.throws(() => createAgent({ modelId: "m", mandate }), SeatError);
});

// ─── SeatError surface ───────────────────────────────────────────────────────────

test("SeatError is an Error subclass carrying field coordinates", () => {
  const e = new SeatError("boom", { topologyId: "t", seatId: "s", field: "weight", value: 9 });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "SeatError");
  assert.equal(e.field, "weight");
  assert.equal(e.value, 9);
});
