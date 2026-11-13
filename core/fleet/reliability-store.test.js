// core/fleet/reliability-store.test.js — [A48]/DR-128
import test from "node:test";
import assert from "node:assert/strict";
import { createReliabilityStore, decayCell, scoreCell, NEUTRAL } from "./reliability-store.js";

test("an unseen (model,role) scores NEUTRAL — never auto-preferred, never auto-condemned", () => {
  const s = createReliabilityStore();
  assert.equal(s.score("kimi-cloud", "auditor"), NEUTRAL);
  assert.equal(s.evidence("kimi-cloud", "auditor"), 0);
});

test("consistent success converges above neutral; consistent failure below", () => {
  let t = 1_000_000;
  const s = createReliabilityStore({ now: () => t });
  for (let i = 0; i < 20; i++) { s.record("good", "r", true); t += 1000; }
  for (let i = 0; i < 20; i++) { s.record("bad", "r", false); t += 1000; }
  assert.ok(s.score("good", "r") > 0.9, `good should be high, got ${s.score("good", "r")}`);
  assert.ok(s.score("bad", "r") < 0.1, `bad should be low, got ${s.score("bad", "r")}`);
});

test("decay: an old failure is nearly forgiven after a half-life", () => {
  let t = 0;
  const s = createReliabilityStore({ now: () => t, halfLifeMs: 1000 });
  for (let i = 0; i < 10; i++) s.record("x", "r", false); // heavy recent failure
  const low = s.score("x", "r");
  assert.ok(low < 0.2, `fresh failures score low, got ${low}`);
  t += 10_000; // ten half-lives later
  s.record("x", "r", true); // one fresh success
  assert.ok(s.score("x", "r") > 0.5, `decayed failures forgiven, one fresh success lifts it: ${s.score("x", "r")}`);
});

test("scoreCell/decayCell are pure and match the prior math", () => {
  assert.equal(scoreCell({ success: 0, total: 0 }), NEUTRAL);
  assert.equal(scoreCell({ success: 8, total: 8, ts: 0 }, { priorWeight: 2 }), (8 + 1) / (8 + 2));
  const d = decayCell({ success: 4, total: 4, ts: 0 }, 1000, 1000); // one half-life
  assert.ok(Math.abs(d.success - 2) < 1e-9 && Math.abs(d.total - 2) < 1e-9);
});

test("persistence round-trips through inject-able load/persist", () => {
  let saved = {};
  let t = 5000;
  const a = createReliabilityStore({ now: () => t, persist: (snap) => { saved = snap; } });
  a.record("m", "r", true); a.record("m", "r", false);
  const b = createReliabilityStore({ now: () => t, load: () => saved });
  assert.equal(b.score("m", "r"), a.score("m", "r"));
});

test("forget drops a departed model's rows across all roles", () => {
  const s = createReliabilityStore();
  s.record("gone", "a", true); s.record("gone", "b", false); s.record("stay", "a", true);
  assert.equal(s.forget("gone"), 2);
  assert.equal(s.score("gone", "a"), NEUTRAL); // back to prior
  assert.ok(s.evidence("stay", "a") > 0);
});
