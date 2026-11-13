// illuci/core/governance/compiler/ir/promise-gap.js
//
// Promise-gap analysis: a governed standard that produces no enforcement is a commitment with
// no mechanism. Three classes (ratified): A = a standard/article named in the prose with NO
// declaration file; B = a declared obligation the backend cannot realize (no mechanism); C =
// a standard whose every obligation is soft-only (post-hoc, never blocks or carries). The
// compile FAILS on A or B (genuine gaps) and ALLOWS C (inherently post-hoc) and HUMAN
// (un-mechanizable). Pure: it reads the lowered obligations + the prose-declared source set.

export const GAP = Object.freeze({
  NO_DECLARATION: "no_declaration",
  NO_MECHANISM: "no_mechanism",
  SOFT_ONLY: "soft_only",
});
// Genuine gaps fail the compile; soft_only is allowed (a design-grade note).
export const FAILING = new Set([GAP.NO_DECLARATION, GAP.NO_MECHANISM]);

/**
 * @param {Array} lowered  obligations lowered (each {id, source_key, tier, backend, human, unmatched})
 * @param {Array<{key:string,label:string,declared:boolean}>} prose  standards/articles named in prose + whether declared
 * @returns {{gaps:Array, failing:boolean}}
 */
export function analyze(lowered, prose) {
  const gaps = [];

  // Class A: prose names it, no declaration file.
  for (const p of prose || []) {
    if (!p.declared) {
      gaps.push({ class: GAP.NO_DECLARATION, source_key: p.key, label: p.label, reason: "named in prose, no .obligation.json declaration" });
    }
  }

  // Group lowered obligations by source; Class B per obligation.
  const bySource = new Map();
  for (const o of lowered || []) {
    if (!bySource.has(o.source_key)) bySource.set(o.source_key, []);
    bySource.get(o.source_key).push(o);
    if ((o.backend === "none" || o.unmatched) && !o.human) {
      gaps.push({ class: GAP.NO_MECHANISM, source_key: o.source_key, obligation: o.id, reason: "declared but maps to no backend mechanism" });
    }
  }

  // Class C: a source whose every non-human obligation is soft-tier (never blocks or carries).
  for (const [key, obs] of bySource) {
    const enforceable = obs.filter((o) => !o.human);
    if (enforceable.length && enforceable.every((o) => o.tier === "soft")) {
      gaps.push({ class: GAP.SOFT_ONLY, source_key: key, reason: "every obligation is soft-only (post-hoc); no hard or carried enforcement" });
    }
  }

  return { gaps, failing: gaps.some((g) => FAILING.has(g.class)) };
}

export default { analyze, GAP, FAILING };
