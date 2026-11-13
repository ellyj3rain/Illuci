// Phase F harden — STRESS: the awareness bus under a broadcaster storm.
//
// Drives the REAL public store API (publish / getAdapter / recall), not the ring
// adapter in isolation (that has its own unit cover in awareness.test.js). The
// hardened contract: the store's append path is a non-yielding critical section, so
// N concurrent publishers lose ZERO events and the live count is EXACT. Against the
// un-hardened ring a concurrent head-mutation race drops or overwrites events; this
// suite asserts the post-harden invariant, so it is written to the intended contract.
//
// node:test only (vitest cannot run here, by batch decree). Read-only on the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as store from "./store.js";
import { createInMemoryRingAdapter } from "./in-memory-ring.js";

// 64 publishers × M events — the spec's broadcaster shape. Capacity sized ABOVE the
// total load so any loss is a race, never ring self-eviction.
const PUBLISHERS = 64;
const PER_PUBLISHER = 50;
const TOTAL = PUBLISHERS * PER_PUBLISHER; // 3200

test("awareness store: 64 concurrent broadcasters lose zero events, exact count", async () => {
  store.reset();
  store.setAdapter(createInMemoryRingAdapter({ capacity: TOTAL + 64 }));

  // Each publisher awaits between publishes, so the 64 broadcaster timelines interleave
  // on the event loop — the exact concurrent-append condition the harden guards.
  async function broadcaster(p) {
    for (let i = 0; i < PER_PUBLISHER; i++) {
      store.publish({
        company: "stress-co",
        topologyId: `topo-${p}`,
        seatId: `seat-${p}`,
        kind: "dispatch.out",
        summary: `p${p}-e${i}`,
        tags: ["stress"],
      });
      await Promise.resolve(); // yield, forcing interleave across publishers
    }
  }

  await Promise.all(Array.from({ length: PUBLISHERS }, (_, p) => broadcaster(p)));

  const all = store.getAdapter().snapshot();
  assert.equal(all.length, TOTAL, `every published event landed (expected ${TOTAL}, got ${all.length})`);

  // Exactness: each (publisher, event) pair appears exactly once — no slot was
  // overwritten by a racing append, none silently dropped.
  const summaries = new Set(all.map((e) => e.summary));
  assert.equal(summaries.size, TOTAL, "all events distinct — none overwrote another's slot");
  for (let p = 0; p < PUBLISHERS; p++) {
    for (let i = 0; i < PER_PUBLISHER; i++) {
      assert.ok(summaries.has(`p${p}-e${i}`), `event p${p}-e${i} present`);
    }
  }

  // Every event carries a unique id — the store's monotonic seq did not collide under load.
  const ids = new Set(all.map((e) => e.id));
  assert.equal(ids.size, TOTAL, "all event ids unique under concurrent publish");

  store.reset();
});

test("awareness store: concurrent publish + recall stays coherent (no torn read)", async () => {
  store.reset();
  store.setAdapter(createInMemoryRingAdapter({ capacity: TOTAL + 64 }));

  const budget = { maxEvents: 20, maxTokens: 8000, perEventTokenCeiling: 384 };
  let recallErrors = 0;

  async function broadcaster(p) {
    for (let i = 0; i < PER_PUBLISHER; i++) {
      store.publish({ company: "co", topologyId: `t-${p}`, seatId: `s-${p}`, summary: `p${p}-e${i}`, tags: ["x"] });
      await Promise.resolve();
    }
  }
  // A reader hammering recall WHILE publishers write must never throw or read a torn entry.
  async function reader() {
    for (let i = 0; i < 200; i++) {
      try {
        const out = store.recall({ company: "co", excludeTopologyId: "t-none", tags: ["x"], budget });
        assert.ok(Array.isArray(out), "recall returns an array");
        for (const e of out) assert.equal(typeof e.summary, "string", "no torn event");
      } catch {
        recallErrors++;
      }
      await Promise.resolve();
    }
  }

  await Promise.all([
    ...Array.from({ length: PUBLISHERS }, (_, p) => broadcaster(p)),
    reader(),
    reader(),
  ]);

  assert.equal(recallErrors, 0, "recall never threw under concurrent publish");
  assert.equal(store.getAdapter().snapshot().length, TOTAL, "all events still landed despite concurrent recall");

  store.reset();
});
