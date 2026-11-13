// illuci/core/governance/authortime/ceiling/doc-pack-shape.js
//
// Ceiling: the doc-pack SHAPE rule (advisory tier-judgment, the complement of the
// doc-pack.js floor atom).
//
// The floor atom (../doc-pack.js, checkDocPackComplete) is the unattended pass/fail gate: a
// GZS-managed root must carry the canonical 9 + VERSION, and a deletion that drops a member
// below the floor is BLOCKED. This ceiling rule is the attended judgment layer over the same
// event: when a change touches the doc-pack's shape, what TIER is that change, and where does
// it route? The doc-pack is the hub's load-bearing memory; per
// GOVERNANCE.md's Hub-and-Spoke Memory Boundary these files ARE the hub. So a change to the
// pack's membership is governance-grade by location, regardless of how small the diff looks -
// the same "doctrine by structure" precedence semantic.js applies to constitutional/ paths.
//
// CLASSES RETURNED (aligned with elevation.js's SEMANTIC_CLASSES):
//   DOCTRINE  - a canonical member was REMOVED (the pack membership shrank). The heaviest
//               class; it routes to the operator-gated path (a pack file is not a self-serve
//               deletion). This is the ceiling reading of the same removal the floor BLOCKS.
//   MINOR     - a canonical member was ADDED to a root that is now (or was already) a pack
//               root - additive pack formation / completion (e.g. instantiating the pack).
//   COSMETIC  - membership unchanged at a pack root (a within-file edit is judged by the
//               per-file semantic atom, not this shape rule).
//   not-a-pack- the root is not a GZS doc-pack root in either state - out of scope.
//
// ADVISORY by construction (mirrors the ceiling contract): this rule NEVER blocks. It proposes
// a class and, for a removal, raises a HALT routed to the operator (constitutional/CONSTITUTION.md,
// operator-mediated execution). The floor is the gate; the ceiling is the judgment.
//
// STYLE: pure function, the {class, halt, route, code, reason} shape, JSDoc, no
// Date.now()/Math.random() - deterministic given inputs. No I/O: the caller supplies the
// before/after root listings (the same listing the floor atom consumes).

import { CANONICAL_PACK } from "../doc-pack.js";

const PACK = new Set(CANONICAL_PACK);

/** Canonical members present in a listing (a Set of pack-only filenames). */
function packMembersIn(rootRelFiles) {
  const present = new Set(Array.isArray(rootRelFiles) ? rootRelFiles : []);
  return new Set(CANONICAL_PACK.filter((f) => present.has(f)));
}

/**
 * Judge the TIER of a change to a GZS doc-pack root's SHAPE (its membership), advisory.
 *
 * @param {string[]} priorRootFiles  filenames present at the root BEFORE the change.
 * @param {string[]} rootRelFiles     filenames present at the root AFTER the change.
 * @returns {{class:string, halt:boolean, route?:string, code:string, reason:string, removed?:string[], added?:string[]}}
 *   class: DOCTRINE | MINOR | COSMETIC | (none for not-a-pack)
 *   halt:true only for a removal (routes to the operator); never blocks the commit.
 */
export function classifyDocPackShape(priorRootFiles, rootRelFiles) {
  const before = packMembersIn(priorRootFiles);
  const after = packMembersIn(rootRelFiles);

  // Out of scope: neither state is a GZS pack root.
  if (before.size === 0 && after.size === 0) {
    return { class: "COSMETIC", halt: false, code: "not-a-pack", reason: "root is not a GZS doc-pack root - out of scope for the shape rule" };
  }

  const removed = CANONICAL_PACK.filter((f) => before.has(f) && !after.has(f));
  const added = CANONICAL_PACK.filter((f) => !before.has(f) && after.has(f));

  // A removed canonical member: doctrine-grade by structure, routed to the operator.
  if (removed.length > 0) {
    return {
      class: "DOCTRINE",
      halt: true,
      route: "operator",
      code: "doc-pack-member-removed",
      removed,
      reason: `doc-pack membership shrank: ${removed.join(", ")} removed -- the canonical pack is the hub's load-bearing memory (GOVERNANCE.md); removing a member is a governance-grade change, route to the operator`,
    };
  }

  // Purely additive pack formation / completion: a new member, nothing removed.
  if (added.length > 0) {
    return {
      class: "MINOR",
      halt: false,
      code: "doc-pack-member-added",
      added,
      reason: `doc-pack membership grew: ${added.join(", ")} added with nothing removed -- additive pack formation`,
    };
  }

  // Membership unchanged at a pack root: this shape rule has nothing to weigh (within-file
  // edits are the per-file semantic atom's job).
  return { class: "COSMETIC", halt: false, code: "membership-unchanged", reason: "doc-pack membership unchanged at a pack root" };
}

export { PACK };
export default { classifyDocPackShape };
