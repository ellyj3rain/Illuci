// node:test — createRuntimeTopology's border validation ([A31]).
//
// The runtime-topology store now rejects a genuinely-invalid topology at write time
// (a seat with a bad weight / relationship / roleHint, or a malformed phase) instead of
// storing it to fail opaquely at run time — while still ACCEPTING an under-specified but
// defaultable seat (a strict superset of the prior shallow id/arity check).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeTopology, getRuntimeTopology, _resetRuntimeTopologiesCache } from "./runtime-topologies.js";

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "illuci-runtime-topo-"));
  const storeFile = join(root, "runtime-topologies.json");
  try {
    return fn(storeFile);
  } finally {
    _resetRuntimeTopologiesCache();
    rmSync(root, { recursive: true, force: true });
  }
}

const goodSeats = [
  { id: "author", label: "Author", min: 1, max: 1, roleHint: "implementer", weight: 1.0, relationships: [{ type: "precedes", target: "reviewer", semantics: "submits-to" }] },
  { id: "reviewer", label: "Reviewer", min: 1, max: 1, roleHint: "reviewer", weight: 0.8, relationships: [] },
];
const goodPhases = [
  { id: "draft", type: "single", seat: "author", input: "prompt" },
  { id: "review", type: "single", seat: "reviewer", input: "phase:draft" },
];

test("a well-formed runtime topology is created and stored", () => {
  withStore((storeFile) => {
    const t = createRuntimeTopology("wf", { name: "WF", seats: goodSeats, phases: goodPhases }, { storeFile });
    assert.ok(t);
    assert.equal(t.runtime, true);
    assert.equal(getRuntimeTopology("wf", { storeFile }).id, "wf");
  });
});

test("superset: an under-specified but defaultable seat (no weight/label) is still accepted and stored RAW", () => {
  withStore((storeFile) => {
    const t = createRuntimeTopology("min", {
      seats: [{ id: "a", min: 1, max: 1, roleHint: "analyst", relationships: [] }], // no weight, no label
      phases: [{ id: "p", type: "single", seat: "a", input: "prompt" }],
    }, { storeFile });
    assert.ok(t, "a defaultable seat must not be rejected — the runner normalizes at run time");
    assert.equal(t.seats[0].weight, undefined, "stored shape is unchanged (no store-time normalization)");
  });
});

test("rejects a seat with an out-of-range weight", () => {
  withStore((storeFile) => {
    const t = createRuntimeTopology("badw", {
      seats: [{ id: "a", label: "A", min: 1, max: 1, weight: 5, relationships: [] }],
      phases: [{ id: "p", type: "single", seat: "a", input: "prompt" }],
    }, { storeFile });
    assert.equal(t, null);
    assert.equal(getRuntimeTopology("badw", { storeFile }), null, "an invalid topology is never persisted");
  });
});

test("rejects a seat with an unknown relationship type", () => {
  withStore((storeFile) => {
    const t = createRuntimeTopology("badr", {
      seats: [{ id: "a", label: "A", min: 1, max: 1, weight: 1, relationships: [{ type: "telepathy", target: "a", semantics: "loops" }] }],
      phases: [{ id: "p", type: "single", seat: "a", input: "prompt" }],
    }, { storeFile });
    assert.equal(t, null);
  });
});

test("rejects a malformed phase (neither seat nor seats)", () => {
  withStore((storeFile) => {
    const t = createRuntimeTopology("badp", {
      seats: goodSeats,
      phases: [{ id: "p", type: "single", input: "prompt" }],
    }, { storeFile });
    assert.equal(t, null);
  });
});

test("shallow invariants still hold (non-string id, empty id, empty seats/phases, reserved id)", () => {
  withStore((storeFile) => {
    assert.equal(createRuntimeTopology(42, { seats: goodSeats, phases: goodPhases }, { storeFile }), null);
    assert.equal(createRuntimeTopology("", { seats: goodSeats, phases: goodPhases }, { storeFile }), null);
    assert.equal(createRuntimeTopology("x", { seats: [], phases: goodPhases }, { storeFile }), null);
    assert.equal(createRuntimeTopology("x", { seats: goodSeats, phases: [] }, { storeFile }), null);
    assert.equal(createRuntimeTopology("direct", { seats: goodSeats, phases: goodPhases }, { storeFile, reservedIds: ["direct"] }), null);
  });
});

test("read-path: a hand-edited invalid stored topology is treated as absent (never runs)", () => {
  withStore((storeFile) => {
    // Inject directly, bypassing the write-path guard — simulating a hand-edited ~/.illuci file.
    writeFileSync(storeFile, JSON.stringify({ topologies: {
      corrupt: {
        id: "corrupt", name: "Corrupt", description: "", runtime: true,
        seats: [{ id: "a", label: "A", min: 1, max: 1, weight: 5, relationships: [] }], // weight 5 = invalid
        phases: [{ id: "p", type: "single", seat: "a", input: "prompt" }],
      },
    } }));
    _resetRuntimeTopologiesCache();
    assert.equal(getRuntimeTopology("corrupt", { storeFile }), null, "a corrupt stored topology must not load");
  });
});

test("read-path: a valid stored topology (including defaultable seats) still loads", () => {
  withStore((storeFile) => {
    writeFileSync(storeFile, JSON.stringify({ topologies: {
      ok: {
        id: "ok", name: "OK", description: "", runtime: true,
        seats: [{ id: "a", min: 1, max: 1, roleHint: "analyst", relationships: [] }], // no weight -> defaultable
        phases: [{ id: "p", type: "single", seat: "a", input: "prompt" }],
      },
    } }));
    _resetRuntimeTopologiesCache();
    const t = getRuntimeTopology("ok", { storeFile });
    assert.ok(t, "a valid (defaultable) stored topology must load");
    assert.equal(t.id, "ok");
  });
});
