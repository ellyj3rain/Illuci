/**
 * illuci — Persona Genome (per-persona memory, file-only)
 *
 * Phase 0 of persona-genome-v1 (the ratified Legislature resolution). This is
 * the first byte-identical, fully-dark slice: the READ + GENESIS path of a
 * per-persona disposition genome that lives entirely on the filesystem. NONE
 * of it is wired into the runner, the composer, or composeBehavioralDisposition
 * yet — the genome is exercised only by its own tests in Phase 0.
 *
 * What a genome is
 * ----------------
 * A persona (the durable `agentSlug` join key that survives a model hotswap —
 * see sessions/record.js) accrues experience. The genome is where that
 * experience folds back into the persona's *disposition*: a frozen identity
 * (genesis), a sequence of immutable base snapshots, and an append-only ledger
 * of facet deltas. The persona's live profile at any moment is
 * `replay(base, ledger)` — the latest base with every ledger delta folded in.
 *
 * Phase 0 builds only the read/genesis half:
 *   - lazy GENESIS: first touch freezes the preset's identity-only profile into
 *     genesis.json + base/0.json and writes a HEAD pointing at it. NO ledger
 *     lines are ever written in Phase 0.
 *   - replay: the structural fold (pure; deep-copies the whole base, applies
 *     each delta's facet pull to .facets ONLY via the shared clampFacet).
 *
 * Phase A2 (DR-170/DR-172) adds the STORAGE SURFACE for the learning half:
 * appendDelta (fail-closed delta write) and sealActiveLedger (the D4 pure
 * replay-accumulator segment writer: base/<n+1> = replay(base/<n>, segment)).
 * The delta VALUES come from the napi-gated Rust mutation core (DR-176); the
 * runtime learning step is the runner's grader seam (A84/DR-177); the seal
 * TRIGGER is the disclosed threshold control (A85/DR-178); and the write
 * paths are cross-process safe under the advisory lease (A86/DR-179 —
 * AM-23's second half). The grader's measurement half lives in
 * grader-measurement.js (A78/DR-171). Still deliberately absent:
 * perception re-keying.
 *
 * Storage (file-only; ZERO sqlite — AM-23)
 * ----------------------------------------
 *   <projectDir>/.illuci/data/memory/personas/<slug>/
 *     HEAD.json            — { genomeFormat, baseRef, activeLedgerLen, lastSealAt?, lastSealRunIndex? }
 *     genesis.json         — the frozen identity-only profile (immutable)
 *     base/<n>.json        — base snapshots; base/0 == genesis at genome birth
 *     ledger/active.jsonl  — append-only deltas (header line first)
 *     ledger/archive/<n>.jsonl — sealed segments; <n> = the base the seal produced
 *     .lease               — the advisory write lease (transient; stale-broken)
 *
 * This module imports NO sqlite, statically or dynamically. AM-23: any attempt
 * to dynamically import a sqlite driver through this module throws immediately,
 * so the file-only invariant cannot regress silently in a later phase.
 *
 * @module core/agents/persona-memory
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";

import { clampFacet } from "./clamp-facet.js";

const CONFIG_DIR = ".illuci";
const DATA_DIR = "data";
const GENOME_FORMAT = 1;
const LEDGER_SCHEMA_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────
// AM-23 — file-only guardrail
// This module is forbidden from reaching a sqlite driver. There is no static
// import; this guard makes a *dynamic* one throw, so the invariant cannot be
// re-introduced by a careless later phase. (The lockfile lease that AM-23 also
// names lands at Phase 3 — only the no-sqlite half of AM-23 is in scope here.)
// ───────────────────────────────────────────────────────────────────────────
const SQLITE_DRIVERS = new Set([
  "node:sqlite", "sqlite", "sqlite3", "better-sqlite3", "node-sqlite3-wasm",
]);

/**
 * Guard for any future dynamic sqlite import inside the genome path. Throws.
 * Phase 0 never calls this with a real driver; it exists so a later phase that
 * tries `importSqliteForbidden("better-sqlite3")` fails loudly at the seam.
 * @param {string} specifier
 */
export function importSqliteForbidden(specifier) {
  const bare = String(specifier || "").split("/")[0].replace(/^node:/, "");
  if (SQLITE_DRIVERS.has(specifier) || SQLITE_DRIVERS.has(bare) || /sqlite/i.test(specifier)) {
    throw new Error(
      `persona-memory is file-only (AM-23): refusing to import sqlite driver "${specifier}". ` +
      `The genome persists to JSON/JSONL only.`,
    );
  }
  throw new Error(`persona-memory does not perform dynamic imports (attempted "${specifier}").`);
}

// ───────────────────────────────────────────────────────────────────────────
// Slug sanitization (AM-10 / AM-17)
// Construct every path component from the sanitized slug ONLY — never the raw
// input. lowercase → allowlist [a-z0-9-] → length cap → reject traversal,
// separators, and Windows reserved device names.
// ───────────────────────────────────────────────────────────────────────────
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const SLUG_MAX = 64;

/**
 * Sanitize an agentSlug into a filesystem-safe path component, or throw.
 * @param {string} slug
 * @returns {string} the sanitized slug (safe to use as a single path segment)
 */
export function sanitizeSlug(slug) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("persona-memory: slug must be a non-empty string");
  }
  // Reject traversal / separators BEFORE folding, so a forged value cannot
  // smuggle a separator through case-folding.
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || slug.includes("\0")) {
    throw new Error(`persona-memory: slug "${slug}" contains a path separator or traversal sequence`);
  }
  const lowered = slug.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(lowered)) {
    throw new Error(`persona-memory: slug "${slug}" has characters outside [a-z0-9-]`);
  }
  if (lowered.length > SLUG_MAX) {
    throw new Error(`persona-memory: slug "${slug}" exceeds ${SLUG_MAX} chars`);
  }
  if (WINDOWS_RESERVED.has(lowered)) {
    throw new Error(`persona-memory: slug "${slug}" is a reserved device name`);
  }
  return lowered;
}

/**
 * Sanitize a non-negative integer into a decimal path component, or throw.
 * Used for base/<n>.json so a forged HEAD.baseRef can never inject a path
 * fragment (AM-24).
 * @param {number} n
 * @param {string} label
 * @returns {string} the canonical decimal string
 */
function sanitizeIndex(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new Error(`persona-memory: ${label} must be a non-negative integer (got ${JSON.stringify(n)})`);
  }
  return String(n);
}

// ───────────────────────────────────────────────────────────────────────────
// Path construction (always from sanitized components)
// ───────────────────────────────────────────────────────────────────────────
function memoryRoot(projectDir) {
  return join(projectDir, CONFIG_DIR, DATA_DIR, "memory");
}
function legacyMemoryRoot(projectDir) {
  return join(projectDir, CONFIG_DIR, "memory");
}
function genomeDir(projectDir, safeSlug) {
  const canonical = join(memoryRoot(projectDir), "personas", safeSlug);
  const legacy = join(legacyMemoryRoot(projectDir), "personas", safeSlug);
  return existsSync(canonical) || !existsSync(legacy) ? canonical : legacy;
}
function headPath(dir) { return join(dir, "HEAD.json"); }
function genesisPath(dir) { return join(dir, "genesis.json"); }
function baseDir(dir) { return join(dir, "base"); }
function basePath(dir, n) { return join(baseDir(dir), `${sanitizeIndex(n, "baseRef")}.json`); }
function ledgerDir(dir) { return join(dir, "ledger"); }
function activeLedgerPath(dir) { return join(ledgerDir(dir), "active.jsonl"); }
function archiveDir(dir) { return join(ledgerDir(dir), "archive"); }

// ───────────────────────────────────────────────────────────────────────────
// HEAD read + sanitization (AM-24)
// On read, a HEAD is untrusted: assert the schema and the integer fields
// before any of them is used to build a path. Reject forged HEADs.
// ───────────────────────────────────────────────────────────────────────────
/**
 * Read and validate HEAD.json. Throws on a forged/invalid HEAD (AM-24).
 * @param {string} dir  the genome dir
 * @returns {{genomeFormat:number, baseRef:number, activeLedgerLen:number, lastSealAt?:string, lastSealRunIndex?:number}}
 */
function readHead(dir) {
  const raw = JSON.parse(readFileSync(headPath(dir), "utf-8"));
  if (!raw || typeof raw !== "object") {
    throw new Error("persona-memory: HEAD.json is not an object");
  }
  if (raw.genomeFormat !== GENOME_FORMAT) {
    throw new Error(`persona-memory: HEAD.genomeFormat must be ${GENOME_FORMAT} (got ${JSON.stringify(raw.genomeFormat)})`);
  }
  // sanitizeIndex throws on non-negative-integer violations — the AM-24 assert.
  sanitizeIndex(raw.baseRef, "HEAD.baseRef");
  sanitizeIndex(raw.activeLedgerLen, "HEAD.activeLedgerLen");
  if (raw.lastSealRunIndex !== undefined) {
    sanitizeIndex(raw.lastSealRunIndex, "HEAD.lastSealRunIndex");
  }
  return raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Genesis profile resolution
// The frozen identity is the preset's dimensional profile — the base identity
// BEFORE any disposition pulls. Deep-copied so the preset object is never
// shared into the genome on disk.
// ───────────────────────────────────────────────────────────────────────────
/**
 * Resolve the identity-only profile to freeze as genesis from a preset.
 * @param {object} preset  a DISPOSITION_PRESETS entry (carries .profile)
 * @returns {object} a deep copy of the preset's identity profile
 */
function identityFromPreset(preset) {
  if (!preset || typeof preset !== "object" || !preset.profile) {
    throw new Error("persona-memory: loadIdentity requires { preset } with a .profile");
  }
  return JSON.parse(JSON.stringify(preset.profile));
}

// ───────────────────────────────────────────────────────────────────────────
// replay — the structural fold (pure)
// Deep-copy the WHOLE base, then apply each ledger delta's facet pull to
// .facets ONLY (via clampFacet). darkTriad, enneagram, pid5, values, and any
// other sibling structures pass through UNTOUCHED.
//
// HARD INVARIANT (Gap-3): replay(base, []) deepEquals base over the WHOLE
// object, not just facets.
// ───────────────────────────────────────────────────────────────────────────
/**
 * Fold a ledger of facet deltas onto a base profile. Pure — never mutates the
 * inputs. A delta shape is `{ pulls: { <facetId>: <shift> }, ... }` (only the
 * facet pulls are consumed in Phase 0; any other delta fields are ignored).
 *
 * @param {object} base    a dimensional profile (the latest base snapshot)
 * @param {Array<object>} ledger  ordered deltas to fold
 * @returns {object} a NEW profile = base with every delta's facet pulls applied
 */
export function replay(base, ledger = []) {
  // Deep-copy the WHOLE object so siblings (darkTriad, enneagram, …) survive
  // structurally identical when no facet they belong to is touched.
  const profile = JSON.parse(JSON.stringify(base));
  if (!Array.isArray(ledger) || ledger.length === 0) {
    return profile; // replay(base, []) deepEquals base — Gap-3
  }
  if (!profile.facets) profile.facets = {};

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  // M-2 — prototype-pollution guard. A forged delta keyed on a prototype member
  // ("__proto__", "constructor", "prototype") must never reach the fold: it could read
  // Object.prototype as the "current" value and/or attempt to mutate the prototype chain.
  const FORBIDDEN_FACET_KEY = new Set(["__proto__", "constructor", "prototype"]);

  for (const delta of ledger) {
    const pulls = delta && delta.pulls;
    if (!pulls || typeof pulls !== "object") continue;
    for (const [facet, shift] of Object.entries(pulls)) {
      if (typeof shift !== "number") continue;
      // M-1 — a non-finite shift (NaN / ±Infinity) would propagate through Math.max/min and
      // poison the facet with NaN. Skip it (treat as a no-op pull) so the replayed profile
      // can never carry a non-finite facet.
      if (!Number.isFinite(shift)) continue;
      // M-2 — reject prototype-bearing keys outright (no read, no write).
      if (FORBIDDEN_FACET_KEY.has(facet)) continue;
      // M-2 — read the base facet by OWN-property only. `!== undefined` would let an inherited
      // key read off the prototype chain and leak into the replayed profile. Own-property
      // read = the genome fold only ever sees the base's own facet positions.
      const current = hasOwn(profile.facets, facet) ? profile.facets[facet] : 0.5;
      profile.facets[facet] = clampFacet(current + shift);
    }
  }
  return profile;
}

// ───────────────────────────────────────────────────────────────────────────
// loadIdentity — lazy genesis + read
// ───────────────────────────────────────────────────────────────────────────
/**
 * Load (or lazily birth) a persona's genome identity.
 *
 * If the genome dir does not exist: GENESIS — freeze the preset's identity-only
 * profile into genesis.json + base/0.json and write HEAD pointing at base 0.
 * Writes NO ledger lines. As of A81 (DR-174, D7) genesis is STAGED and committed
 * by one atomic rename — a genome is born all-or-nothing (dir-exists ⇒
 * HEAD-exists), half-born pre-A81 corpses are cleared, and losing a
 * cross-process birth race falls through to reading the winner's genome.
 * Returns the frozen identity profile.
 *
 * If the genome exists: load base/<HEAD.baseRef> and return it. (Phase 0 never
 * appends, so the active ledger is always empty here and replay would be a
 * no-op; the live-profile fold is wired in a later phase.)
 *
 * @param {string} projectDir
 * @param {string} slug                  the persona agentSlug
 * @param {{preset:object, genealogy?:object}} opts  the preset to seed genesis
 *        from; genealogy ([A92]/DR-185, derive-mode lineage) joins the STAGED
 *        file set as genealogy.json and commits with the same atomic rename —
 *        born with the genome, never written after; ignored for an existing
 *        genome (genesis-only data, like the preset itself)
 * @returns {object} the identity profile (genesis on birth; latest base after)
 */
export function loadIdentity(projectDir, slug, { preset, genealogy = null } = {}) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);

  if (!existsSync(dir) || !existsSync(headPath(dir))) {
    // ── GENESIS (A81/DR-174 — D7: STAGED + ATOMIC) ──
    // The whole first-touch file set is written into a staging dir and committed
    // by ONE atomic rename, so a genome is born all-or-nothing: dir-exists ⇒
    // HEAD-exists (HEAD stays the existence oracle, now vacuously last). A crash
    // mid-genesis leaves only an orphaned staging dir (swept below), never a
    // half-born genome; a pre-A81 half-born corpse (dir without HEAD) is cleared
    // before commit. Losing a cross-process genesis race (rename fails because a
    // committed genome appeared) falls through to the READ path — the winner's
    // genome is the genome.
    const identity = identityFromPreset(preset);
    const parent = dirname(dir);
    mkdirSync(parent, { recursive: true });
    sweepStaleStaging(parent, safeSlug); // best-effort: orphans from crashed births

    const staging = join(parent, `${safeSlug}.genesis-${process.pid}-${stagingSeq++}`);
    mkdirSync(join(staging, "base"), { recursive: true });
    mkdirSync(join(staging, "ledger", "archive"), { recursive: true });
    writeFileSync(join(staging, "genesis.json"), JSON.stringify(identity, null, 2), "utf-8");
    writeFileSync(join(staging, "base", "0.json"), JSON.stringify(identity, null, 2), "utf-8");
    // [A92]/DR-185: derive-mode genealogy joins the staged set — lineage is
    // born with the genome (the same atomic commit), never written after.
    if (genealogy && typeof genealogy === "object") {
      writeFileSync(join(staging, "genealogy.json"), JSON.stringify(genealogy, null, 2), "utf-8");
    }
    // active.jsonl gets only its header line (AM-13). NO deltas at genesis.
    writeFileSync(join(staging, "ledger", "active.jsonl"), ledgerHeaderLine() + "\n", "utf-8");
    // HEAD schema (AM-14).
    writeFileSync(
      join(staging, "HEAD.json"),
      JSON.stringify({ genomeFormat: GENOME_FORMAT, baseRef: 0, activeLedgerLen: 0 }, null, 2),
      "utf-8",
    );

    try {
      if (existsSync(dir) && !existsSync(headPath(dir))) {
        // a half-born corpse never carried HEAD — it was never committed; clear it.
        rmSync(dir, { recursive: true, force: true });
      }
      renameSync(staging, dir); // THE COMMIT — atomic on the same volume
      return identity;
    } catch (err) {
      rmSync(staging, { recursive: true, force: true }); // never leak our staging
      if (!existsSync(headPath(dir))) {
        throw new Error(`persona-memory: genesis commit failed for "${safeSlug}": ${err.message}`);
      }
      // else: lost the race to a committed genome — fall through and READ it.
    }
  }

  // ── READ existing genome ──
  const head = readHead(dir); // AM-24: validates before any path is built
  const base = JSON.parse(readFileSync(basePath(dir, head.baseRef), "utf-8"));
  return base;
}

// Monotonic per-process staging suffix — two same-slug births in one process
// never share a staging dir (cross-process uniqueness comes from the pid).
let stagingSeq = 0;

/** Best-effort sweep of orphaned genesis staging dirs for one slug. */
function sweepStaleStaging(parent, safeSlug) {
  let entries;
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(`${safeSlug}.genesis-`)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      // best-effort: a locked orphan is left for the next sweep
    }
  }
}

/**
 * Read a persona's active ledger deltas (header stripped). Phase 0 never writes
 * deltas, so this returns [] for a freshly-birthed genome; it exists so the
 * read path is complete and the fold can be exercised by tests.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {Array<object>} the ledger deltas after the header line
 */
export function readActiveLedger(projectDir, slug) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  const path = activeLedgerPath(dir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  // First line is the header (AM-13); deltas follow.
  return lines.slice(1).map((l) => JSON.parse(l));
}

/**
 * Whether a genome already exists for this persona in this project.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {boolean}
 */
export function genomeExists(projectDir, slug) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  return existsSync(headPath(dir));
}

/**
 * The canonical READ of a persona's live state (A87/DR-180): base + active
 * ledger + the fold, with READER-SIDE COMPENSATION for the crashed-seal
 * window. In that window (HEAD committed the seal; the active reset never
 * landed) the stale active lines are ALREADY folded into base/<baseRef> —
 * the archive segment proves it by content match — so the reader treats the
 * ledger as empty. Pure read: no write, no lease, readers stay readers (the
 * write entrypoints still heal the file itself). Lazy genesis via
 * loadIdentity when the genome does not exist yet.
 *
 * @param {string} projectDir
 * @param {string} slug
 * @param {{preset:object, genealogy?:object}} opts  the preset to seed genesis
 *        from (first touch); genealogy ([A92]/DR-185) is staged into the
 *        atomic genesis as genealogy.json — consulted ONLY at birth, ignored
 *        on every later read
 * @returns {{profile:object, ledger:Array<object>, baseRef:number,
 *            activeLedgerLen:number, compensated:boolean}}
 */
export function readLiveProfile(projectDir, slug, { preset, genealogy = null } = {}) {
  const base = loadIdentity(projectDir, slug, { preset, genealogy });
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  const head = readHead(dir); // AM-24
  let ledger = readActiveLedger(projectDir, slug);
  let compensated = false;
  if (ledger.length > 0 && isInterruptedSealState(dir, head)) {
    ledger = [];
    compensated = true;
  }
  return {
    profile: replay(base, ledger),
    ledger,
    baseRef: head.baseRef,
    activeLedgerLen: ledger.length,
    compensated,
  };
}

/**
 * Read-only genome status (A80): the validated HEAD projection for provenance
 * (which base seeded a composition) and, later, the C2 seal-worker threshold.
 * @param {string} projectDir
 * @param {string} slug
 * @returns {{exists:boolean, baseRef?:number, activeLedgerLen?:number, lastSealAt?:string, lastSealRunIndex?:number}}
 */
export function genomeStatus(projectDir, slug) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  if (!existsSync(headPath(dir))) return { exists: false };
  const head = readHead(dir); // AM-24
  return {
    exists: true,
    baseRef: head.baseRef,
    activeLedgerLen: head.activeLedgerLen,
    ...(head.lastSealAt !== undefined ? { lastSealAt: head.lastSealAt } : {}),
    ...(head.lastSealRunIndex !== undefined ? { lastSealRunIndex: head.lastSealRunIndex } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Phase A2 (DR-170 / DR-172) — the append + seal STORAGE SURFACE (file-only,
// AM-23). Mechanics only: no engine path writes deltas yet (delta VALUES are
// Rust-only behind the D6 napi-gate), and the seal WORKER (trigger/cadence)
// is Phase C2. JS owns storage per the ratified measurement/mutation seam.
// ───────────────────────────────────────────────────────────────────────────

// ── Phase C3 (A86/DR-179) — the genome write lease (AM-23's second half) ────
// An ADVISORY cross-process lockfile around the two read-modify-write paths
// (appendDelta, sealActiveLedger). Same-process writers are already safe (the
// whole surface is synchronous); genesis needs no lease (the A81 atomic
// rename is its commit). Exclusive-create (`wx`) claims `<genome>/.lease`
// with { pid, acquiredAt }; a holder older than LEASE_STALE_MS is broken
// (crashed writer); a FRESH foreign lease is retried briefly then thrown
// LOUDLY — never silently skipped. The break-then-claim window between two
// stale-breakers is accepted (advisory posture, documented).

/** A lease older than this is a crashed writer and may be broken. */
export const LEASE_STALE_MS = 30_000;
const LEASE_RETRIES = 5;
const LEASE_RETRY_MS = 20;

function leasePath(dir) {
  return join(dir, ".lease");
}

/** Synchronous bounded sleep (the genome surface is fully synchronous). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire the genome write lease, or throw after bounded retries.
 * @param {string} dir  the genome dir
 * @returns {() => void} release
 */
function acquireGenomeLease(dir) {
  const path = leasePath(dir);
  for (let attempt = 0; attempt <= LEASE_RETRIES; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), {
        encoding: "utf-8",
        flag: "wx", // exclusive create — the claim is a single atomic op
      });
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
          // release is best-effort; a leaked lease goes stale and is broken
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        holder = null; // unreadable/garbage lease -> treat as stale
      }
      const age = holder && typeof holder.acquiredAt === "number" ? Date.now() - holder.acquiredAt : Infinity;
      if (age > LEASE_STALE_MS) {
        try {
          rmSync(path, { force: true }); // break the crashed writer's lease
        } catch {
          // raced another breaker — loop and retry the claim
        }
        continue; // immediate re-claim attempt
      }
      if (attempt < LEASE_RETRIES) sleepSync(LEASE_RETRY_MS);
    }
  }
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    /* raced away */
  }
  throw new Error(
    `persona-memory: genome write lease held${holder ? ` by pid ${holder.pid} (age ${Date.now() - holder.acquiredAt}ms)` : ""} — ${path}`,
  );
}

// Structural-only pull-key validation. Deliberately NOT pinned to the ILLUCI-30
// facet vocabulary: ADR-03 gives the mutation core 68+3 dimensions, so the
// storage surface stays vocabulary-agnostic — the mutation core owns which
// keys are meaningful; storage owns that a key is structurally safe.
const FORBIDDEN_PULL_KEY = new Set(["__proto__", "constructor", "prototype"]);
const PULL_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function ledgerHeaderLine() {
  return JSON.stringify({ genomeFormat: GENOME_FORMAT, schemaVersion: LEDGER_SCHEMA_VERSION });
}

/** Raw active-ledger delta LINES (header stripped), for content-exact archiving. */
function readActiveDeltaLines(dir) {
  const path = activeLedgerPath(dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).slice(1);
}

/**
 * Validate a delta at the WRITE seam — fail-closed, stricter than replay's
 * tolerant fold, so garbage never persists into the ledger: a plain object
 * carrying a non-empty `pulls` map of structurally-safe keys to FINITE
 * numbers. Extra top-level fields (provenance: runId, graderInput ref, …)
 * are allowed — replay ignores them by contract.
 * @param {object} delta
 * @returns {{ok:boolean, error?:string}}
 */
export function validateDelta(delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return { ok: false, error: "delta must be a plain object" };
  }
  const pulls = delta.pulls;
  if (!pulls || typeof pulls !== "object" || Array.isArray(pulls)) {
    return { ok: false, error: "delta.pulls must be a plain object" };
  }
  const entries = Object.entries(pulls);
  if (entries.length === 0) {
    return { ok: false, error: "delta.pulls must carry at least one pull" };
  }
  for (const [key, shift] of entries) {
    if (FORBIDDEN_PULL_KEY.has(key) || !PULL_KEY_RE.test(key)) {
      return { ok: false, error: `pull key "${key}" is not a structurally safe facet key` };
    }
    if (typeof shift !== "number" || !Number.isFinite(shift)) {
      return { ok: false, error: `pull "${key}" must be a finite number (got ${JSON.stringify(shift)})` };
    }
  }
  return { ok: true };
}

/**
 * Detect and complete an INTERRUPTED SEAL. sealActiveLedger commits HEAD
 * (step 3) before resetting the active ledger (step 4); a crash between the
 * two leaves HEAD at base <n> with activeLedgerLen 0 while active.jsonl still
 * carries the sealed deltas — a fold in that window would double-apply them.
 * The window's exact signature: HEAD.activeLedgerLen === 0, active has deltas,
 * and archive/<HEAD.baseRef>.jsonl holds those SAME delta lines (the seal
 * archived them in step 2). On a content-exact match the recovery completes
 * step 4 (reset active to header-only). Anything else is left untouched — in
 * particular a crashed APPEND (line landed, len not yet bumped) never matches
 * the archive and is preserved.
 * @returns {boolean} true when an interrupted seal was completed
 */
function isInterruptedSealState(dir, head) {
  if (head.activeLedgerLen !== 0) return false;
  const activeLines = readActiveDeltaLines(dir);
  if (activeLines.length === 0) return false;
  const archivePath = join(archiveDir(dir), `${sanitizeIndex(head.baseRef, "baseRef")}.jsonl`);
  if (!existsSync(archivePath)) return false;
  const archivedLines = readFileSync(archivePath, "utf-8").split("\n").filter(Boolean).slice(1);
  return (
    archivedLines.length === activeLines.length &&
    archivedLines.every((line, i) => line === activeLines[i])
  );
}

function recoverInterruptedSeal(dir, head) {
  if (!isInterruptedSealState(dir, head)) return false;
  writeFileSync(activeLedgerPath(dir), ledgerHeaderLine() + "\n", "utf-8");
  return true;
}

/**
 * Append one validated facet delta to a persona's active ledger (Phase A2).
 * Fail-closed: the genome must already exist (genesis is loadIdentity's job)
 * and the delta must pass validateDelta. Write order: the ledger line lands
 * FIRST, then HEAD.activeLedgerLen is rewritten from the ACTUAL line count —
 * so a crash between the two leaves the ledger ahead of an advisory counter
 * (readActiveLedger reads the whole file; the count self-heals on the next
 * append or seal), never a lost or phantom delta.
 *
 * @param {string} projectDir
 * @param {string} slug
 * @param {object} delta  `{ pulls: { <facetKey>: <finite shift> }, ...provenance }`
 * @returns {{appended:true, activeLedgerLen:number, baseRef:number}}
 */
export function appendDelta(projectDir, slug, delta) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  if (!existsSync(headPath(dir))) {
    throw new Error(
      `persona-memory: no genome exists for "${safeSlug}" — genesis (loadIdentity) must run before appendDelta`,
    );
  }
  const verdict = validateDelta(delta);
  if (!verdict.ok) {
    throw new Error(`persona-memory: appendDelta rejected the delta — ${verdict.error}`);
  }
  const release = acquireGenomeLease(dir); // C3: one writer per genome (cross-process)
  try {
    const head = readHead(dir); // AM-24
    recoverInterruptedSeal(dir, head);

    appendFileSync(activeLedgerPath(dir), JSON.stringify(delta) + "\n", "utf-8");
    const activeLedgerLen = readActiveDeltaLines(dir).length; // recount = self-healing counter
    writeFileSync(
      headPath(dir),
      JSON.stringify({ ...head, activeLedgerLen }, null, 2),
      "utf-8",
    );
    return { appended: true, activeLedgerLen, baseRef: head.baseRef };
  } finally {
    release();
  }
}

/**
 * Seal the active ledger into the next immutable base (Phase A2 — the D4 PURE
 * REPLAY-ACCUMULATOR): base/<n+1> = replay(base/<n>, segment). No mutable
 * field exists on a base; the sealed base is derived by the same fold reads
 * use, so loadIdentity(afterSeal) deepEquals replay(baseBefore, deltas) by
 * construction. Mechanics only — the WORKER that decides WHEN to seal (a
 * disclosed threshold control) is Phase C2.
 *
 * Write order (crash posture): 1. base/<n+1> and 2. archive/<n+1>.jsonl are
 * additive and idempotent (an orphan from a crashed seal is overwritten
 * identically on retry, HEAD still names <n>); 3. HEAD is THE COMMIT
 * (baseRef -> n+1, activeLedgerLen -> 0, lastSealAt, lastSealRunIndex = the
 * deltas folded by THIS seal); 4. active resets to header-only. A crash
 * between 3 and 4 is healed by recoverInterruptedSeal at the next write
 * entrypoint (content-exact match against archive/<n+1>).
 *
 * @param {string} projectDir
 * @param {string} slug
 * @param {{now?:string}} [opts]  injectable seal timestamp (tests)
 * @returns {{sealed:boolean, baseRef:number, deltasSealed?:number, archived?:string, reason?:string}}
 */
export function sealActiveLedger(projectDir, slug, { now } = {}) {
  const safeSlug = sanitizeSlug(slug);
  const dir = genomeDir(projectDir, safeSlug);
  if (!existsSync(headPath(dir))) {
    throw new Error(
      `persona-memory: no genome exists for "${safeSlug}" — genesis (loadIdentity) must run before sealActiveLedger`,
    );
  }
  const release = acquireGenomeLease(dir); // C3: one writer per genome (cross-process)
  try {
    const head = readHead(dir); // AM-24
    recoverInterruptedSeal(dir, head);

    const rawLines = readActiveDeltaLines(dir);
    if (rawLines.length === 0) {
      return { sealed: false, reason: "empty-ledger", baseRef: head.baseRef };
    }
    const deltas = rawLines.map((l) => JSON.parse(l));
    const base = JSON.parse(readFileSync(basePath(dir, head.baseRef), "utf-8"));
    const nextRef = head.baseRef + 1;
    const sealedBase = replay(base, deltas); // D4 — the pure accumulator IS the fold

    // 1. the new immutable base (additive, idempotent on retry)
    writeFileSync(basePath(dir, nextRef), JSON.stringify(sealedBase, null, 2), "utf-8");
    // 2. the archived segment, content-exact (additive, idempotent on retry)
    const archivePath = join(archiveDir(dir), `${sanitizeIndex(nextRef, "baseRef")}.jsonl`);
    writeFileSync(archivePath, ledgerHeaderLine() + "\n" + rawLines.join("\n") + "\n", "utf-8");
    // 3. HEAD — THE COMMIT
    writeFileSync(
      headPath(dir),
      JSON.stringify(
        {
          genomeFormat: GENOME_FORMAT,
          baseRef: nextRef,
          activeLedgerLen: 0,
          lastSealAt: now || new Date().toISOString(),
          lastSealRunIndex: rawLines.length,
        },
        null,
        2,
      ),
      "utf-8",
    );
    // 4. reset the active ledger to header-only
    writeFileSync(activeLedgerPath(dir), ledgerHeaderLine() + "\n", "utf-8");

    return {
      sealed: true,
      baseRef: nextRef,
      deltasSealed: rawLines.length,
      archived: `ledger/archive/${nextRef}.jsonl`,
    };
  } finally {
    release();
  }
}

export default {
  loadIdentity,
  replay,
  readActiveLedger,
  readLiveProfile,
  genomeExists,
  genomeStatus,
  sanitizeSlug,
  importSqliteForbidden,
  validateDelta,
  appendDelta,
  sealActiveLedger,
  LEASE_STALE_MS,
};
