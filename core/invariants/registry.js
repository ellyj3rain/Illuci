// The single machine-actionable invariant source the enforcement layers read.
export const INVARIANTS = [
  { id: "ground-before-asserting", tier: "soft",
    statement: "Claims about system or file state must be grounded in a tool observation made this turn, never asserted from memory.",
    source: "session-2026-06-17" },
  { id: "no-confabulation", tier: "soft",
    statement: "Introduce no structure, plan, name, or framing the operator did not give. Use only what was stated or what a tool revealed.",
    source: "constitutional/CONSTITUTION.md" },
  { id: "clean-code", tier: "soft",
    statement: "Code is terse and self-evident. Rationale lives in documentation, not in inline annotation or JSDoc essays.",
    source: "operator-2026-06-17" },
  { id: "uniform-naming", tier: "soft",
    statement: "User-facing names carry no implementation affixes such as -cli, -api, or -local. Transport is a property, not part of the name.",
    source: "operator-2026-06-17" },
  { id: "append-only-history", tier: "hard",
    statement: "BATCH_LOG.md, DECISION_REGISTRY.md, and FINDINGS.md are append-only; supersede, never edit a prior entry.",
    source: "GOVERNANCE; primitives/patterns/append-only-supersession",
    rule: appendOnlyHistoryViolation },
  { id: "cross-spoke-contract", tier: "hard",
    statement: "A cross-spoke import cites a DR id in an inline comment.",
    source: "DR-045",
    rule: crossSpokeContractViolation },
];

// ─── Deterministic hard-invariant rules (no judge). Each returns TRUE on violation. ───

const LEDGERS = /(BATCH_LOG|DECISION_REGISTRY|FINDINGS)\.md/;
// Mutation verbs that, applied to an append-only ledger WITHOUT an append/supersede
// marker, signal an in-place edit. Broadened past the original edit/replace set to the
// common synonyms an agent reaches for (change/modify/update/amend/correct/fix/remove).
const EDIT_VERBS = /\b(change|changing|modify|modifying|update|updating|amend|correct|fix|rewrite|rewrote|replace|overwrite|edit|delete|deleted|remove)\b/i;
const APPEND_MARKERS = /\b(append|new entry|supersed)/i;

/** Violates when the output proposes editing (not appending to) an append-only ledger. */
export function appendOnlyHistoryViolation(output) {
  if (typeof output !== "string") return false;
  if (!LEDGERS.test(output)) return false;
  if (!EDIT_VERBS.test(output)) return false;
  return !APPEND_MARKERS.test(output);
}

const SPOKES = ["claude", "illuci", "constitutional", "primitives", "codex", "otl"];
const DR_CITATION = /DR-\d+/;
// A line that performs a module load: a static `import ... from "..."`, a bare
// `import "..."`, a DYNAMIC `import("...")`, or a `require("...")`. The dynamic-import
// branch (`import (`) must precede the bare-`import` branch so the call form matches
// first. The quoted specifier is captured for the spoke-segment test.
const IMPORT_LINE = /(?:\bimport\s*\(|\bimport\b|\bfrom\b|\brequire\s*\()\s*['"`]([^'"`\n]+)['"`]/;
// How many preceding lines to scan for a DR citation (a multiline import or a comment
// placed a line or two above the crossing import still counts as cited).
const DR_WINDOW = 3;
// The specifier names another spoke as a path segment: `claude/...`, `../illuci/...`,
// `primitives/...`. The spoke sits at a path boundary (start, after a slash, or `../`).
const SPOKE_SEGMENT = new RegExp(`(?:^|/)(?:\\.\\./)*(${SPOKES.join("|")})/`);

/**
 * Violates when an output introduces a cross-spoke import WITHOUT a DR citation on or
 * adjacent to that line. Scans line by line: a crossing import line with no DR-\d+ on
 * it or the preceding (comment) line is a violation. A same-spoke or relative import
 * (./sibling, ../throttle) names no spoke and is clean.
 */
export function crossSpokeContractViolation(output) {
  if (typeof output !== "string") return false;
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMPORT_LINE);
    if (!m || !SPOKE_SEGMENT.test(m[1])) continue;
    // Scan a small backward window (not just i-1): a multiline import or a DR comment
    // placed a line or two above the crossing import still satisfies the citation rule.
    let cited = DR_CITATION.test(lines[i]);
    for (let j = i - 1; j >= 0 && j >= i - DR_WINDOW && !cited; j--) {
      if (DR_CITATION.test(lines[j])) cited = true;
    }
    if (!cited) return true;
  }
  return false;
}

export const byId = (id) => INVARIANTS.find((i) => i.id === id) ?? null;
export const soft = () => INVARIANTS.filter((i) => i.tier === "soft");
export const hard = () => INVARIANTS.filter((i) => i.tier === "hard");
