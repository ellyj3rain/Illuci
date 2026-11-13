// illuci/core/governance/authortime/ceiling/graph.js
//
// Ceiling: the consumption-graph + relational-bands primitive.
//
// The "ceiling" is the relational standing of a spoke within GZDS: how many other
// spokes depend on it, and therefore how governance-grade a change to it is. A leaf
// nobody consumes can move freely; a substrate everything sits on cannot. This module
// builds that graph from a real import/reference scan across the spokes and classifies
// each node into a relational BAND.
//
// PROVENANCE / APPROACH
//   The import-parsing approach (spoke prefixes -> classify(), the relative-vs-`@/`
//   import regex pair, the walk + skip-dirs) is LIFTED from
//   claude/system/scripts/check-cross-spoke-imports.mjs (DR-045 / [A38]). We do not
//   import that module - it is a one-shot CLI that throws on violations. We reuse its
//   shape so the two stay congruent: same notion of what a spoke is and how an import
//   resolves to one.
//
// DR-EDGE SOURCE — FORWARD CONTRACT NOTE
//   The ratified design specifies that DR-derived edges (prose like "claude consumes
//   illuci per DR-099" scraped out of DECISION_REGISTRY.md) are UNRELIABLE: prose drifts,
//   IDs get mis-cited, and a free-text scan cannot be trusted as a dependency source.
//   So this graph relies SOLELY on the IMPORT/REFERENCE scan below. The forward source
//   for declared (non-import) dependencies is intended to be MACHINE-READABLE DR
//   CONTRACT-BLOCKS (a structured, parseable contract section per cross-spoke DR), NOT
//   prose. When those land, add a second edge source here and union it with the scan;
//   until then, imports are the single source of truth.
//
// STYLE
//   Pure functions, the {ok, code, reason} shape where a verdict is returned, JSDoc,
//   no Date.now()/Math.random(). The graph build does read the filesystem (it scans a
//   repo) but is otherwise deterministic given a fixed tree.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, resolve, dirname } from "node:path";

/**
 * GZDS spokes scanned for the consumption graph. Lifted from check-cross-spoke-imports
 * and extended with the product-with-harness-side spokes (codex, otl) per
 * ARCHITECTURE.md v3.0.0 ([A64]). Each spoke names one or more path prefixes
 * (relative to repo root, posix separators) that belong to it.
 *
 * 'governance' (the hub) is NOT a scanned spoke directory - it is the parent root files.
 * It appears as a graph NODE so the band classifier can reason about it, but no file is
 * classified into it (a file outside every spoke is hub/shared and is not an edge source).
 */
export const SPOKES = {
  claude: ["claude"],
  illuci: ["illuci"],
  codex: ["codex"],
  otl: ["otl"],
  constitutional: ["constitutional"],
  primitives: ["primitives"],
};

/** The hub node name. Present in the graph; not a scanned spoke directory. */
export const HUB_NODE = "governance";

/** All node names a built graph will contain (spokes + the hub). */
export const GRAPH_NODES = [...Object.keys(SPOKES), HUB_NODE];

/**
 * Paths whose contents are never walked (imported substrate, vendored code, session state).
 * Intentionally distinct from manifest.js's SCAN_IGNORE_DIRS: this walker reasons about SPOKE
 * IMPORTS, so it skips imported-substrate trees (`sources`) that would
 * pollute the consumption graph; the manifest walker reasons about INVARIANT IMPLEMENTERS, so it
 * skips dirs carrying COPIES of those implementers (`.illuci-sandboxes`) plus build output. The two
 * sets differ by design, not drift.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".vercel",
  ".turbo",
  ".claude", // Claude Code session + worktree state
  "sources", // imported bridge / Bill of Standards content
]);

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;

// Band thresholds, keyed on dependents-count (how many distinct nodes depend on a node).
//   LEAF         0-1
//   INTERMEDIATE 2-10
//   HUB          11-50
//   SUBSTRATE    50+   (also forced for illuci, and for anything illuci depends on)
export const BAND_THRESHOLDS = Object.freeze({
  LEAF_MAX: 1,
  INTERMEDIATE_MAX: 10,
  HUB_MAX: 50,
});

/**
 * Resolve a repo-relative posix path to its owning spoke (or null if hub/shared).
 * @param {string} relPosix  path relative to repo root, posix separators
 * @returns {string|null}
 */
function classifyRel(relPosix) {
  for (const [spoke, prefixes] of Object.entries(SPOKES)) {
    for (const p of prefixes) {
      if (relPosix === p || relPosix.startsWith(p + "/")) return spoke;
    }
  }
  return null;
}

/** Resolve an absolute path to its owning spoke (or null if hub/shared). */
function classify(root, absPath) {
  const rel = relative(root, absPath).split(sep).join("/");
  return classifyRel(rel);
}

/** Resolve an `@/...` import target to its owning spoke. */
function classifyAtImport(at) {
  return classifyRel(at);
}

/** Resolve a relative-path import target to its owning spoke (from `fromFile`'s vantage). */
function classifyRelativeImport(root, fromFile, relPath) {
  const fromDir = dirname(fromFile);
  const resolved = resolve(fromDir, relPath);
  return classify(root, resolved);
}

function* walk(root, dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const relP = relative(root, p).split(sep).join("/");
    if ([...SKIP_DIRS].some((s) => relP === s || relP.startsWith(s + "/"))) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(root, p);
    else if (SOURCE_EXT.test(name)) yield p;
  }
}

// Lifted from check-cross-spoke-imports: match both import styles.
//   import ... from '@/path/to/thing'
//   import ... from '../path/to/thing'  /  './path/to/thing'
const importAtRe = /^\s*import\s.+?from\s+['"]@\/(.+?)['"]/;
const importRelRe = /^\s*import\s.+?from\s+['"](\.[./]*[^'"]+)['"]/;

/**
 * Build the consumption graph from an import/reference scan across the spokes.
 *
 * Each edge {from, to} means "spoke `from` has at least one source file that imports
 * from spoke `to`" (from's vantage: `from` depends on `to`). Edges are de-duplicated:
 * many imports between the same pair collapse to one edge. Self-edges (a spoke importing
 * itself) are dropped - they carry no relational-band signal.
 *
 * The 'governance' hub node is always present in `nodes` but is never an edge endpoint
 * from a scan (no file classifies into it). A forward DR-contract-block source could
 * later contribute governance edges; see the header note.
 *
 * @param {string} repoRoot  absolute path to the repo root to scan
 * @returns {{nodes:string[], edges:Array<{from:string,to:string}>}}
 */
export function buildGraph(repoRoot) {
  const root = resolve(repoRoot);
  const edgeSet = new Set(); // "from->to" keys for de-dup

  for (const file of walk(root, root)) {
    const ownSpoke = classify(root, file);
    if (!ownSpoke) continue; // hub/shared file: not an edge source
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let importedSpoke = null;

      const atMatch = importAtRe.exec(lines[i]);
      if (atMatch) {
        importedSpoke = classifyAtImport(atMatch[1]);
      } else {
        const relMatch = importRelRe.exec(lines[i]);
        if (relMatch) {
          importedSpoke = classifyRelativeImport(root, file, relMatch[1]);
        }
      }

      if (!importedSpoke || importedSpoke === ownSpoke) continue;
      edgeSet.add(`${ownSpoke}->${importedSpoke}`);
    }
  }

  const edges = [...edgeSet].sort().map((key) => {
    const [from, to] = key.split("->");
    return { from, to };
  });

  return { nodes: [...GRAPH_NODES], edges };
}

/**
 * Count the distinct nodes that depend on `node` (its in-degree over de-duplicated edges).
 * An edge {from, to} means `from` depends on `to`, so `node`'s dependents are the
 * distinct `from`s of edges whose `to === node`.
 *
 * @param {string} node
 * @param {{nodes:string[], edges:Array<{from:string,to:string}>}} graph
 * @returns {number}
 */
export function dependentsOf(node, graph) {
  if (!graph || !Array.isArray(graph.edges)) return 0;
  const deps = new Set();
  for (const e of graph.edges) {
    if (e && e.to === node && e.from && e.from !== node) deps.add(e.from);
  }
  return deps.size;
}

/**
 * Does `node` have any node that `illuci` depends on? Used by bandOf: illuci is SUBSTRATE by
 * construction, and anything illuci sits on is substrate too (you cannot move what the
 * substrate stands on without moving the substrate).
 */
function illuciDependsOn(node, graph) {
  if (node === "illuci") return false;
  if (!graph || !Array.isArray(graph.edges)) return false;
  return graph.edges.some((e) => e && e.from === "illuci" && e.to === node);
}

/**
 * Classify a node into its relational band.
 *
 *   LEAF         0-1 dependents
 *   INTERMEDIATE 2-10 dependents
 *   HUB          11-50 dependents
 *   SUBSTRATE    50+ dependents, OR node === 'illuci', OR any node illuci depends on
 *
 * illuci is SUBSTRATE by construction (the model-agnostic harness substrate everything
 * else instantiates from); its bandOf is never derived from a count.
 *
 * @param {string} node
 * @param {{nodes:string[], edges:Array<{from:string,to:string}>}} graph
 * @returns {'LEAF'|'INTERMEDIATE'|'HUB'|'SUBSTRATE'}
 */
export function bandOf(node, graph) {
  if (node === "illuci") return "SUBSTRATE";
  if (illuciDependsOn(node, graph)) return "SUBSTRATE";

  const n = dependentsOf(node, graph);
  if (n > BAND_THRESHOLDS.HUB_MAX) return "SUBSTRATE";
  if (n > BAND_THRESHOLDS.INTERMEDIATE_MAX) return "HUB";
  if (n > BAND_THRESHOLDS.LEAF_MAX) return "INTERMEDIATE";
  return "LEAF";
}

export default {
  SPOKES,
  HUB_NODE,
  GRAPH_NODES,
  BAND_THRESHOLDS,
  buildGraph,
  dependentsOf,
  bandOf,
};
