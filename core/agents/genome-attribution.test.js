// node:test — behavioral attribution (DR-195): outcome-grounded, evidence-gated,
// capped confidence, and — the honest point — a NULL when the disposition's
// expression did not earn reinforcement (where salient would fire regardless).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_OUTCOMES,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CAP,
  scoreOutcomeQuality,
  computeBehavioralAttribution,
} from "./genome-attribution.js";

const good = (n) => Array.from({ length: n }, () => ({ substantive: true, chars: 800, gatePassed: true, marginalValue: 0.7, systemConfidence: 0.8 }));
const poor = (n) => Array.from({ length: n }, () => ({ substantive: false, chars: 40, gatePassed: false }));

test("scoreOutcomeQuality: substantive + gate-passing runs score high; thin/failing score low", () => {
  assert.equal(scoreOutcomeQuality([]).quality, 0);
  assert.ok(scoreOutcomeQuality(good(3)).quality >= 0.7);
  assert.equal(scoreOutcomeQuality(poor(3)).quality, 0);
  // an ungated (gatePassed: null) substantive run still counts — null is not failure.
  assert.ok(scoreOutcomeQuality([{ substantive: true, chars: 500, gatePassed: null }]).quality > 0);
});

test("attributes toward expressed poles ONLY when outcomes earned it — capped confidence", () => {
  const r = computeBehavioralAttribution({ salientMarkers: ["C1-Competence↑", "C3-Dutifulness↑"], outcomes: good(3) });
  assert.equal(r.reason, "attributed");
  assert.deepEqual(r.markers, ["C1-Competence↑", "C3-Dutifulness↑"]);
  assert.ok(r.confidence <= CONFIDENCE_CAP, "correlation, never claims high confidence");
  assert.equal(r.method, "outcome-conditioned/1");
});

test("THE HONEST NULL: poor outcomes → no markers (where salient would reinforce anyway)", () => {
  const r = computeBehavioralAttribution({ salientMarkers: ["C1-Competence↑"], outcomes: poor(3) });
  assert.equal(r.reason, "quality-below-floor");
  assert.deepEqual(r.markers, [], "a losing identity is NOT deepened");
  assert.ok(r.quality < CONFIDENCE_FLOOR);
});

test("evidence gate: fewer than MIN_OUTCOMES accrued → insufficient-evidence (unlike salient, which fires on run 1)", () => {
  const r = computeBehavioralAttribution({ salientMarkers: ["C1-Competence↑"], outcomes: good(MIN_OUTCOMES - 1) });
  assert.equal(r.reason, "insufficient-evidence");
  assert.deepEqual(r.markers, []);
});

test("no candidate facets → no attribution even with good outcomes", () => {
  const r = computeBehavioralAttribution({ salientMarkers: [], outcomes: good(3) });
  assert.equal(r.reason, "no-candidate-facets");
  assert.deepEqual(r.markers, []);
});

test("always returns the tagged lens shape (D3 record-completeness), even when null", () => {
  for (const r of [computeBehavioralAttribution({ outcomes: [] }), computeBehavioralAttribution({ salientMarkers: ["C1-Competence↑"], outcomes: good(3) })]) {
    assert.equal(r.tag, "behavioral");
    assert.equal(typeof r.quality, "number");
    assert.equal(typeof r.runs, "number");
    assert.ok(Array.isArray(r.markers));
  }
});
