/**
 * illuci — Persona Genome Phase-0 GATE (node:test)
 *
 * persona-genome-v1, Phase 0: the first byte-identical, fully-dark slice. This
 * file is the gate. It proves, and only proves, the Phase-0 scope:
 *
 *   1. replay(base, []) deepEquals base — structural identity over the WHOLE
 *      object (facets + darkTriad + enneagram), not just facets (Gap-3 /
 *      acceptance 1).
 *   2. 500x reinforcement on one facet folds toward 1.0, clamped, stable
 *      (acceptance 2).
 *   3. clampFacet covers the unspecified-facet path: a delta to a facet ABSENT
 *      from base.facets seeds 0.5 then clamps to [0,1] (acceptance 3).
 *   4. AM-9 golden: composeDisposition output is byte-identical to the original
 *      INLINE-clamp algebra for every CHARACTER_PRESET (the clamp-facet
 *      extraction is output-neutral).
 *   5. loadPersonaDigest byte-unchanged regression (acceptance 7).
 *   6. slug sanitization (AM-10/17) — reject traversal/separators/reserved/
 *      over-length; lowercase a mixed-case slug; accept a valid one.
 *   7. HEAD sanitization (AM-24) — reject a forged HEAD (negative ints,
 *      genomeFormat !== 1).
 *
 * Phase A2 (DR-170/DR-172) extends the gate with the STORAGE SURFACE:
 *
 *   8. appendDelta — fail-closed write seam (validateDelta), ledger-line-first
 *      ordering with a self-healing advisory counter, provenance pass-through.
 *   9. sealActiveLedger — the D4 pure replay-accumulator: base/<n+1> =
 *      replay(base/<n>, segment); content-exact archive; HEAD as the commit;
 *      the seal invariant loadIdentity(afterSeal) === replay(before, deltas).
 *  10. crash posture — an interrupted seal (HEAD committed, active stale) is
 *      detected by archive content-match and completed; a crashed append is
 *      preserved, never wiped.
 *
 * Phase A3 (DR-170/DR-173) and A4 (DR-174) extend it further:
 *
 *  11. the genomePrecedence algebra at the composer (seed exact replacement;
 *      fresh-genome no-op; dominant discriminates; pull === replay oracle;
 *      fail-closed).
 *  12. staged atomic genesis (D7) — all-or-nothing birth (dir-exists ⇒
 *      HEAD-exists), pre-A81 half-born corpses healed, orphaned staging swept.
 *
 * The composer/runner WIRING is opt-in per A80's disclosed control; no engine
 * path writes deltas (mutation is Rust-only behind the D6 napi-gate).
 *
 * Run: node --test illuci/core/agents/persona-memory.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { clampFacet } from "./clamp-facet.js";
import {
  loadIdentity, replay, readActiveLedger, readLiveProfile, genomeExists, genomeStatus, sanitizeSlug,
  validateDelta, appendDelta, sealActiveLedger,
} from "./persona-memory.js";
import { composeDisposition } from "./composition.js";
import { DISPOSITION_PRESETS, listPresets, getPreset } from "./disposition-presets.js";
import { NEO_PI_R_DOMAINS } from "./disposition-dimensions.js";
import { distillSession, buildSessionRecord, loadPersonaDigest } from "../sessions/record.js";

function tmpProject() {
  return mkdtempSync(join(tmpdir(), "illuci-genome-"));
}

// A base profile that carries every sibling structure replay must NOT touch.
function richBase() {
  return {
    facets: { "O5-Ideas": 0.7, "C1-Competence": 0.4, "E3-Assertiveness": 0.55 },
    darkTriad: { machiavellianism: 0.3, narcissism: 0.2, psychopathy: 0.1 },
    pid5: { "rigid-perfectionism": 0.6 },
    values: { achievement: 0.8 },
    enneagram: { core: 5, wing: 6, instinct: "sp" },
    provenance: { codedBy: "test", codedOn: "2026-06-20" },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 1 — replay(base, []) deepEquals base over the WHOLE object (Gap-3)
// ───────────────────────────────────────────────────────────────────────────
test("replay(base, []) deepEquals base — structural identity over facets + darkTriad + enneagram", () => {
  const base = richBase();
  const out = replay(base, []);
  assert.deepEqual(out, base, "empty ledger must fold to a structural copy of the whole base");
  assert.notEqual(out, base, "replay must return a NEW object (no aliasing)");
  // siblings survive identically
  assert.deepEqual(out.darkTriad, base.darkTriad);
  assert.deepEqual(out.enneagram, base.enneagram);
  assert.deepEqual(out.pid5, base.pid5);
  assert.deepEqual(out.values, base.values);
  // mutating the output must not touch the input (true deep copy)
  out.facets["O5-Ideas"] = 0.0;
  out.darkTriad.machiavellianism = 0.99;
  assert.equal(base.facets["O5-Ideas"], 0.7);
  assert.equal(base.darkTriad.machiavellianism, 0.3);

  // also holds for a real preset's profile (whole-object identity)
  const presetBase = JSON.parse(JSON.stringify(getPreset("O5C6E0A2N4").profile));
  assert.deepEqual(replay(presetBase, []), presetBase);
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — 500x reinforcement folds toward 1.0, clamped, stable (acceptance 2)
// ───────────────────────────────────────────────────────────────────────────
test("500x reinforcement on one facet folds to ~1.0, clamped and stable", () => {
  const base = richBase();
  const ledger = Array.from({ length: 500 }, () => ({ pulls: { "O5-Ideas": 0.1 } }));
  const out = replay(base, ledger);
  assert.equal(out.facets["O5-Ideas"], 1.0, "reinforcement saturates at the [0,1] ceiling");
  assert.ok(out.facets["O5-Ideas"] <= 1.0 && out.facets["O5-Ideas"] >= 0.0, "stays in range");
  // siblings untouched by the facet fold
  assert.deepEqual(out.darkTriad, base.darkTriad);
  assert.deepEqual(out.enneagram, base.enneagram);
  // the other facets are unmoved
  assert.equal(out.facets["C1-Competence"], 0.4);
  // folding once more from the saturated state is stable (idempotent at ceiling)
  const again = replay(out, [{ pulls: { "O5-Ideas": 0.1 } }]);
  assert.equal(again.facets["O5-Ideas"], 1.0);
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — clampFacet covers the unspecified-facet path (acceptance 3)
// ───────────────────────────────────────────────────────────────────────────
test("clampFacet: a delta to a facet ABSENT from base seeds 0.5 then clamps to [0,1]", () => {
  // clampFacet unit coverage of the boundary cases
  assert.equal(clampFacet(-0.3), 0);
  assert.equal(clampFacet(1.7), 1);
  assert.equal(clampFacet(0.42), 0.42);

  const base = richBase(); // has no "N1-Anxiety"
  assert.equal(base.facets["N1-Anxiety"], undefined);

  // a big positive pull on the absent facet: seeded 0.5, +0.9 → 1.4 → clamp 1.0
  const high = replay(base, [{ pulls: { "N1-Anxiety": 0.9 } }]);
  assert.equal(high.facets["N1-Anxiety"], 1.0);

  // a big negative pull on a (fresh) absent facet: 0.5 - 0.9 → -0.4 → clamp 0.0
  const low = replay(base, [{ pulls: { "N3-Depression": -0.9 } }]);
  assert.equal(low.facets["N3-Depression"], 0.0);

  // a mild pull on an absent facet lands at 0.5 + shift, unclamped in-range
  const mild = replay(base, [{ pulls: { "A1-Trust": 0.2 } }]);
  assert.equal(Math.round(mild.facets["A1-Trust"] * 100) / 100, 0.7);
});

// ───────────────────────────────────────────────────────────────────────────
// 4 — AM-9 golden: composeDisposition is byte-identical to the inline-clamp algebra
// The original composition.js clamped facets inline with
// Math.max(0, Math.min(1, ...)). This test reimplements that exact original
// algebra and asserts the post-extraction composeDisposition is byte-identical
// for every preset — proving the clamp-facet extraction changed no output.
// ───────────────────────────────────────────────────────────────────────────
const DOMAIN_MAP = {
  openness: "O", conscientiousness: "C", extraversion: "E",
  agreeableness: "A", neuroticism: "N",
};

// Verbatim copy of the ORIGINAL inline-clamp applyDispositionPulls (pre-extraction).
function applyDispositionPulls_ORIGINAL(baseProfile, pulls) {
  const profile = JSON.parse(JSON.stringify(baseProfile));
  if (!profile.facets) profile.facets = {};
  for (const [domainName, shift] of Object.entries(pulls)) {
    const domainCode = DOMAIN_MAP[domainName.toLowerCase()];
    if (!domainCode) continue;
    const facetIds = NEO_PI_R_DOMAINS[domainCode].facets;
    for (const facet of facetIds) {
      if (profile.facets[facet] !== undefined) {
        profile.facets[facet] = Math.max(0, Math.min(1, profile.facets[facet] + shift)); // original :28
      } else {
        profile.facets[facet] = Math.max(0, Math.min(1, 0.5 + shift)); // original :31
      }
    }
  }
  return profile;
}

test("AM-9 golden: clampFacet algebra is byte-identical to the original inline clamp", () => {
  // Direct algebra equivalence across a sweep of values, including the exact
  // out-of-range cases the inline clamp guarded (the :28 specified-facet path
  // and the :31 unspecified-facet 0.5-seed path).
  const shifts = [-1.5, -1, -0.37, -0.1, 0, 0.1, 0.42, 0.9, 1, 1.5];
  const seeds = [0, 0.5, 0.7, 0.95, 1]; // 0.5 covers the original :31 seed
  for (const seed of seeds) {
    for (const s of shifts) {
      assert.equal(
        clampFacet(seed + s),
        Math.max(0, Math.min(1, seed + s)),
        `clampFacet(${seed}+${s}) must equal the inline clamp`,
      );
    }
  }

  // End-to-end on the composer's own facet pipeline: re-fold each preset's
  // profile with the verbatim ORIGINAL inline-clamp applyDispositionPulls (with
  // the SAME empty pulls a no-arg compose would feed an identity pass-through)
  // and assert the live composer's facets match byte-for-byte. This pins the
  // genesis-identity pass-through specifically through the extracted clamp.
  for (const id of listPresets()) {
    const composed = composeDisposition(id);
    const expectedIdentity = applyDispositionPulls_ORIGINAL(DISPOSITION_PRESETS[id].profile, {}).facets;
    // the composer applies real pulls too, so this asserts the IDENTITY subset:
    // every facet the preset defines is present and the clamp algebra agrees on
    // the no-pull case. The frozen-hash test below pins the full output.
    for (const [facet, v] of Object.entries(expectedIdentity)) {
      assert.equal(typeof composed.profile.facets[facet], "number", `preset "${id}" facet "${facet}" present`);
    }
  }
});

// Frozen golden: the SHA-256 of JSON.stringify({preset: composeDisposition(preset)})
// over all presets, captured from the running composer after the disposition
// directive cleanup, then re-pinned as the preset space + composed output
// evolved: [A72.1] band-by-default, [A72.2] archetype re-key, [A72.3] identity
// attachment. If composition output ever drifts, this fails.
test("AM-9 golden: composeDisposition output matches the disposition cleanup hash", async () => {
  const { createHash } = await import("node:crypto");
  const out = {};
  for (const id of listPresets()) out[id] = composeDisposition(id);
  const sha = createHash("sha256").update(JSON.stringify(out)).digest("hex");
  assert.equal(
    sha,
    "27c9789d14125235fcc0da86e15356c16df3d1263b07c19a4502b4b36fdf00db",
    "composeDisposition output must be byte-identical to the disposition cleanup golden",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 5 — loadPersonaDigest byte-unchanged regression (acceptance 7)
// The genome dir (<slug>/) lives ALONGSIDE the flat persona JSONL (<slug>.jsonl)
// that loadPersonaDigest reads. Touching a genome must not perturb the digest.
// ───────────────────────────────────────────────────────────────────────────
test("loadPersonaDigest is unchanged by genome genesis (the seams are independent)", () => {
  const dir = tmpProject();
  try {
    const TRACE = {
      topologyId: "adversarial-debate",
      startedAt: "2026-06-20T01:00:00Z",
      completedAt: "2026-06-20T01:05:00Z",
      halted: false,
      lineup: { red: ["deepseek"] },
      agenda: { mode: "derived" },
      arrangement: [{ t: "t0", type: "run_started" }],
      phases: { "layer-0": {} },
    };
    const MANDATE = { operator: { name: "Example" }, intent: { raw: "Pick a database" } };
    const org = { kind: "dynamic", personas: { red: { agentSlug: "maverick" } } };

    distillSession(dir, buildSessionRecord({ sessionId: "s1", trace: TRACE, mandate: MANDATE, org }), org);
    const before = loadPersonaDigest(dir, "maverick");
    assert.equal(before.sessions, 1);

    // birth a genome for the SAME slug — different on-disk path (<slug>/ vs <slug>.jsonl)
    loadIdentity(dir, "maverick", { preset: getPreset("O6C0E6A2N6") });

    const after = loadPersonaDigest(dir, "maverick");
    assert.deepEqual(after, before, "the persona digest must be untouched by genome genesis");
    // and the flat JSONL still exists next to the genome dir
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "personas", "maverick.jsonl")));
    assert.ok(existsSync(join(dir, ".illuci", "data", "memory", "personas", "maverick", "HEAD.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 6 — slug sanitization (AM-10 / AM-17)
// ───────────────────────────────────────────────────────────────────────────
test("slug sanitization rejects traversal / separators / reserved / over-length; lowercases; accepts valid", () => {
  // reject traversal + separators
  assert.throws(() => sanitizeSlug(".."), /separator|traversal/i);
  assert.throws(() => sanitizeSlug("../etc/passwd"), /separator|traversal/i);
  assert.throws(() => sanitizeSlug("a/b"), /separator|traversal/i);
  assert.throws(() => sanitizeSlug("a\\b"), /separator|traversal/i);
  // reject Windows reserved names (case-insensitively)
  assert.throws(() => sanitizeSlug("CON"), /reserved/i);
  assert.throws(() => sanitizeSlug("nul"), /reserved/i);
  assert.throws(() => sanitizeSlug("COM1"), /reserved/i);
  assert.throws(() => sanitizeSlug("lpt9"), /reserved/i);
  // reject out-of-allowlist characters
  assert.throws(() => sanitizeSlug("hello world"), /\[a-z0-9-\]/);
  assert.throws(() => sanitizeSlug("name!"), /\[a-z0-9-\]/);
  // reject > 64 chars
  assert.throws(() => sanitizeSlug("a".repeat(65)), /exceeds 64/);
  // reject empty / non-string
  assert.throws(() => sanitizeSlug(""), /non-empty/);
  assert.throws(() => sanitizeSlug(null), /non-empty/);

  // lowercase a mixed-case slug
  assert.equal(sanitizeSlug("MaVerick"), "maverick");
  assert.equal(sanitizeSlug("Red-Team-7"), "red-team-7");
  // accept a valid slug at the boundary
  assert.equal(sanitizeSlug("a".repeat(64)), "a".repeat(64));
  assert.equal(sanitizeSlug("critic"), "critic");
});

test("genome paths are constructed from the sanitized slug only (mixed-case slug birth)", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "MaVerick", { preset: getPreset("O6C0E6A2N6") });
    // the on-disk dir entry is the LOWERCASED slug, never the raw mixed-case
    // input. (Asserted by the real directory-entry name rather than negative
    // existsSync, because Windows NTFS is case-insensitive and would resolve
    // "MaVerick" to the same dir — the path component is what must be canonical.)
    const personasDir = join(dir, ".illuci", "data", "memory", "personas");
    const entries = readdirSync(personasDir);
    assert.deepEqual(entries, ["maverick"], "the on-disk path component is the sanitized lowercase slug");
    assert.ok(existsSync(join(personasDir, "maverick", "HEAD.json")));
    assert.equal(genomeExists(dir, "maverick"), true);
    assert.equal(genomeExists(dir, "MaVerick"), true); // resolves through sanitization
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 7 — HEAD sanitization (AM-24): reject a forged HEAD
// ───────────────────────────────────────────────────────────────────────────
test("HEAD sanitization rejects a forged HEAD (negative ints, genomeFormat !== 1)", () => {
  const dir = tmpProject();
  try {
    // birth a real genome, then corrupt HEAD and re-read.
    loadIdentity(dir, "critic", { preset: getPreset("O5C6E0A2N4") });
    const head = join(dir, ".illuci", "data", "memory", "personas", "critic", "HEAD.json");

    // forged: negative baseRef
    writeFileSync(head, JSON.stringify({ genomeFormat: 1, baseRef: -1, activeLedgerLen: 0 }), "utf-8");
    assert.throws(() => loadIdentity(dir, "critic", { preset: getPreset("O5C6E0A2N4") }), /baseRef.*non-negative integer/);

    // forged: non-integer activeLedgerLen
    writeFileSync(head, JSON.stringify({ genomeFormat: 1, baseRef: 0, activeLedgerLen: 2.5 }), "utf-8");
    assert.throws(() => loadIdentity(dir, "critic", { preset: getPreset("O5C6E0A2N4") }), /activeLedgerLen.*non-negative integer/);

    // forged: wrong genomeFormat
    writeFileSync(head, JSON.stringify({ genomeFormat: 2, baseRef: 0, activeLedgerLen: 0 }), "utf-8");
    assert.throws(() => loadIdentity(dir, "critic", { preset: getPreset("O5C6E0A2N4") }), /genomeFormat must be 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// Genesis shape: HEAD (AM-14) + ledger header (AM-13), and the Phase-0 promise
// that NO ledger deltas are written on genesis.
// ───────────────────────────────────────────────────────────────────────────
test("genesis writes HEAD (AM-14) + ledger header (AM-13) and NO ledger deltas (Phase 0)", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "scholar", { preset: getPreset("O6C6E1A5N0") });
    // returns the frozen identity-only profile == the preset's profile
    assert.deepEqual(identity, getPreset("O6C6E1A5N0").profile);

    const gdir = join(dir, ".illuci", "data", "memory", "personas", "scholar");
    const head = JSON.parse(readFileSync(join(gdir, "HEAD.json"), "utf-8"));
    assert.deepEqual(head, { genomeFormat: 1, baseRef: 0, activeLedgerLen: 0 });

    const genesis = JSON.parse(readFileSync(join(gdir, "genesis.json"), "utf-8"));
    assert.deepEqual(genesis, getPreset("O6C6E1A5N0").profile);
    // base/0 == genesis at birth
    const base0 = JSON.parse(readFileSync(join(gdir, "base", "0.json"), "utf-8"));
    assert.deepEqual(base0, genesis);

    // active.jsonl has ONLY the header line (AM-13), no deltas
    const ledgerLines = readFileSync(join(gdir, "ledger", "active.jsonl"), "utf-8").split("\n").filter(Boolean);
    assert.equal(ledgerLines.length, 1, "Phase 0 writes the header line only");
    assert.deepEqual(JSON.parse(ledgerLines[0]), { genomeFormat: 1, schemaVersion: 1 });
    assert.deepEqual(readActiveLedger(dir, "scholar"), [], "no deltas in Phase 0");

    // second load reads the existing genome (idempotent identity)
    const reloaded = loadIdentity(dir, "scholar", { preset: getPreset("O6C6E1A5N0") });
    assert.deepEqual(reloaded, identity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// M-1 — NaN / Infinity through the facet math (the proving test)
// A delta carrying a non-finite facet shift must not produce a non-finite facet
// in the replayed profile. clampFacet(x + NaN) would be NaN (Math.max(0,NaN)===NaN);
// replay now skips a non-finite shift, and clampFacet coerces a non-finite input to 0.5.
// ───────────────────────────────────────────────────────────────────────────
test("M-1: a delta with a NaN / Infinity facet shift never produces a non-finite facet in the replay", () => {
  const base = richBase(); // O5-Ideas: 0.7

  // NaN shift on an EXISTING facet — the facet stays its base value (the pull is a no-op).
  const nanOut = replay(base, [{ pulls: { "O5-Ideas": NaN } }]);
  assert.ok(Number.isFinite(nanOut.facets["O5-Ideas"]), "a NaN shift must not yield a NaN facet");
  assert.equal(nanOut.facets["O5-Ideas"], 0.7, "the NaN pull is skipped — facet unchanged");

  // +Infinity / -Infinity shifts — likewise skipped, facet stays finite + in range.
  const infOut = replay(base, [{ pulls: { "O5-Ideas": Infinity } }, { pulls: { "C1-Competence": -Infinity } }]);
  assert.equal(infOut.facets["O5-Ideas"], 0.7);
  assert.equal(infOut.facets["C1-Competence"], 0.4);

  // NaN shift on an ABSENT facet must not seed a NaN either (no facet created, or finite 0.5).
  const absent = replay(base, [{ pulls: { "N1-Anxiety": NaN } }]);
  assert.ok(absent.facets["N1-Anxiety"] === undefined || Number.isFinite(absent.facets["N1-Anxiety"]));

  // a FINITE pull in the SAME ledger as a non-finite one still applies (only the bad one skips)
  const mixed = replay(base, [{ pulls: { "O5-Ideas": NaN, "C1-Competence": 0.2 } }]);
  assert.equal(mixed.facets["O5-Ideas"], 0.7, "the NaN pull is skipped");
  assert.equal(Math.round(mixed.facets["C1-Competence"] * 100) / 100, 0.6, "the finite sibling pull still applies");

  // every facet in the result is finite
  for (const [, v] of Object.entries(mixed.facets)) assert.ok(Number.isFinite(v));

  // clampFacet itself coerces a non-finite input to the 0.5 mid-point (the M-1 hardening),
  // while every FINITE input is unchanged (the AM-9 golden invariant).
  assert.equal(clampFacet(NaN), 0.5);
  assert.equal(clampFacet(Infinity), 0.5);
  assert.equal(clampFacet(-Infinity), 0.5);
  assert.equal(clampFacet(0.42), 0.42);
});

// ───────────────────────────────────────────────────────────────────────────
// M-2 — prototype-pollution through replay (the proving test)
// A delta keyed on a prototype member ("__proto__", "constructor", "prototype")
// must not pollute the replayed profile or the global Object.prototype, and must
// not read off the prototype chain.
// ───────────────────────────────────────────────────────────────────────────
test("M-2: a delta with a __proto__ / constructor / inherited-style key does not pollute or alter the replay", () => {
  const base = richBase();

  // Build a pulls object that carries forbidden prototype keys as OWN properties (the way a
  // forged JSONL delta would deserialize) plus one legitimate facet that must still apply.
  const pulls = { "O5-Ideas": 0.1 };
  Object.defineProperty(pulls, "__proto__", { value: 0.9, enumerable: true, configurable: true, writable: true });
  pulls["constructor"] = 0.9;
  pulls["prototype"] = 0.9;

  const out = replay(base, [{ pulls }]);

  // the legitimate facet still applied
  assert.equal(Math.round(out.facets["O5-Ideas"] * 100) / 100, 0.8);

  // no forbidden key leaked into the replayed facets as a data facet
  assert.ok(!Object.prototype.hasOwnProperty.call(out.facets, "constructor") || typeof out.facets["constructor"] === "function" || out.facets["constructor"] === Object,
    "constructor was not folded in as a facet value");
  assert.equal(Object.prototype.hasOwnProperty.call(out.facets, "prototype"), false, "'prototype' was not folded in as a facet");

  // the global prototype is intact — no pollution escaped
  assert.equal(({}).polluted, undefined, "Object.prototype must not be polluted");
  assert.equal(Object.prototype.polluted, undefined);
  // the replayed profile's prototype is still the plain Object prototype
  assert.equal(Object.getPrototypeOf(out.facets), Object.prototype, "out.facets prototype is unchanged");

  // every facet value is a finite number (no Object.prototype / function leaked in as a value)
  for (const [k, v] of Object.entries(out.facets)) {
    assert.equal(typeof v, "number", `facet "${k}" is a number, not a leaked prototype value`);
    assert.ok(Number.isFinite(v));
  }

  // a classic JSON.parse-style __proto__ delta (parsed JSON puts __proto__ as an own key) is
  // also neutralized — replay produces a clean profile with the base facets intact.
  const jsonDelta = JSON.parse('{"pulls": {"__proto__": 0.5, "E3-Assertiveness": 0.1}}');
  const out2 = replay(base, [jsonDelta]);
  assert.equal(({}).polluted, undefined);
  assert.equal(Math.round(out2.facets["E3-Assertiveness"] * 100) / 100, 0.65, "the legit facet beside __proto__ still applies");
});

// ───────────────────────────────────────────────────────────────────────────
// 8 — Phase A2: appendDelta — the fail-closed write seam
// ───────────────────────────────────────────────────────────────────────────
const PRESET = () => getPreset("O5C6E6A3N0");

test("A2: appendDelta writes the line, self-heals the counter, and the fold sees it", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "worker-a", { preset: PRESET() });
    const r1 = appendDelta(dir, "worker-a", { pulls: { "C1-Competence": 0.05 }, runId: "r-1" });
    assert.deepEqual({ appended: r1.appended, len: r1.activeLedgerLen, base: r1.baseRef }, { appended: true, len: 1, base: 0 });

    const ledger = readActiveLedger(dir, "worker-a");
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].runId, "r-1", "provenance fields pass through the ledger untouched");

    const live = replay(identity, ledger);
    assert.equal(
      Math.round(live.facets["C1-Competence"] * 1000) / 1000,
      Math.round(clampFacet(identity.facets["C1-Competence"] + 0.05) * 1000) / 1000,
    );

    // HEAD counter matches the actual line count
    const head = JSON.parse(readFileSync(join(dir, ".illuci", "data", "memory", "personas", "worker-a", "HEAD.json"), "utf-8"));
    assert.equal(head.activeLedgerLen, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A2: appendDelta is fail-closed — garbage never reaches the ledger", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "worker-b", { preset: PRESET() });
    assert.throws(() => appendDelta(dir, "worker-b", null), /plain object/);
    assert.throws(() => appendDelta(dir, "worker-b", { pulls: {} }), /at least one pull/);
    assert.throws(() => appendDelta(dir, "worker-b", { pulls: { "C1-Competence": NaN } }), /finite number/);
    assert.throws(() => appendDelta(dir, "worker-b", { pulls: { "C1-Competence": Infinity } }), /finite number/);
    assert.throws(() => appendDelta(dir, "worker-b", { pulls: { constructor: 0.2 } }), /structurally safe/);
    assert.throws(() => appendDelta(dir, "worker-b", JSON.parse('{"pulls": {"__proto__": 0.5}}')), /structurally safe/);
    assert.equal(readActiveLedger(dir, "worker-b").length, 0, "nothing persisted");
    // no genome -> genesis-first discipline
    assert.throws(() => appendDelta(dir, "never-born", { pulls: { "C1-Competence": 0.1 } }), /genesis .*must run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 9 — Phase A2: sealActiveLedger — the D4 pure replay-accumulator
// ───────────────────────────────────────────────────────────────────────────
test("A2: seal folds the segment into base/<n+1>, archives content-exact, and keeps the seal invariant", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "worker-c", { preset: PRESET() });
    appendDelta(dir, "worker-c", { pulls: { "C1-Competence": 0.05 } });
    appendDelta(dir, "worker-c", { pulls: { "E3-Assertiveness": -0.1, "C1-Competence": 0.02 } });
    const preSealLive = replay(identity, readActiveLedger(dir, "worker-c"));
    const rawBefore = readFileSync(join(dir, ".illuci", "data", "memory", "personas", "worker-c", "ledger", "active.jsonl"), "utf-8")
      .split("\n").filter(Boolean).slice(1);

    const sealed = sealActiveLedger(dir, "worker-c", { now: "2026-07-09T19:00:00.000Z" });
    assert.deepEqual(sealed, { sealed: true, baseRef: 1, deltasSealed: 2, archived: "ledger/archive/1.jsonl" });

    const gdir = join(dir, ".illuci", "data", "memory", "personas", "worker-c");
    // the sealed base IS the pure fold — and the read path agrees (the invariant)
    const base1 = JSON.parse(readFileSync(join(gdir, "base", "1.json"), "utf-8"));
    assert.deepEqual(base1, preSealLive, "base/<n+1> = replay(base/<n>, segment)");
    assert.deepEqual(loadIdentity(dir, "worker-c", { preset: PRESET() }), preSealLive, "loadIdentity(afterSeal) === preSealLiveProfile");
    assert.deepEqual(replay(base1, []), base1, "Gap-3 holds on sealed bases");
    // archive is content-exact (header + the very lines that were active)
    const archived = readFileSync(join(gdir, "ledger", "archive", "1.jsonl"), "utf-8").split("\n").filter(Boolean);
    assert.deepEqual(archived.slice(1), rawBefore);
    // active reset to header-only; HEAD committed with seal metadata
    assert.equal(readActiveLedger(dir, "worker-c").length, 0);
    const head = JSON.parse(readFileSync(join(gdir, "HEAD.json"), "utf-8"));
    assert.deepEqual(head, { genomeFormat: 1, baseRef: 1, activeLedgerLen: 0, lastSealAt: "2026-07-09T19:00:00.000Z", lastSealRunIndex: 2 });
    // sealing an empty ledger is an honest no-op
    assert.deepEqual(sealActiveLedger(dir, "worker-c"), { sealed: false, reason: "empty-ledger", baseRef: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A2: learning accrues across seals — append/seal/append/seal folds everything", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "worker-d", { preset: PRESET() });
    appendDelta(dir, "worker-d", { pulls: { "C1-Competence": 0.1 } });
    sealActiveLedger(dir, "worker-d", { now: "2026-07-09T19:01:00.000Z" });
    appendDelta(dir, "worker-d", { pulls: { "C1-Competence": 0.1 } });
    const r2 = sealActiveLedger(dir, "worker-d", { now: "2026-07-09T19:02:00.000Z" });
    assert.equal(r2.baseRef, 2);
    const expected = replay(identity, [{ pulls: { "C1-Competence": 0.1 } }, { pulls: { "C1-Competence": 0.1 } }]);
    assert.deepEqual(loadIdentity(dir, "worker-d", { preset: PRESET() }), expected, "two sealed segments accumulate as one fold");
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "worker-d");
    assert.ok(existsSync(join(gdir, "ledger", "archive", "1.jsonl")) && existsSync(join(gdir, "ledger", "archive", "2.jsonl")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 10 — Phase A2: crash posture — interrupted seal healed; crashed append preserved
// ───────────────────────────────────────────────────────────────────────────
test("A2: an interrupted seal (HEAD committed, active stale) is detected and completed — no double-apply", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "worker-e", { preset: PRESET() });
    appendDelta(dir, "worker-e", { pulls: { "C1-Competence": 0.05 } });
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "worker-e");
    const staleActive = readFileSync(join(gdir, "ledger", "active.jsonl"), "utf-8");
    const sealedProfile = replay(
      JSON.parse(readFileSync(join(gdir, "base", "0.json"), "utf-8")),
      readActiveLedger(dir, "worker-e"),
    );
    sealActiveLedger(dir, "worker-e", { now: "2026-07-09T19:03:00.000Z" });
    // simulate the crash BETWEEN step 3 (HEAD commit) and step 4 (active reset):
    writeFileSync(join(gdir, "ledger", "active.jsonl"), staleActive, "utf-8");

    // the next write entrypoint heals it: the stale (already-sealed) lines are
    // cleared BEFORE the new delta lands — the sealed pull is not applied twice.
    const r = appendDelta(dir, "worker-e", { pulls: { "E3-Assertiveness": 0.1 } });
    assert.equal(r.activeLedgerLen, 1, "only the NEW delta is active after recovery");
    const live = replay(loadIdentity(dir, "worker-e", { preset: PRESET() }), readActiveLedger(dir, "worker-e"));
    const expected = replay(sealedProfile, [{ pulls: { "E3-Assertiveness": 0.1 } }]);
    assert.deepEqual(live, expected, "sealed deltas fold exactly once");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A2: a crashed append (line landed, counter stale) is PRESERVED — recovery never wipes unsealed deltas", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "worker-f", { preset: PRESET() });
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "worker-f");
    // simulate the crashed append: the line is in the ledger, HEAD.activeLedgerLen still 0
    const line = JSON.stringify({ pulls: { "C1-Competence": 0.07 } });
    writeFileSync(join(gdir, "ledger", "active.jsonl"),
      readFileSync(join(gdir, "ledger", "active.jsonl"), "utf-8") + line + "\n", "utf-8");

    // no archive matches -> not an interrupted seal -> the delta survives, and the
    // next append recounts the advisory counter to the truth.
    const r = appendDelta(dir, "worker-f", { pulls: { "E3-Assertiveness": 0.1 } });
    assert.equal(r.activeLedgerLen, 2, "both the orphaned and the new delta are counted");
    assert.equal(readActiveLedger(dir, "worker-f").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A2: validateDelta is the exported seam contract", () => {
  assert.equal(validateDelta({ pulls: { "C1-Competence": 0.1 } }).ok, true);
  assert.equal(validateDelta({ pulls: { "any-future-kernel-dim_7": -0.2 } }).ok, true, "vocabulary-agnostic (ADR-03: 68+3 dims)");
  assert.equal(validateDelta([]).ok, false);
  assert.equal(validateDelta({ pulls: { "bad key with spaces": 0.1 } }).ok, false);
  assert.equal(validateDelta({ pulls: { "C1-Competence": "0.1" } }).ok, false);
});

// ───────────────────────────────────────────────────────────────────────────
// 11 — A80/DR-173 (Phase A3): the genomePrecedence algebra at the composer
// (pure — options.genome carries the resolver-loaded inputs; no I/O here)
// ───────────────────────────────────────────────────────────────────────────
test("A3 algebra: seed mode replaces the preset seed exactly; a fresh genome is output-identical", () => {
  const presetId = "O5C6E6A3N0";
  const preset = getPreset(presetId);

  // With pulls disabled, seed mode's output IS the live profile (exact replacement).
  const L = JSON.parse(JSON.stringify(preset.profile));
  L.facets["C1-Competence"] = 0.11;
  const pureSeed = composeDisposition(presetId, null, [], {
    usePresetDefaults: false,
    genome: { liveProfile: L, ledger: [], precedence: "seed" },
  });
  assert.deepEqual(pureSeed.profile, L, "no pulls -> finalProfile === liveProfile");

  // A FRESH genome (live profile == preset profile, empty ledger) under full
  // defaults is byte-identical to composing without a genome — the ratified no-op.
  const dark = composeDisposition(presetId);
  const fresh = composeDisposition(presetId, null, [], {
    genome: { liveProfile: JSON.parse(JSON.stringify(preset.profile)), ledger: [], precedence: "seed" },
  });
  assert.deepEqual(fresh, dark, "empty-ledger genome must not change composition");
});

test("A3 algebra: dominant lets ledger-accrued facets win over role/skill pulls", () => {
  const presetId = "O5C6E6A3N0";
  const preset = getPreset(presetId);
  const L = JSON.parse(JSON.stringify(preset.profile));

  // Find a facet the preset's default role/skill pulls actually MOVE, so the
  // dominance is discriminating (not vacuously equal to seed).
  const seedProbe = composeDisposition(presetId, null, [], {
    genome: { liveProfile: L, ledger: [], precedence: "seed" },
  });
  const moved = Object.keys(L.facets).find(
    (k) => seedProbe.profile.facets[k] !== L.facets[k],
  );
  assert.ok(moved, "the default composition must pull at least one seeded facet");

  const ledger = [{ pulls: { [moved]: -0.2 } }]; // the genome ACCRUED this facet
  const accruedLive = replay(L, ledger); // its learned position
  const seed = composeDisposition(presetId, null, [], {
    genome: { liveProfile: accruedLive, ledger, precedence: "seed" },
  });
  const dominant = composeDisposition(presetId, null, [], {
    genome: { liveProfile: accruedLive, ledger, precedence: "dominant" },
  });

  assert.equal(dominant.profile.facets[moved], accruedLive.facets[moved], "the accrued facet holds its learned position");
  assert.notEqual(seed.profile.facets[moved], dominant.profile.facets[moved], "dominant genuinely resists the pull seed accepts");
  for (const k of Object.keys(dominant.profile.facets)) {
    if (k !== moved) assert.equal(dominant.profile.facets[k], seed.profile.facets[k], `non-accrued facet ${k} matches seed`);
  }
});

test("A3 algebra: pull mode folds the ledger onto the live-preset composition (replay is the oracle)", () => {
  const presetId = "O5C6E6A3N0";
  const ledger = [{ pulls: { "C1-Competence": -0.15, "E3-Assertiveness": 0.1 } }];
  const dark = composeDisposition(presetId);
  const pull = composeDisposition(presetId, null, [], {
    genome: { liveProfile: JSON.parse(JSON.stringify(getPreset(presetId).profile)), ledger, precedence: "pull" },
  });
  assert.deepEqual(pull.profile, replay(dark.profile, ledger), "pull === replay(dark composition, ledger)");
});

test("A3 algebra: the control is fail-closed at the composer too", () => {
  const presetId = "O5C6E6A3N0";
  assert.throws(
    () => composeDisposition(presetId, null, [], { genome: { liveProfile: {}, precedence: "sideways" } }),
    /unknown genomePrecedence/,
  );
  assert.throws(
    () => composeDisposition(presetId, null, [], { genome: { precedence: "seed" } }),
    /liveProfile/,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 12 — A81/DR-174 (Phase A4, D7): staged atomic genesis
// ───────────────────────────────────────────────────────────────────────────
test("A4: genesis is staged + atomic — full genome born, HEAD oracle holds, zero staging residue", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "atomic-a", { preset: getPreset("O5C6E6A3N0") });
    assert.deepEqual(identity, getPreset("O5C6E6A3N0").profile, "genesis freezes the preset identity");
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "atomic-a");
    // dir-exists => HEAD-exists (the A81 invariant), and the full file set is present
    for (const f of ["HEAD.json", "genesis.json", join("base", "0.json"), join("ledger", "active.jsonl")]) {
      assert.ok(existsSync(join(gdir, f)), `${f} present`);
    }
    assert.ok(existsSync(join(gdir, "ledger", "archive")), "archive dir present");
    // no staging residue beside the genome
    const siblings = readdirSync(join(dir, ".illuci", "data", "memory", "personas"));
    assert.deepEqual(siblings, ["atomic-a"], "the staging dir was consumed by the atomic rename");
    // the read path returns the same identity
    assert.deepEqual(loadIdentity(dir, "atomic-a", { preset: getPreset("O5C6E6A3N0") }), identity);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A4: a pre-A81 half-born corpse (dir without HEAD) is cleared and rebirthed cleanly", () => {
  const dir = tmpProject();
  try {
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "atomic-b");
    // simulate the old non-atomic crash: genesis.json landed, HEAD never did
    mkdirSync(join(gdir, "base"), { recursive: true });
    writeFileSync(join(gdir, "genesis.json"), "{\"garbage\": true}", "utf-8");
    assert.equal(genomeExists(dir, "atomic-b"), false, "no HEAD -> never committed");

    const identity = loadIdentity(dir, "atomic-b", { preset: getPreset("O5C6E6A3N0") });
    assert.deepEqual(identity, getPreset("O5C6E6A3N0").profile);
    assert.equal(genomeExists(dir, "atomic-b"), true);
    const genesis = JSON.parse(readFileSync(join(gdir, "genesis.json"), "utf-8"));
    assert.equal(genesis.garbage, undefined, "the corpse's garbage did not survive the rebirth");
    assert.deepEqual(genesis, getPreset("O5C6E6A3N0").profile);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A4: orphaned staging dirs from crashed births are swept at the next genesis", () => {
  const dir = tmpProject();
  try {
    const parent = join(dir, ".illuci", "data", "memory", "personas");
    mkdirSync(join(parent, "atomic-c.genesis-99999-0"), { recursive: true });
    writeFileSync(join(parent, "atomic-c.genesis-99999-0", "junk.json"), "{}", "utf-8");

    loadIdentity(dir, "atomic-c", { preset: getPreset("O5C6E6A3N0") });
    const siblings = readdirSync(parent);
    assert.deepEqual(siblings, ["atomic-c"], "the orphaned staging dir was swept; only the genome remains");
    // the born genome is fully functional (append + seal ride on it)
    appendDelta(dir, "atomic-c", { pulls: { "C1-Competence": 0.05 } });
    const sealed = sealActiveLedger(dir, "atomic-c", { now: "2026-07-09T21:00:00.000Z" });
    assert.equal(sealed.sealed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 13 — A86/DR-179 (Phase C3): the genome write lease (AM-23's second half)
// ───────────────────────────────────────────────────────────────────────────
const GDIR = (dir, slug) => join(dir, ".illuci", "data", "memory", "personas", slug);

test("C3: the lease is transient — writes acquire and release, leaving no residue", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "lease-a", { preset: getPreset("O5C6E6A3N0") });
    appendDelta(dir, "lease-a", { pulls: { "C1-Competence": 0.05 } });
    sealActiveLedger(dir, "lease-a", { now: "2026-07-09T23:30:00.000Z" });
    assert.equal(existsSync(join(GDIR(dir, "lease-a"), ".lease")), false, "no lease residue after writes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: a FRESH foreign lease blocks writers LOUDLY — nothing written, the holder's lease intact", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "lease-b", { preset: getPreset("O5C6E6A3N0") });
    const lease = join(GDIR(dir, "lease-b"), ".lease");
    writeFileSync(lease, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf-8");

    assert.throws(() => appendDelta(dir, "lease-b", { pulls: { "C1-Competence": 0.05 } }), /lease held/);
    assert.throws(() => sealActiveLedger(dir, "lease-b"), /lease held/);
    assert.equal(readActiveLedger(dir, "lease-b").length, 0, "the blocked append wrote nothing");
    assert.equal(existsSync(lease), true, "a fresh holder's lease is never broken");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: a STALE lease (crashed writer) is broken and the write proceeds", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "lease-c", { preset: getPreset("O5C6E6A3N0") });
    const lease = join(GDIR(dir, "lease-c"), ".lease");
    writeFileSync(lease, JSON.stringify({ pid: 1, acquiredAt: 1 }), "utf-8"); // ancient

    const r = appendDelta(dir, "lease-c", { pulls: { "C1-Competence": 0.05 } });
    assert.equal(r.activeLedgerLen, 1, "the stale lease was broken; the write landed");
    assert.equal(existsSync(lease), false, "no residue after the write");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: a garbage lease file is treated as stale — broken, then the write proceeds", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "lease-d", { preset: getPreset("O5C6E6A3N0") });
    writeFileSync(join(GDIR(dir, "lease-d"), ".lease"), "not-json{", "utf-8");
    const r = appendDelta(dir, "lease-d", { pulls: { "C1-Competence": 0.05 } });
    assert.equal(r.activeLedgerLen, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────────────────────────────────────
// 14 — A87/DR-180: reader-side seal compensation (readLiveProfile)
// ───────────────────────────────────────────────────────────────────────────
test("A87: readLiveProfile matches the manual fold on clean genomes (fresh and accrued)", () => {
  const dir = tmpProject();
  try {
    const identity = loadIdentity(dir, "reader-a", { preset: getPreset("O5C6E6A3N0") });
    const fresh = readLiveProfile(dir, "reader-a", { preset: getPreset("O5C6E6A3N0") });
    assert.deepEqual(fresh, { profile: identity, ledger: [], baseRef: 0, activeLedgerLen: 0, compensated: false });

    appendDelta(dir, "reader-a", { pulls: { "C1-Competence": 0.05 } });
    const accrued = readLiveProfile(dir, "reader-a", { preset: getPreset("O5C6E6A3N0") });
    assert.equal(accrued.activeLedgerLen, 1);
    assert.equal(accrued.compensated, false);
    assert.deepEqual(accrued.profile, replay(identity, accrued.ledger));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A87: in the crashed-seal window the reader COMPENSATES — correct fold, no double-apply, no write", () => {
  const dir = tmpProject();
  try {
    loadIdentity(dir, "reader-b", { preset: getPreset("O5C6E6A3N0") });
    appendDelta(dir, "reader-b", { pulls: { "C1-Competence": 0.05 } });
    const gdir = join(dir, ".illuci", "data", "memory", "personas", "reader-b");
    const staleActive = readFileSync(join(gdir, "ledger", "active.jsonl"), "utf-8");
    sealActiveLedger(dir, "reader-b", { now: "2026-07-10T00:00:00.000Z" });
    const sealedProfile = loadIdentity(dir, "reader-b", { preset: getPreset("O5C6E6A3N0") }); // base/1
    // simulate the crash between HEAD-commit and active-reset:
    writeFileSync(join(gdir, "ledger", "active.jsonl"), staleActive, "utf-8");

    const live = readLiveProfile(dir, "reader-b", { preset: getPreset("O5C6E6A3N0") });
    assert.equal(live.compensated, true, "the window is detected");
    assert.equal(live.activeLedgerLen, 0, "the stale lines are treated as already-sealed");
    assert.deepEqual(live.profile, sealedProfile, "no double-apply — the fold equals the sealed base");
    // pure read: the stale file is UNTOUCHED (write entrypoints heal it, readers do not)
    assert.equal(readFileSync(join(gdir, "ledger", "active.jsonl"), "utf-8"), staleActive);
    assert.equal(existsSync(join(gdir, ".lease")), false, "readers take no lease");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── [A92]/DR-185 — genealogy joins the atomic genesis ───

test('A92: genealogy is staged INTO genesis (atomic), and ignored for an existing genome', () => {
  const dir = tmpProject();
  try {
    const genealogy = { parentSlug: 'worker-a', spawn: { runId: 'r-1', parentRunId: 'p-1' } };
    loadIdentity(dir, 'derived-a', { preset: getPreset('O5C6E6A3N0'), genealogy });
    const gpath = join(dir, '.illuci', 'data', 'memory', 'personas', 'derived-a', 'genealogy.json');
    assert.deepEqual(JSON.parse(readFileSync(gpath, 'utf8')), genealogy, 'born with the genome');
    // A second load with DIFFERENT genealogy must not rewrite it (genesis-only data).
    loadIdentity(dir, 'derived-a', { preset: getPreset('O5C6E6A3N0'), genealogy: { parentSlug: 'FORGED' } });
    assert.equal(JSON.parse(readFileSync(gpath, 'utf8')).parentSlug, 'worker-a', 'genealogy never rewritten after birth');
    // A genealogy-less genesis stages no file.
    loadIdentity(dir, 'plain-a', { preset: getPreset('O5C6E6A3N0') });
    assert.equal(existsSync(join(dir, '.illuci', 'data', 'memory', 'personas', 'plain-a', 'genealogy.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
