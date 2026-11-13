// Review class, dependency reach and version credit retain separate meanings.
// This pure recommendation layer never mutates VERSION or grants authority.
// Ground Zero Standard13 owns scope-based credit; Std14 owns coherent work.

/** The semantic classes a change can carry, low -> high. */
export const SEMANTIC_CLASSES = Object.freeze([
  "COSMETIC",
  "PATCH",
  "KOHAI",
  "MINOR",
  "CONTRACT",
  "DOCTRINE",
]);

/** Severity rank used by maxClass (and the gated-lane test). Higher = more governance-grade. */
const CLASS_RANK = Object.freeze({
  COSMETIC: 0,
  PATCH: 1,
  KOHAI: 2,
  MINOR: 3,
  CONTRACT: 4,
  DOCTRINE: 5,
});

/** The gated lane: classes requiring contract or policy review, independently of version credit. */
export const GATED_LANE = Object.freeze(["CONTRACT", "DOCTRINE"]);

function normClass(c) {
  return String(c == null ? "" : c).trim().toUpperCase();
}

function isKnownClass(c) {
  return Object.prototype.hasOwnProperty.call(CLASS_RANK, c);
}

function inGatedLane(c) {
  return GATED_LANE.includes(c);
}

/** Dependency reach informs review and verification; it does not change credit. */
export function elevate(semanticClass, _band) {
  return normClass(semanticClass);
}

/** Scope-based recommendation only. Evidence presence is not evidence verification.
 * A contract/policy change retains its separate review responsibility.
 * completed-group requires an explicit recorded operator selection for major.
 */
export function versionAction(effectiveClass, versionScope) {
  const cls = normClass(effectiveClass);
  if (cls === "COSMETIC") return "none";
  if (!isKnownClass(cls)) return "none";
  if (!versionScope || typeof versionScope !== "object" || Array.isArray(versionScope) ||
      failClosedOnEvidence(versionScope).block) return "scope-assessment-required";
  switch (versionScope.kind) {
    case "correction": return "patch";
    case "increment": return "kohai";
    case "completed-feature": return "minor";
    case "completed-group":
      return typeof versionScope.operatorSelection === "string" && versionScope.operatorSelection.trim()
        ? "major" : "operator-selection-required";
    default: return "scope-assessment-required";
  }
}

/**
 * Amendment 2 - fail-closed on evidence.
 *
 * A class assignment must be BACKED by evidence (a cited DR, a structured rationale, a
 * scan result - whatever the surface attaches as `record.evidence`). A change that names
 * a class but carries no evidence is NOT trusted to its claimed (often low) class: it is
 * blocked so the absence surfaces to the operator rather than being waved through.
 *
 * Evidence counts as present when `record.evidence` is a non-empty string or a non-empty
 * array. Anything else (missing, null, "", [], non-string/non-array) is "no evidence".
 *
 * @param {{class?:string, evidence?:(string|Array)}} record
 * @returns {{block:boolean, code:string, reason:string}}
 */
export function failClosedOnEvidence(record) {
  const rec = record || {};
  const ev = rec.evidence;
  const hasEvidence =
    (typeof ev === "string" && ev.trim().length > 0) ||
    (Array.isArray(ev) && ev.length > 0);

  if (!hasEvidence) {
    return {
      block: true,
      code: "no-evidence",
      reason:
        "class assignment carries no evidence; fail-closed (Amendment 2) - attach a cited DR / rationale / scan result before this change is scored at its claimed class",
    };
  }
  return {
    block: false,
    code: "evidenced",
    reason: "class assignment is backed by evidence",
  };
}

/**
 * Amendment 3 - batch-level max.
 *
 * A batch is a bundle of changes, each with its own class. The batch is scored at its
 * SINGLE HIGHEST class - the most governance-grade change in the bundle sets the review class, so
 * a doctrine-grade change cannot be diluted by being shipped alongside cosmetic ones.
 *
 * Unknown / unresolved entries are ignored for the max (they are handled by
 * haltDontDefault / failClosedOnEvidence upstream); an empty or all-unknown batch yields
 * the floor class COSMETIC.
 *
 * @param {string[]} classes  the per-change semantic classes in the batch
 * @returns {string} the highest known class (an entry of SEMANTIC_CLASSES)
 */
export function maxClass(classes) {
  const list = Array.isArray(classes) ? classes : [];
  let best = "COSMETIC";
  let bestRank = CLASS_RANK.COSMETIC;
  for (const c of list) {
    const cls = normClass(c);
    if (!isKnownClass(cls)) continue;
    if (CLASS_RANK[cls] > bestRank) {
      best = cls;
      bestRank = CLASS_RANK[cls];
    }
  }
  return best;
}

/**
 * Amendment 4 - halt, don't default.
 *
 * When a change's class cannot be resolved (the classifier returns UNRESOLVED, or any
 * unknown/missing class), the ceiling does NOT silently fall back to a low tier (the exact
 * failure that let an under-scored change through). It HALTS and routes the decision to the
 * operator - operator-mediated execution (constitutional/CONSTITUTION.md): an ambiguous class is a
 * decision point, not a default.
 *
 * A resolved, known class passes (halt:false). UNRESOLVED, or any unknown class, halts.
 *
 * @param {string} cls
 * @returns {{halt:boolean, route?:string, code:string, reason:string}}
 */
export function haltDontDefault(cls) {
  const c = normClass(cls);
  if (c === "UNRESOLVED" || !isKnownClass(c)) {
    return {
      halt: true,
      route: "operator",
      code: "unresolved-class",
      reason:
        `class "${c || "(empty)"}" is unresolved; halt and route to the operator (Amendment 4) - an ambiguous class is a decision point, never silently defaulted to a low tier`,
    };
  }
  return {
    halt: false,
    code: "resolved",
    reason: `class "${c}" is resolved`,
  };
}

/**
 * Amendment 5 - an un-DR'd cross-spoke edge is doctrine.
 *
 * ARCHITECTURE.md: cross-spoke consumption requires an explicit named contract. An edge
 * between spokes that is NOT governed by a DR is therefore not a quiet PATCH - introducing
 * un-contracted cross-spoke coupling is a DOCTRINE-grade act (it changes the spoke topology
 * the whole system depends on). This maps each un-DR'd edge to a DOCTRINE finding so it
 * enters the gated lane rather than slipping through as a small import diff.
 *
 * @param {Array<{from?:string, to?:string, dr?:(string|null)}>} unDrEdges
 *        edges already determined to lack a governing DR (the caller derives these from the
 *        graph + DR-contract source); each is reported as a DOCTRINE finding.
 * @returns {{ok:boolean, code:string, reason:string, findings:Array<{class:string, edge:object, code:string, reason:string}>}}
 *   ok:true with an empty findings list when there are no un-DR'd edges; ok:false otherwise.
 */
export function unDrEdgeIsDoctrine(unDrEdges) {
  const edges = Array.isArray(unDrEdges) ? unDrEdges : [];
  const findings = edges.map((e) => {
    const edge = e || {};
    const from = String(edge.from == null ? "?" : edge.from);
    const to = String(edge.to == null ? "?" : edge.to);
    return {
      class: "DOCTRINE",
      edge: { from, to },
      code: "un-dr-cross-spoke-edge",
      reason:
        `cross-spoke edge ${from} -> ${to} has no governing DR; cross-spoke consumption requires an explicit named contract (ARCHITECTURE.md), so this is a DOCTRINE-grade finding (Amendment 5), not a quiet patch`,
    };
  });

  if (findings.length === 0) {
    return {
      ok: true,
      code: "no-undr-edges",
      reason: "no un-DR'd cross-spoke edges",
      findings,
    };
  }
  return {
    ok: false,
    code: "undr-edge-doctrine",
    reason: `${findings.length} un-DR'd cross-spoke edge(s) classified DOCTRINE (Amendment 5)`,
    findings,
  };
}

export default {
  SEMANTIC_CLASSES,
  GATED_LANE,
  elevate,
  versionAction,
  failClosedOnEvidence,
  maxClass,
  haltDontDefault,
  unDrEdgeIsDoctrine,
};
