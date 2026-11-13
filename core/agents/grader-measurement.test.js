import { test } from "node:test";
import assert from "node:assert/strict";

import { collectGraderInput, GRADER_INPUT_SCHEMA } from "./grader-measurement.js";
import { assessCompositionConsistency } from "../governance/assess.js";

// Synthetic composition_resolved PAYLOADS (the unwrapped `.payload` shape the
// runner records: { engine, edges, disposition } — see runner.js / assess.js).
const ev = (seatId, fingerprint, extra = {}) => ({
  engine: "dimensional",
  edges: { topologyId: "t1", seatId, modelId: "m1", presetId: "O5C6E6A3N0", role: "implementer", skills: [] },
  disposition: {
    fingerprint,
    baseFingerprint: "sha256v1:48654656600997a2",
    slug: "O5C6E6A3N0",
    activeFacets: 12, activeDarkTriad: 1, activePid5: 0, activeValues: 3,
    enneagramCore: 3, directiveCount: 1,
    ...extra,
  },
});

const EVENTS = [
  ev("builder", "sha256v1:aaaaaaaaaaaaaaaa"),
  ev("builder", "sha256v1:aaaaaaaaaaaaaaaa"),
  ev("builder", "sha256v1:bbbbbbbbbbbbbbbb"), // a drifted composition
  ev("reviewer", "sha256v1:cccccccccccccccc"), // other seat — excluded from builder provenance
];

test("collectGraderInput emits all three lenses, tagged, and is deterministic", () => {
  const a = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: EVENTS });
  const b = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: EVENTS });
  assert.deepEqual(a, b); // pure — same inputs, same record
  assert.equal(a.schema, GRADER_INPUT_SCHEMA);
  assert.equal(a.seatId, "builder");
  assert.equal(a.lenses.consistency.tag, "consistency");
  assert.equal(a.lenses.tension.tag, "tension");
  assert.equal(a.lenses.provenance.tag, "provenance");
});

test("the consistency lens is assessCompositionConsistency verbatim", () => {
  const record = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: EVENTS });
  const direct = assessCompositionConsistency(EVENTS, "builder");
  assert.deepEqual(record.lenses.consistency, { tag: "consistency", ...direct });
});

test("the provenance lens carries the A76 fingerprint trail, seat-scoped", () => {
  const p = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: EVENTS }).lenses.provenance;
  assert.equal(p.runCount, 3); // reviewer's event excluded
  assert.equal(p.distinctFingerprints, 2); // aaa…, bbb…
  assert.equal(p.fingerprint, "sha256v1:bbbbbbbbbbbbbbbb"); // latest
  assert.equal(p.baseFingerprint, "sha256v1:48654656600997a2");
});

test("the tension lens fires from the preset profile (DR-168 lenses, kind-tagged)", () => {
  const t = collectGraderInput({ seatId: "builder", presetId: "O5C6E6A3N0", events: [] }).lenses.tension;
  assert.ok(t.pairs.length >= 1, "O5C6E6A3N0 carries known tensions (A75)");
  assert.ok(t.pairs.every((x) => ["curated", "domain", "structural"].includes(x.kind) && x.facets.length === 2));
});

test("empty inputs produce a well-formed, quiet record", () => {
  const r = collectGraderInput({ seatId: "ghost", events: [] });
  assert.equal(r.schema, GRADER_INPUT_SCHEMA);
  assert.equal(r.presetId, null);
  assert.equal(r.lenses.provenance.runCount, 0);
  assert.equal(r.lenses.provenance.fingerprint, null);
  assert.deepEqual(r.lenses.tension.pairs, []); // no profile resolves — no tension claimed
});

// ─── [A91]/DR-184 — the lineage tag + the run-tree fallback partition ───

import { collectRunTreeIds } from "./grader-measurement.js";

test("A91: the lineage tag rides the record verbatim; absent lineage adds nothing", () => {
  const lineage = { runId: "dev-team-1-0", parentRunId: null, depth: 0 };
  const tagged = collectGraderInput({ seatId: "builder", events: EVENTS, lineage });
  assert.deepEqual(tagged.lineage, lineage);
  const untagged = collectGraderInput({ seatId: "builder", events: EVENTS });
  assert.equal("lineage" in untagged, false);
});

test("A91: collectRunTreeIds resolves the connected tree to a fixpoint regardless of window order", () => {
  const edge = (runId, parentRunId) => ({ edges: { runId, parentRunId, seatId: "s" } });
  const payloads = [
    edge("grandchild", "child"), // deliberately BEFORE its parent's own link
    edge("unrelated-b", "unrelated-a"),
    edge("child", "root"),
    edge("sibling", "root"),
  ];
  const ids = collectRunTreeIds(payloads, "root", null);
  assert.deepEqual([...ids].sort(), ["child", "grandchild", "root", "sibling"]);
  assert.equal(ids.has("unrelated-a"), false, "a disjoint tree stays out");
  assert.equal(collectRunTreeIds(payloads, null, null).size, 0, "no seed, empty set");
});
