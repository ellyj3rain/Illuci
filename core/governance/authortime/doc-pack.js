// illuci/core/governance/authortime/doc-pack.js
//
// FLOOR atom: the GZS doc-pack must stay COMPLETE at a managed root. A GZS-managed project
// root carries the canonical 9 doc-pack files (the "Document set - the
// canonical 9") PLUS the root VERSION (the odometer source the version-gate atom guards).
// The failure this catches is a deletion that drops the pack below the floor - an agent (or a
// careless refactor) removing ROADMAP.md / SESSION_STATE.md / VERSION from a root that is, by
// the presence of the other pack files, declaring itself GZS-managed.
// GOVERNANCE.md's Hub-and-Spoke Memory Boundary treats this set as the hub's load-bearing
// memory; an incomplete pack is a silently-broken governance root.
//
// Pure + hook-agnostic: the atom does NO I/O. The caller supplies rootRelFiles - the array of
// repo-root-relative filenames that exist at the governance root AFTER the proposed change (a
// directory listing the floor runner gathers). The atom just compares that listing against the
// canonical pack. Deterministic, no clock, no randomness.
//
// SELF-SCOPING GUARD (false-positive-free): the atom only evaluates a root that is ALREADY a
// GZS pack. If NONE of the canonical files are present, the root is not a doc-pack root (a
// plain source subdir, a vendored tree) and the check returns 'not-a-pack' rather than
// demanding nine files of every directory. A root with at least one canonical file IS asserting
// pack-hood, so a missing member is then a real incompleteness.
//
// PRESERVATION VARIANT (mirrors header.js): a caller that passes priorRootFiles scopes the
// block to files the change actually REMOVED, so a pre-existing partial pack (one that was
// already missing a member before this change) is not retroactively blamed on the current
// commit - only a NEW removal that drops a member is blocked. Use checkDocPackComplete for the
// absolute floor (the pack must be whole now) and checkDocPackPreserved for the change-scoped
// form (this change must not remove a member).

/**
 * The canonical GZS doc-pack: the 9 doc-pack files + the root VERSION. Order mirrors
 * the "Document set (the canonical 9)" table, with VERSION (the odometer
 * source) appended.
 */
export const CANONICAL_PACK = Object.freeze([
  "MEMORY.md",
  "CORE.md",
  "ARCHITECTURE.md",
  "GOVERNANCE.md",
  "DECISION_REGISTRY.md",
  "FINDINGS.md",
  "BATCH_LOG.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
  "VERSION",
]);

/**
 * Is this root a GZS doc-pack root? True iff at least one canonical file is present - the
 * presence of any pack member is the root declaring itself GZS-managed. A root with none of
 * them is a plain subdir and is out of scope (avoids false-positiving non-pack directories).
 * @param {string[]} rootRelFiles  filenames present at the governance root
 * @returns {boolean}
 */
export function isDocPackRoot(rootRelFiles) {
  const present = new Set(Array.isArray(rootRelFiles) ? rootRelFiles : []);
  return CANONICAL_PACK.some((f) => present.has(f));
}

/**
 * Absolute floor: a GZS-managed root must carry the full canonical pack.
 *
 * @param {string[]} rootRelFiles  repo-root-relative filenames that exist at the governance
 *   root AFTER the proposed change (caller supplies via a directory listing; no I/O here).
 * @param {object} [opts]          reserved for future scoping options; unused today.
 * @returns {{ok:boolean, code:string, reason:string, missing?:string[]}}
 *   ok:true  -> not-a-pack (root is not a doc-pack root) | complete
 *   ok:false -> doc-pack-incomplete (with the missing members)
 */
export function checkDocPackComplete(rootRelFiles, opts = {}) {
  void opts;
  const present = new Set(Array.isArray(rootRelFiles) ? rootRelFiles : []);

  // Self-scoping guard: a root with NONE of the canonical files is not a GZS pack root.
  if (!CANONICAL_PACK.some((f) => present.has(f))) {
    return { ok: true, code: "not-a-pack", reason: "root is not a GZS doc-pack root" };
  }

  const missing = CANONICAL_PACK.filter((f) => !present.has(f));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "doc-pack-incomplete",
      missing,
      reason: `GZS doc-pack is incomplete: missing ${missing.join(", ")} -- the canonical 9 + VERSION must all be present at a managed root`,
    };
  }
  return { ok: true, code: "complete", reason: "doc-pack complete" };
}

/**
 * PRESERVATION VARIANT (mirrors header.js's preservation model). Scopes the block to the pack
 * members this change actually REMOVED, so a root that was ALREADY missing a member before the
 * change is not retroactively blamed on the current commit - only a fresh removal that drops a
 * member below the floor is blocked. False-positive-free on pre-existing partial packs.
 *
 * @param {string[]} priorRootFiles  filenames present at the root BEFORE the change.
 * @param {string[]} rootRelFiles     filenames present at the root AFTER the change.
 * @returns {{ok:boolean, code:string, reason:string, removed?:string[]}}
 *   ok:true  -> not-a-pack | preserved (no canonical member removed by this change)
 *   ok:false -> doc-pack-member-removed (with the members this change removed)
 */
export function checkDocPackPreserved(priorRootFiles, rootRelFiles) {
  const prior = new Set(Array.isArray(priorRootFiles) ? priorRootFiles : []);
  const after = new Set(Array.isArray(rootRelFiles) ? rootRelFiles : []);

  // Only weigh a root that was, before the change, already a GZS pack root (or still is). If it
  // was never a pack root and isn't one now, there is nothing to preserve.
  const priorIsPack = CANONICAL_PACK.some((f) => prior.has(f));
  const afterIsPack = CANONICAL_PACK.some((f) => after.has(f));
  if (!priorIsPack && !afterIsPack) {
    return { ok: true, code: "not-a-pack", reason: "root is not a GZS doc-pack root" };
  }

  // The canonical members this change removed (present before, absent after).
  const removed = CANONICAL_PACK.filter((f) => prior.has(f) && !after.has(f));
  if (removed.length > 0) {
    return {
      ok: false,
      code: "doc-pack-member-removed",
      removed,
      reason: `this change removes GZS doc-pack member(s): ${removed.join(", ")} -- the canonical 9 + VERSION must stay present at a managed root (append a superseding state, do not drop a pack file)`,
    };
  }
  return { ok: true, code: "preserved", reason: "no doc-pack member removed by this change" };
}

export default { CANONICAL_PACK, isDocPackRoot, checkDocPackComplete, checkDocPackPreserved };
