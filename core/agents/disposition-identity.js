/**
 * illuci — parameter-derived disposition identity ([A72], DR-162).
 *
 * A disposition is a parameter configuration, NOT a named persona. Its identity
 * is DERIVED from the banded profile — no AI-invented names. Ratified schema
 * (crucible walk + illuci debate `biyk83dhf`):
 *
 *   - slug        variable-resolution legible id. Big-Five domain bands by
 *                 default ("O3C5E3A5N1"); LENGTHENS on collision with the
 *                 discriminating facet bands, minimal length necessary.
 *   - l2 (facets) every banded parameter — AUTHORITATIVE identity content.
 *   - fingerprint "sha256v1:..." opaque fixed-width dedup key over canonical L2.
 *   - salience    NOT stored — computeSalience(l2, opts) registered function.
 *
 * Authority chain: L2 is truth; slug + fingerprint are derivative; salience is
 * computed. In any conflict, L2 wins.
 *
 * Values are BANDED BY DEFAULT (band7) — 0.88/0.90/0.82 collapse to one band,
 * killing false precision. band7 mirrors the A71 Rust kernel (`fixed.rs` band7).
 *
 * @module core/agents/disposition-identity
 */

import { createHash } from "node:crypto";

/** Quantize v in [0,1] to 7 bands (0..6). Matches kernel fixed.rs: floor(v*7), clamped. */
export function band7(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 6;
  return Math.min(6, Math.floor(v * 7));
}

const BIG_FIVE = ["O", "C", "E", "A", "N"];
const ILLUCI_FACET = /^[OCEAN][1-6]-/; // e.g. "C6-Deliberation"
const BAND_MID = 3; // band7 midpoint

/** Mean of a domain's NEO-PI-R facets, banded. Domain = facet-key first letter. */
function domainBand(facets, domain) {
  const vals = Object.entries(facets)
    .filter(([k]) => k[0] === domain && ILLUCI_FACET.test(k))
    .map(([, v]) => v);
  if (!vals.length) return 0;
  return band7(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/** The base (L1) domain slug: one band digit per Big-Five domain. e.g. "O3C5E3A5N1". */
export function domainSlug(facets) {
  return BIG_FIVE.map((d) => d + domainBand(facets, d)).join("");
}

/** Band every continuous parameter; keep the Enneagram as its normalized category. */
export function bandProfile(profile) {
  const bandObj = (o) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, band7(v)])) : {};
  return {
    facets: bandObj(profile.facets),
    darkTriad: bandObj(profile.darkTriad),
    pid5: bandObj(profile.pid5),
    values: bandObj(profile.values),
    // Enneagram is categorical (ADR-03): render-only, normalized, NOT banded.
    enneagram: profile.enneagram ? { ...profile.enneagram } : null,
  };
}

/** Deterministic canonical serialization (sorted keys) of the banded L2, for hashing. */
function canonicalize(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalize(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

/** Opaque fixed-width dedup key over the canonical banded L2. Versioned prefix. */
export function fingerprint(bandedL2) {
  const h = createHash("sha256").update(canonicalize(bandedL2)).digest("hex");
  return "sha256v1:" + h.slice(0, 16);
}

/**
 * Registered canonical salience function — NOT a stored field. Returns the top-N
 * facets by extremity (distance from band midpoint) with an up/down marker. An
 * agent may pass weights to re-rank for a task; tension pairs are the companion
 * computeTensionPairs (DR-168).
 */
export function computeSalience(bandedL2, { topN = 4, minExtremity = 2, weights = null } = {}) {
  const facets = bandedL2.facets || {};
  return Object.entries(facets)
    .map(([k, b]) => {
      const w = weights && weights[k] != null ? weights[k] : 1;
      return { k, b, extremity: Math.abs(b - BAND_MID) * w };
    })
    .filter((x) => x.extremity >= minExtremity)
    .sort((a, b) => b.extremity - a.extremity)
    .slice(0, topN)
    .map((x) => `${x.k}${x.b >= BAND_MID ? "↑" : "↓"}`);
}

/**
 * Corpus-level: assign each disposition a UNIQUE variable-resolution slug. Base =
 * domainSlug; colliding groups lengthen with the highest-variance facet bands
 * until unique. `dispositions`: [{ id, profile }]. Returns { id -> slug }.
 */
export function resolveSlugs(dispositions) {
  const banded = dispositions.map((d) => ({
    id: d.id,
    l2: bandProfile(d.profile),
    base: domainSlug(d.profile.facets),
  }));
  const groups = {};
  for (const d of banded) (groups[d.base] ||= []).push(d);
  let out = {};
  for (const [base, group] of Object.entries(groups)) {
    out = { ...out, ...extendUntilUnique(group, base, new Set()) };
  }
  return out;
}

/** Recursively append the highest-variance (unused) facet band until each id is unique. */
function extendUntilUnique(group, prefix, usedFacets) {
  if (group.length === 1) return { [group[0].id]: prefix };
  const facetKeys = Object.keys(group[0].l2.facets).filter((k) => !usedFacets.has(k));
  let best = null;
  let bestSpread = -1;
  for (const k of facetKeys) {
    const bands = group.map((g) => g.l2.facets[k] ?? BAND_MID);
    const spread = Math.max(...bands) - Math.min(...bands);
    if (spread > bestSpread) {
      bestSpread = spread;
      best = k;
    }
  }
  if (best === null || bestSpread === 0) {
    // No discriminating facet left — fall back to a fingerprint suffix (guaranteed unique).
    const out = {};
    for (const g of group) out[g.id] = `${prefix}·${fingerprint(g.l2).slice(-4)}`;
    return out;
  }
  const used2 = new Set(usedFacets).add(best);
  const sub = {};
  for (const g of group) {
    const key = `${prefix}·${best}${g.l2.facets[best] ?? BAND_MID}`;
    (sub[key] ||= []).push(g);
  }
  let out = {};
  for (const [key, sg] of Object.entries(sub)) {
    out = { ...out, ...extendUntilUnique(sg, key, used2) };
  }
  return out;
}

/** Full derived identity for a single disposition (base slug; corpus assigns the final unique slug). */
export function deriveIdentity(profile) {
  const l2 = bandProfile(profile);
  return { slug: domainSlug(profile.facets), l2, fingerprint: fingerprint(l2) };
}

/**
 * Corpus-integrity guard — the first real CONSUMER of the fingerprint dedup key
 * and of resolveSlugs at runtime. Verifies the three invariants the DR-162 model
 * promises across a disposition corpus:
 *   1. every fingerprint is UNIQUE — no two dispositions are secretly identical
 *      after banding (this is what the "dedup key" is FOR);
 *   2. each stored `slug` equals the corpus-resolved slug — slug is DERIVED,
 *      L2 is truth (DR-162 authority chain), so a stored slug must match;
 *   3. each stored `fingerprint` equals the fingerprint re-derived from the
 *      profile — catches stored-vs-derived drift.
 * Stored `slug` / `fingerprint` are checked only when present, so a bare
 * [{ id, profile }] corpus still gets the uniqueness guarantee.
 *
 * @param {Array<{id:string, profile:object, slug?:string, fingerprint?:string}>} dispositions
 * @returns {{ ok:boolean, fingerprintCollisions:Array<{fingerprint:string, ids:string[]}>, slugMismatches:Array, fingerprintMismatches:Array }}
 */
export function checkCorpusIntegrity(dispositions) {
  const resolved = resolveSlugs(dispositions.map((d) => ({ id: d.id, profile: d.profile })));
  const byFingerprint = {};
  const fingerprintMismatches = [];
  const slugMismatches = [];
  for (const d of dispositions) {
    const derived = fingerprint(bandProfile(d.profile));
    (byFingerprint[derived] ||= []).push(d.id);
    if (d.fingerprint != null && d.fingerprint !== derived) {
      fingerprintMismatches.push({ id: d.id, stored: d.fingerprint, derived });
    }
    if (d.slug != null && resolved[d.id] !== d.slug) {
      slugMismatches.push({ id: d.id, stored: d.slug, derived: resolved[d.id] });
    }
  }
  const fingerprintCollisions = Object.entries(byFingerprint)
    .filter(([, ids]) => ids.length > 1)
    .map(([fp, ids]) => ({ fingerprint: fp, ids }));
  return {
    ok: fingerprintCollisions.length === 0 && slugMismatches.length === 0 && fingerprintMismatches.length === 0,
    fingerprintCollisions,
    slugMismatches,
    fingerprintMismatches,
  };
}

/**
 * Curated cross-facet tension pairs — the psychology-grounded lens. Each entry is
 * two facets that pull against each other when BOTH are salient in the given
 * directions ("hi" = band >= midpoint, "lo" = below). Justified from NEO-PI-R
 * facet semantics and the textured roster's coded tensions (disposition-presets.js).
 * A seed set for learning (DR-168), not fixed truth — the learning layer reweights.
 */
export const TENSION_PAIRS = [
  { a: "E3-Assertiveness", aDir: "hi", b: "A4-Compliance", bDir: "hi", note: "social dominance held with deference — leads, then yields" },
  { a: "C6-Deliberation", aDir: "hi", b: "E5-Excitement-Seeking", bDir: "hi", note: "caution against thrill-seeking — measured yet drawn to risk" },
  { a: "C2-Order", aDir: "hi", b: "O4-Actions", bDir: "hi", note: "need for structure against appetite for novelty — builds order it then disrupts" },
  { a: "A3-Altruism", aDir: "hi", b: "N2-Angry-Hostility", bDir: "hi", note: "active care alongside a hostile streak — gives, then resents" },
  { a: "E1-Warmth", aDir: "hi", b: "A5-Modesty", bDir: "lo", note: "warmth toward others paired with self-promotion — draws people while claiming the stage" },
  { a: "C1-Competence", aDir: "hi", b: "N6-Vulnerability", bDir: "hi", note: "felt capability that crumbles under acute stress" },
  { a: "O6-Values", aDir: "hi", b: "C3-Dutifulness", bDir: "hi", note: "openness to reexamining the rules bound to adherence to them" },
];

/**
 * Domain-opposition lens — coarser. A salient facet in domain A (given direction)
 * against one in domain B. Big-Five metatrait-adjacent oppositions (stability vs
 * plasticity; approach vs avoidance).
 */
export const DOMAIN_OPPOSITIONS = [
  { a: "C", aDir: "hi", b: "O", bDir: "hi", note: "conscientious structure against openness to change (stability vs plasticity)" },
  { a: "E", aDir: "hi", b: "N", bDir: "hi", note: "outward approach against inward distress (approach vs avoidance)" },
];

const dirMark = (dir) => (dir === "hi" ? "↑" : "↓");

/**
 * Tension pairs among a disposition's SALIENT facets — computeSalience's opt-in
 * companion (DR-168). Emits every detected tension across THREE lenses, each tagged
 * by `kind` so a downstream learning layer can weigh them (the operator's "all of
 * the above if we are to learn"):
 *   - "curated"    a justified TENSION_PAIRS entry, both facets salient in-direction;
 *   - "domain"     two salient facets in opposing DOMAIN_OPPOSITIONS domains/directions;
 *   - "structural" two salient facets in the SAME domain pulling opposite ways.
 * Operates on the banded NEO facets (same scope + minExtremity default as
 * computeSalience). Deterministic. Learning-READY signal only — the learning loop
 * that consumes it is the persona-genome thread, not this function.
 *
 * @param {object} bandedL2
 * @param {{minExtremity?:number}} [opts]
 * @returns {Array<{kind:"curated"|"domain"|"structural", facets:[string,string], note:string}>}
 */
export function computeTensionPairs(bandedL2, { minExtremity = 2 } = {}) {
  const facets = bandedL2.facets || {};
  const salient = Object.entries(facets)
    .filter(([k]) => ILLUCI_FACET.test(k))
    .map(([k, b]) => ({ k, dir: b >= BAND_MID ? "hi" : "lo", ext: Math.abs(b - BAND_MID) }))
    .filter((x) => x.ext >= minExtremity);
  const byKey = Object.fromEntries(salient.map((s) => [s.k, s]));
  const domainOf = (k) => k[0];
  const out = [];

  // 1. curated cross-facet pairs
  for (const t of TENSION_PAIRS) {
    const a = byKey[t.a];
    const b = byKey[t.b];
    if (a && b && a.dir === t.aDir && b.dir === t.bDir) {
      out.push({ kind: "curated", facets: [t.a + dirMark(t.aDir), t.b + dirMark(t.bDir)], note: t.note });
    }
  }
  // 2. domain oppositions — ONE signal per fired opposition, using the most-extreme
  //    facet on each side (ties broken by key), NOT the full facet cross-product
  //    (which is combinatorial noise: many C-hi facets each pairing with each O-hi facet).
  for (const o of DOMAIN_OPPOSITIONS) {
    const pick = (dom, dir) =>
      salient
        .filter((s) => domainOf(s.k) === dom && s.dir === dir)
        .sort((x, y) => y.ext - x.ext || (x.k < y.k ? -1 : 1))[0];
    const a = pick(o.a, o.aDir);
    const b = pick(o.b, o.bDir);
    if (a && b) {
      out.push({ kind: "domain", facets: [a.k + dirMark(a.dir), b.k + dirMark(b.dir)], note: o.note });
    }
  }
  // 3. structural intra-domain splits (same domain, opposite direction)
  const byDomain = {};
  for (const s of salient) (byDomain[domainOf(s.k)] ||= []).push(s);
  for (const group of Object.values(byDomain)) {
    for (const h of group.filter((s) => s.dir === "hi")) {
      for (const l of group.filter((s) => s.dir === "lo")) {
        out.push({ kind: "structural", facets: [h.k + "↑", l.k + "↓"], note: `same-domain split: ${h.k} high but ${l.k} low` });
      }
    }
  }
  return out;
}

export default {
  band7,
  domainSlug,
  bandProfile,
  fingerprint,
  computeSalience,
  resolveSlugs,
  deriveIdentity,
  checkCorpusIntegrity,
  computeTensionPairs,
  TENSION_PAIRS,
  DOMAIN_OPPOSITIONS,
};
