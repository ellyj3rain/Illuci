// illuci/core/governance/authortime/ceiling/cross-spoke-reach.js
//
// Ceiling: the cross-spoke EDGE classifier (the tier-judgment companion to the floor's
// cross-spoke-dr-citation block).
//
// The floor atom (cross-spoke-dr-citation.js) answers the mechanical question: "does every
// cross-spoke import cite a DR?" - a pass/fail gate. This ceiling rule answers the TIER question:
// "what governance weight does introducing a cross-spoke edge carry?" Per ARCHITECTURE.md, a
// cross-spoke edge is the spoke topology the whole system depends on, so it is never a quiet
// PATCH:
//
//   - a CITED cross-spoke edge (DR present) is a CONTRACT-class change - it is the explicit named
//     contract ARCHITECTURE.md requires, which routes to the operator-gated lane (elevation.js's
//     versionAction maps CONTRACT -> 'scope-assessment-required').
//   - an UNCITED cross-spoke edge is DOCTRINE-class - introducing un-contracted cross-spoke
//     coupling changes the topology without governance, which is the heaviest class. This is the
//     same finding elevation.js's Amendment 5 (unDrEdgeIsDoctrine) folds into the batch; this rule
//     is the per-file scanner that PRODUCES those edges from a changed source file, so the floor's
//     content-diff changeset can feed the ceiling without a separate whole-tree graph pass.
//
// ADVISORY by construction (the ceiling never blocks): it returns the edges and their classes for
// the ceiling aggregator to fold into the batch tier. PURE - the same path-resolution math and the
// same regexes as the floor atom (no fs, no clock, no Date.now()/Math.random()), and the SPOKES
// map is a PARAM.

import { DEFAULT_SPOKES } from "../cross-spoke-dr-citation.js";

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;
const importAtRe = /^\s*import\s.+?from\s+['"]@\/(.+?)['"]/;
const importRelRe = /^\s*import\s.+?from\s+['"](\.[./]*[^'"]+)['"]/;
const DR_RE = /DR-\d{3}/;

function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

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

function resolveRelativeSpoke(fromRelPosix, relImport, spokes) {
  const fromDir = normalizePath(fromRelPosix).split("/").slice(0, -1);
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
 * Scan one changed source file's content for cross-spoke import edges and classify each by its
 * citation state. ADVISORY (no block); PURE.
 *
 * @param {string} path        repo-relative path of the file
 * @param {string} newContent  the proposed content
 * @param {object} [opts]
 *   @param {object} [opts.spokeOf]  the SPOKES prefix map; default DEFAULT_SPOKES
 * @returns {{ok:boolean, code:string, reason:string,
 *            edges:Array<{line:number, from:string, to:string, importPath:string, dr:(string|null), class:string}>}}
 *   ok:true  -> not-spoke-source | no-cross-spoke-edges | all-edges-contracted (all cited)
 *   ok:false -> uncited-cross-spoke-edge (at least one un-DR'd edge -> DOCTRINE)
 */
export function classifyCrossSpokeReach(path, newContent, opts = {}) {
  const spokes = opts.spokeOf && typeof opts.spokeOf === "object" ? opts.spokeOf : DEFAULT_SPOKES;
  const rel = normalizePath(path);

  const ownSpoke = classify(rel, spokes);
  if (!ownSpoke || !SOURCE_EXT.test(rel)) {
    return { ok: true, code: "not-spoke-source", reason: "hub or non-source file", edges: [] };
  }

  const lines = String(newContent == null ? "" : newContent).split(/\r?\n/);
  const edges = [];

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

    const sameLine = DR_RE.exec(lines[i]);
    const prevLine = i > 0 ? DR_RE.exec(lines[i - 1]) : null;
    const dr = (sameLine && sameLine[0]) || (prevLine && prevLine[0]) || null;
    // A cited edge is the explicit named contract ARCHITECTURE.md requires (CONTRACT, gated lane);
    // an uncited edge is un-contracted topology coupling (DOCTRINE, Amendment 5).
    const cls = dr ? "CONTRACT" : "DOCTRINE";
    edges.push({ line: i + 1, from: ownSpoke, to: importedSpoke, importPath, dr, class: cls });
  }

  if (edges.length === 0) {
    return { ok: true, code: "no-cross-spoke-edges", reason: "no cross-spoke imports", edges };
  }

  const uncited = edges.filter((e) => e.dr == null);
  if (uncited.length > 0) {
    const first = uncited[0];
    return {
      ok: false,
      code: "uncited-cross-spoke-edge",
      edges,
      reason: `cross-spoke edge ${first.from} -> ${first.to} at line ${first.line} has no governing DR; un-contracted cross-spoke coupling is DOCTRINE-grade (ARCHITECTURE.md / Amendment 5), not a quiet patch`,
    };
  }

  return {
    ok: true,
    code: "all-edges-contracted",
    edges,
    reason: `${edges.length} cross-spoke edge(s), all DR-cited (CONTRACT class, operator-gated lane)`,
  };
}

export default { classifyCrossSpokeReach };
