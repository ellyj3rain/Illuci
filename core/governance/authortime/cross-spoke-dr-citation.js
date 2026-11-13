// illuci/core/governance/authortime/cross-spoke-dr-citation.js
//
// FLOOR atom: the hub-and-spoke import gate, atomized.
//
// Per GOVERNANCE.md ("Hub-and-Spoke Memory Boundary": "Cross-spoke imports must cite a DR via
// in-line comment") and ARCHITECTURE.md § "Spoke-to-spoke: cross-consumption contracts" / DR-045:
// an import that crosses a spoke boundary (claude / illuci / constitutional / primitives) must cite
// a DR ID on the SAME line or the IMMEDIATELY-PRECEDING line. Cross-spoke consumption requires an
// explicit named contract; the in-line DR citation IS that contract's author-time witness.
//
// This rule already exists as a whole-tree CLI (claude/system/scripts/check-cross-spoke-imports.mjs)
// that walks the entire repo and fails CI. This atom is the SAME per-file decision lifted out as a
// PURE function so the floor aggregator can fire it at PreToolUse / pre-commit on JUST the changed
// files (a content-diff changeset) instead of only as a whole-tree CI pass. The exact regexes and
// the longest-prefix spoke classifier are lifted from the CLI verbatim, so behavior is identical -
// the only difference is scope (one file's proposed content) and purity (path-resolution math only,
// no fs walk).
//
// Pure + hook-agnostic: the caller supplies the path (repo-relative, posix) and the proposed
// newContent; this resolves cross-spoke edges and checks for DR citations with NO disk access.
// Deterministic - no Date.now() / Math.random(). The SPOKES prefix map is a PARAM (opts.spokeOf)
// so the substrate's spoke topology is supplied by the caller, never hard-baked into the atom.

/** Default GZDS spoke prefix map (mirrors the CLI's SPOKES). The aggregator passes this in. */
export const DEFAULT_SPOKES = Object.freeze({
  claude: ["claude"],
  illuci: ["illuci"],
  constitutional: ["constitutional"],
  primitives: ["primitives"],
});

/** Source-file extensions the rule applies to (lifted from the CLI's SOURCE_EXT). */
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;

// Match both import styles (lifted verbatim from the CLI):
//   import ... from '@/path/to/thing'        -> importAtRe
//   import ... from '../path' / './path'     -> importRelRe
const importAtRe = /^\s*import\s.+?from\s+['"]@\/(.+?)['"]/;
const importRelRe = /^\s*import\s.+?from\s+['"](\.[./]*[^'"]+)['"]/;
const DR_RE = /DR-\d{3}/;

/** Normalize a path to repo-relative posix form (backslashes -> "/", strip a leading "./"). */
function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Resolve a path's owning spoke by longest-prefix match (null = hub / outside every spoke). */
function classify(relPosix, spokes) {
  const rel = normalizePath(relPosix);
  let best = null;
  let bestLen = -1;
  for (const [spoke, prefixes] of Object.entries(spokes)) {
    for (const p of prefixes) {
      if ((rel === p || rel.startsWith(p + "/")) && p.length > bestLen) {
        best = spoke;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/**
 * Resolve a relative-path import target to a repo-relative posix path, then re-classify it.
 * Pure path math: collapse the importing file's directory + the relative segments via a "/"-split
 * stack walk (no fs, no node:path - keeps the atom dependency-free and deterministic).
 */
function resolveRelativeSpoke(fromRelPosix, relImport, spokes) {
  const fromDir = normalizePath(fromRelPosix).split("/").slice(0, -1); // drop the filename
  const segs = normalizePath(relImport).split("/");
  const stack = [...fromDir];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return classify(stack.join("/"), spokes);
}

/**
 * @param {string} path        repo-relative (posix or windows) path of the file being checked
 * @param {string} newContent  the proposed file content
 * @param {object} [opts]
 *   @param {object} [opts.spokeOf]  the SPOKES prefix map { spoke: [prefix,...] }; default DEFAULT_SPOKES
 * @returns {{ok:boolean, code:string, reason:string, violations?:Array<{line:number, from:string, to:string, importPath:string}>}}
 *   ok:true  -> not-spoke-source (hub or non-source file) | ok (all cross-spoke imports cited)
 *   ok:false -> cross-spoke-uncited (with the offending edges)
 */
export function checkCrossSpokeImports(path, newContent, opts = {}) {
  const spokes = opts.spokeOf && typeof opts.spokeOf === "object" ? opts.spokeOf : DEFAULT_SPOKES;
  const rel = normalizePath(path);

  const ownSpoke = classify(rel, spokes);
  if (!ownSpoke || !SOURCE_EXT.test(rel)) {
    return { ok: true, code: "not-spoke-source", reason: "hub or non-source file" };
  }

  const lines = String(newContent == null ? "" : newContent).split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    let importedSpoke = null;
    let importPath = null;

    const atMatch = importAtRe.exec(lines[i]);
    if (atMatch) {
      importedSpoke = classify(atMatch[1], spokes);
      importPath = "@/" + atMatch[1];
    } else {
      const relMatch = importRelRe.exec(lines[i]);
      if (relMatch) {
        importedSpoke = resolveRelativeSpoke(rel, relMatch[1], spokes);
        importPath = relMatch[1];
      }
    }

    if (!importedSpoke || importedSpoke === ownSpoke) continue;

    // Cross-spoke edge. Require a DR citation on this line OR the immediately-preceding one.
    const hasDR = DR_RE.test(lines[i]) || (i > 0 && DR_RE.test(lines[i - 1]));
    if (!hasDR) {
      violations.push({ line: i + 1, from: ownSpoke, to: importedSpoke, importPath });
    }
  }

  if (violations.length > 0) {
    const first = violations[0];
    return {
      ok: false,
      code: "cross-spoke-uncited",
      violations,
      reason: `cross-spoke import [${first.from} -> ${first.to}] at line ${first.line} lacks a DR citation`,
    };
  }

  return { ok: true, code: "ok", reason: "all cross-spoke imports cited" };
}

export default { checkCrossSpokeImports, DEFAULT_SPOKES };
