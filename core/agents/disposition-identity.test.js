import { test } from "node:test";
import assert from "node:assert/strict";
import {
  band7,
  domainSlug,
  bandProfile,
  fingerprint,
  computeSalience,
  resolveSlugs,
  deriveIdentity,
  checkCorpusIntegrity,
  computeTensionPairs,
} from "./disposition-identity.js";
import { DISPOSITION_PRESETS } from "./disposition-presets.js";

// The steward profile (facets subset), which must slug to "O3C5E3A5N1".
const stewardFacets = {
  "O4-Actions": 0.35, "O5-Ideas": 0.60,
  "C1-Competence": 0.82, "C2-Order": 0.88, "C3-Dutifulness": 0.90,
  "C5-Self-Discipline": 0.88, "C6-Deliberation": 0.75,
  "E1-Warmth": 0.62, "E3-Assertiveness": 0.42,
  "A3-Altruism": 0.85, "A4-Compliance": 0.68, "A5-Modesty": 0.80,
  "N1-Anxiety": 0.30, "N5-Impulsiveness": 0.12,
};
const steward = { facets: stewardFacets, darkTriad: { machiavellianism: 0.08 }, enneagram: { core: 6, wing: 5, instinct: "sp" } };

test("band7 matches the A71 kernel worked example + endpoints", () => {
  assert.equal(band7(0.82), 5);
  assert.equal(band7(0.50), 3);
  assert.equal(band7(0.18), 1);
  assert.equal(band7(0), 0);
  assert.equal(band7(1), 6);
  assert.equal(band7(-0.5), 0);
  assert.equal(band7(NaN), 0);
});

test("domainSlug produces the ratified worked example", () => {
  assert.equal(domainSlug(stewardFacets), "O3C5E3A5N1");
});

test("bandProfile bands continuous params, keeps Enneagram categorical", () => {
  const l2 = bandProfile(steward);
  assert.equal(l2.facets["C3-Dutifulness"], 6); // 0.90 -> band 6
  assert.equal(l2.facets["N5-Impulsiveness"], 0); // 0.12 -> band 0
  assert.equal(l2.darkTriad.machiavellianism, 0); // 0.08 -> band 0
  assert.deepEqual(l2.enneagram, { core: 6, wing: 5, instinct: "sp" }); // untouched
});

test("fingerprint is deterministic, versioned, fixed-width", () => {
  const a = fingerprint(bandProfile(steward));
  const b = fingerprint(bandProfile(steward));
  assert.equal(a, b);
  assert.match(a, /^sha256v1:[0-9a-f]{16}$/);
});

test("computeSalience surfaces the extreme facets, not the mid ones", () => {
  const s = computeSalience(bandProfile(steward));
  assert.ok(s.includes("C3-Dutifulness↑")); // band 6, extreme high
  assert.ok(s.includes("N5-Impulsiveness↓")); // band 0, extreme low
  assert.ok(!s.some((x) => x.startsWith("C6-Deliberation"))); // 0.75 -> band 5, extremity 2 — borderline; not asserting
});

test("resolveSlugs: unique domain shapes keep the base slug", () => {
  const other = { id: "other", profile: { facets: { "O1-Fantasy": 0.9, "C1-Competence": 0.1, "E1-Warmth": 0.9, "A1-Trust": 0.1, "N1-Anxiety": 0.9 } } };
  const slugs = resolveSlugs([{ id: "steward", profile: steward }, other]);
  assert.equal(slugs.steward, "O3C5E3A5N1");
  assert.notEqual(slugs.other, slugs.steward);
});

test("resolveSlugs: same domain bands, different facets -> slug LENGTHENS to disambiguate", () => {
  // Both have C domain mean 0.70 (band 4) but swapped C1/C2; identical elsewhere -> same base slug, must extend.
  const a = { id: "a", profile: { facets: { "C1-Competence": 0.90, "C2-Order": 0.50, "O1-Fantasy": 0.5, "E1-Warmth": 0.5, "A1-Trust": 0.5, "N1-Anxiety": 0.5 } } };
  const b = { id: "b", profile: { facets: { "C1-Competence": 0.50, "C2-Order": 0.90, "O1-Fantasy": 0.5, "E1-Warmth": 0.5, "A1-Trust": 0.5, "N1-Anxiety": 0.5 } } };
  const slugs = resolveSlugs([a, b]);
  assert.notEqual(slugs.a, slugs.b); // disambiguated
  assert.ok(slugs.a.startsWith(domainSlug(a.profile.facets))); // extends the base, not replaces it
  assert.ok(slugs.a.includes("·")); // lengthened
});

test("deriveIdentity returns slug + banded L2 + fingerprint", () => {
  const id = deriveIdentity(steward);
  assert.equal(id.slug, "O3C5E3A5N1");
  assert.match(id.fingerprint, /^sha256v1:/);
  assert.equal(id.l2.facets["C3-Dutifulness"], 6);
});

test("checkCorpusIntegrity: the live preset corpus is integrity-clean (unique fingerprints, derivation-consistent slugs)", () => {
  const corpus = Object.values(DISPOSITION_PRESETS).map((p) => ({
    id: p.id,
    profile: p.profile,
    slug: p.id, // presets are slug-keyed (A72.2) — id IS the stored slug
    fingerprint: p.fingerprint,
  }));
  const r = checkCorpusIntegrity(corpus);
  assert.equal(
    r.ok,
    true,
    "corpus integrity: " +
      JSON.stringify({
        fingerprintCollisions: r.fingerprintCollisions,
        slugMismatches: r.slugMismatches,
        fingerprintMismatches: r.fingerprintMismatches,
      }),
  );
});

test("checkCorpusIntegrity BITES: a duplicated disposition collides; wrong stored slug/fingerprint is caught", () => {
  // 1. two ids, identical profile -> same fingerprint -> the dedup key catches the collision.
  const dup = checkCorpusIntegrity([
    { id: "a", profile: steward },
    { id: "b", profile: steward },
  ]);
  assert.equal(dup.ok, false);
  assert.equal(dup.fingerprintCollisions.length, 1);
  assert.deepEqual(dup.fingerprintCollisions[0].ids.slice().sort(), ["a", "b"]);
  // 2. a wrong stored slug + wrong stored fingerprint are both caught against the derivation.
  const wrong = checkCorpusIntegrity([
    { id: "x", profile: steward, slug: "WRONG", fingerprint: "sha256v1:0000000000000000" },
  ]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.slugMismatches.length, 1);
  assert.equal(wrong.fingerprintMismatches.length, 1);
});

test("computeTensionPairs: all three lenses fire on synthetic profiles, quiet on mid ones", () => {
  const curated = computeTensionPairs({ facets: { "E3-Assertiveness": 6, "A4-Compliance": 6 } });
  assert.equal(curated.length, 1);
  assert.equal(curated[0].kind, "curated");
  assert.deepEqual(curated[0].facets, ["E3-Assertiveness↑", "A4-Compliance↑"]);

  const domain = computeTensionPairs({ facets: { "C1-Competence": 6, "O5-Ideas": 6 } });
  assert.equal(domain.length, 1);
  assert.equal(domain[0].kind, "domain"); // C1×O5 is not a curated pair — domain lens only

  const structural = computeTensionPairs({ facets: { "C1-Competence": 6, "C5-Self-Discipline": 0 } });
  assert.equal(structural.length, 1);
  assert.equal(structural[0].kind, "structural");
  assert.deepEqual(structural[0].facets, ["C1-Competence↑", "C5-Self-Discipline↓"]);

  assert.deepEqual(computeTensionPairs({ facets: { "O1-Fantasy": 3, "C2-Order": 3 } }), []); // no extremity -> no tension
});

test("computeTensionPairs: domain lens collapses to one signal per opposition (not the facet cross-product)", () => {
  // four salient C-hi facets + one O-hi facet -> ONE C×O domain tension, not four.
  const t = computeTensionPairs({
    facets: { "C1-Competence": 6, "C2-Order": 6, "C3-Dutifulness": 6, "C4-Achievement-Striving": 6, "O5-Ideas": 6 },
  });
  const domain = t.filter((x) => x.kind === "domain");
  assert.equal(domain.length, 1, "domain lens must collapse, got: " + JSON.stringify(domain));
});

test("computeTensionPairs is deterministic and the curated table fires on the real corpus", () => {
  assert.deepEqual(computeTensionPairs(bandProfile(steward)), computeTensionPairs(bandProfile(steward)));
  let curatedHits = 0;
  for (const p of Object.values(DISPOSITION_PRESETS)) {
    const t = computeTensionPairs(bandProfile(p.profile));
    assert.ok(Array.isArray(t));
    curatedHits += t.filter((x) => x.kind === "curated").length;
  }
  assert.ok(curatedHits >= 1, "the curated tension table should fire on at least one real preset");
});
