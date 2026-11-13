// illuci/core/governance/authortime/manifest.js
//
// The invariant-implementation MANIFEST + its completeness oracle.
//
// The swarm's "day-one-staleness" finding: a hand-authored list of which files implement
// a governance invariant rots the moment a new implementer lands and nobody updates the
// list. The fix is to MACHINE-SEED the list (invariant-manifest.json) from a scan, then
// keep a pure detector (`detectInvariant`) that classifies any file the SAME way the seed
// was built. `findUnmanifestedImplementers` walks the tree, runs the detector, and reports
// any file that the detector flags but the manifest does not list - the completeness signal
// the author-time floor / CI surfaces so the registry never silently drifts.
//
// What "implements an invariant" means here (matched to the seed scan):
//   odometer  - the file redefines the MINOR_HARD_CAP / KOHAI_HARD_CAP / PATCH_HARD_CAP constants, or imports
//               the odometer bump skill (claude/.../odometer/bump.mjs). assess.js + bump.mjs.
//
// Local downstream mirrors are not implementers by location. In this dedicated illuci repo,
// constitutional/ is nearby GZDS context; a file becomes a doctrine implementer only when a
// governed manifest entry explicitly lists it.
//
// Pure where it can be: `detectInvariant(relPath, content)` and `isInvariantImplementer`
// take their inputs as params (no I/O). `loadManifest` and `findUnmanifestedImplementers`
// touch disk; the latter is the only tree-walker.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const MANIFEST_FILE = "invariant-manifest.json";

// Directories never scanned: VCS internals, installed deps, nested harness worktrees /
// sandboxes (which carry COPIES of the very implementers we track - counting them would
// produce false "unmanifested" hits), and build output. Matched by exact path segment.
// Intentionally distinct from ceiling/graph.js's SKIP_DIRS: that walker reasons about spoke
// imports (so it skips imported-substrate trees); this one reasons about invariant implementers
// (so it skips implementer COPIES + build output). The two sets differ by design, not drift.
export const SCAN_IGNORE_DIRS = Object.freeze([
  ".git",
  ".github",
  ".claude",
  ".codex",
  ".illuci",
  ".illuci-sandboxes",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

// Source extensions whose CONTENT is inspected for the odometer signal.
const CODE_EXT = Object.freeze([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

/**
 * Is this a test file? Test files legitimately carry SYNTHETIC cap redefinitions and
 * bump-skill imports as fixtures (to exercise the detector itself), so they are not
 * implementers and must not register as unmanifested. Matched by a `.test.`/`.spec.`
 * segment before the extension.
 */
function isTestFile(relPath) {
  return /\.(?:test|spec)\.[mc]?[jt]s$/i.test(String(relPath || ""));
}

/**
 * Does this file content IMPLEMENT the odometer invariant - i.e. redefine a hard-cap
 * constant, or `import`/`require` the odometer bump skill as a module (a second code home
 * for the rollover arithmetic)? Mirrors the seed scan exactly so the detector and the seed
 * agree on membership.
 *
 * Deliberately NARROW on two fronts so we flag IMPLEMENTERS, not CONSUMERS:
 *   - Redefinition = a binding of the cap name (`const|let|var|export ... NAME =`), not a
 *     bare prose / comment mention of the constant.
 *   - "Imports the skill" = an actual `import`/`require` of the bump module, NOT a code path
 *     that merely constructs a path-string to bump.mjs and shells out to it (e.g. the
 *     recursive-director ratify path). Shelling out CONSUMES the one source of truth; it does
 *     not become a competing definition that could let an illegal version drift (DR-119/135).
 *
 * @param {string} relPath  repo-root-relative, forward-slash path
 * @param {string} content  the file's text (may be "")
 * @returns {boolean}
 */
function hasOdometerSignal(relPath, content) {
  const c = content || "";
  const redefines =
    /\b(?:const|let|var|export)[^\n=;]*\bMINOR_HARD_CAP\b\s*=/.test(c) ||
    /\b(?:const|let|var|export)[^\n=;]*\bKOHAI_HARD_CAP\b\s*=/.test(c) ||
    /\b(?:const|let|var|export)[^\n=;]*\bPATCH_HARD_CAP\b\s*=/.test(c);
  const importsSkill =
    /\bimport\b[^\n;]*['"][^'"\n]*odometer\/bump\.mjs['"]/.test(c) ||
    /\brequire\s*\(\s*['"][^'"\n]*odometer\/bump\.mjs['"]\s*\)/.test(c);
  return redefines || importsSkill;
}

/**
 * PURE classifier. Which invariant(s) does this file implement, by its path + content?
 * The single definition of "implements" shared by the seed and the completeness check.
 * @param {string} relPath  repo-root-relative path (any separator accepted)
 * @param {string} [content]  file text; required for the odometer content signal
 * @returns {string[]}  invariant ids (e.g. ["odometer"]); [] if none
 */
export function detectInvariant(relPath, content = "") {
  const p = String(relPath || "").replace(/\\/g, "/");
  const hits = [];
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  if (CODE_EXT.includes(ext) && hasOdometerSignal(p, content)) hits.push("odometer");
  return hits;
}

/**
 * Load the seeded manifest from <repoRoot>/illuci/core/governance/authortime/invariant-manifest.json
 * (the manifest lives beside this module). Returns a normalized shape:
 *   { invariants: { <id>: { files: string[], ... } } }
 * Absent or malformed -> an empty manifest (so callers fail open to "everything is unmanifested",
 * which surfaces loudly rather than silently passing).
 * @param {string} [repoRoot=process.cwd()]
 * @returns {{invariants: Object<string,{files:string[]}>}}
 */
export function loadManifest(repoRoot = process.cwd()) {
  const p = join(repoRoot, "illuci", "core", "governance", "authortime", MANIFEST_FILE);
  if (!existsSync(p)) return { invariants: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const inv = raw && raw.invariants && typeof raw.invariants === "object" ? raw.invariants : {};
    const out = {};
    for (const [id, entry] of Object.entries(inv)) {
      const files = entry && Array.isArray(entry.files) ? entry.files.map((f) => normalizeRel(f)) : [];
      out[id] = { ...entry, files };
    }
    return { ...raw, invariants: out };
  } catch {
    return { invariants: {} };
  }
}

/** Normalize a path to repo-root-relative forward-slash form. */
function normalizeRel(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Is `relPath` listed as an implementer of ANY invariant in the manifest?
 * Pure (operates on the loaded manifest object).
 * @param {string} relPath  repo-root-relative path (any separator accepted)
 * @param {{invariants:Object<string,{files:string[]}>}} manifest
 * @returns {boolean}
 */
export function isInvariantImplementer(relPath, manifest) {
  const target = normalizeRel(relPath);
  const inv = (manifest && manifest.invariants) || {};
  for (const entry of Object.values(inv)) {
    const files = (entry && entry.files) || [];
    if (files.some((f) => normalizeRel(f) === target)) return true;
  }
  return false;
}

/** Which invariant ids does the manifest list `relPath` under? Pure. */
export function manifestedInvariantsOf(relPath, manifest) {
  const target = normalizeRel(relPath);
  const inv = (manifest && manifest.invariants) || {};
  const ids = [];
  for (const [id, entry] of Object.entries(inv)) {
    const files = (entry && entry.files) || [];
    if (files.some((f) => normalizeRel(f) === target)) ids.push(id);
  }
  return ids;
}

/** Recursively collect candidate files under repoRoot, honoring SCAN_IGNORE_DIRS. */
function walk(repoRoot, dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SCAN_IGNORE_DIRS.includes(ent.name)) continue;
      walk(repoRoot, full, acc);
    } else if (ent.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * IMPURE. Walk the tree, classify every file with `detectInvariant`, and return the
 * implementers the manifest does NOT list for the invariant(s) the detector found - the
 * completeness signal. An entry the manifest lists but the detector no longer flags is
 * NOT reported here (that is harmless over-coverage; staleness is the under-coverage case).
 *
 * @param {string} [repoRoot=process.cwd()]
 * @param {{invariants:Object<string,{files:string[]}>}} [manifest]  defaults to loadManifest(repoRoot)
 * @returns {Array<{file:string, invariants:string[], missing:string[]}>}
 *          one entry per file the detector flags for >=1 invariant it is NOT manifested under;
 *          `invariants` = all detected ids, `missing` = the unmanifested subset.
 */
export function findUnmanifestedImplementers(repoRoot = process.cwd(), manifest) {
  const mani = manifest || loadManifest(repoRoot);
  const files = walk(repoRoot, repoRoot, []);
  const out = [];
  for (const full of files) {
    const rel = normalizeRel(relative(repoRoot, full).split(sep).join("/"));
    if (!rel || rel === MANIFEST_FILE || rel.endsWith(`/${MANIFEST_FILE}`)) continue;
    if (isTestFile(rel)) continue; // fixtures carry synthetic signals, not real implementations

    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
    // Only read content for code files (the odometer signal); doctrine is path-only.
    let content = "";
    if (CODE_EXT.includes(ext)) {
      try {
        content = readFileSync(full, "utf8");
      } catch {
        content = "";
      }
    }
    const detected = detectInvariant(rel, content);
    if (detected.length === 0) continue;

    const listedFor = manifestedInvariantsOf(rel, mani);
    const missing = detected.filter((id) => !listedFor.includes(id));
    if (missing.length > 0) out.push({ file: rel, invariants: detected, missing });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

export default {
  MANIFEST_FILE,
  SCAN_IGNORE_DIRS,
  detectInvariant,
  loadManifest,
  isInvariantImplementer,
  manifestedInvariantsOf,
  findUnmanifestedImplementers,
};
