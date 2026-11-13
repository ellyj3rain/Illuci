// illuci/core/governance/authortime/version-gate.js
//
// The author-time FLOOR atom that closes the DR-119 / DR-135 bypass.
//
// assessOdometer only checks that a value is LEGAL (in-range) - it accepts 5.8.0.0 -> 5.10.0.0
// because both are legal. But the failure that actually happened was an agent hand-EDITING
// VERSION mid-session to a legal-but-WRONG value, skipping the bump helper. So legality
// alone is necessary but not sufficient. This gate DERIVES the legal successors of the
// prior version (via computeNextVersion, the single source) and COMPARES the proposed
// value against them, blocking any transition that is not a valid single-step bump.
//
// Pure + hook-agnostic on purpose: the git pre-commit hook and CI (and a future PreToolUse
// adapter) read the prior VERSION (HEAD) and the proposed VERSION (staged / working tree) and
// call this. No git, no I/O here - unit-testable and reusable across every trigger surface.
//
// FLOOR scope: "is this a valid single-step odometer transition." It does NOT judge whether
// the chosen tier is semantically correct (a patch that should have been a minor) - that is
// the CEILING's warn-tier job. The floor blocks invalid transitions; the ceiling flags
// wrong-but-valid ones.

import { assessOdometer, computeNextVersion, MATURITY_LADDER, maturitySuccessors } from "../assess.js";

const TIERS = ["patch", "kohai", "minor", "major", "hotfix"];

function coreOfAssessedVersion(a) {
  if (a.coordinateFormat === "four") return `${a.major}.${a.minor}.${a.kohai}.${a.patch}`;
  return `${a.major}.${a.minor}.${a.patch}`;
}

function maturityStampSuccessors(version) {
  const a = assessOdometer(version);
  if (!a.legal || a.maturity !== null) return [];
  const core = coreOfAssessedVersion(a);
  return MATURITY_LADDER.map((maturity) => `${core}-${maturity}`);
}

/**
 * @param {string|null} prior   the last committed VERSION (null/empty = no prior / initial)
 * @param {string} proposed     the VERSION being introduced this commit
 * @returns {{ok:boolean, code:string, reason:string, tier?:string, expected?:string[]}}
 *   codes: initial | unchanged | valid-bump  (ok:true)
 *          illegal-version | illegal-prior | invalid-transition  (ok:false)
 */
export function checkVersionTransition(prior, proposed) {
  const p = String(proposed == null ? "" : proposed).trim();

  const proposedLegal = assessOdometer(p);
  if (!proposedLegal.legal) {
    return { ok: false, code: "illegal-version", reason: `proposed VERSION "${p}" is illegal: ${proposedLegal.violation}` };
  }

  const pr = prior == null ? null : String(prior).trim();
  if (pr === null || pr === "") {
    return { ok: true, code: "initial", reason: `initial VERSION ${p}` };
  }
  if (pr === p) {
    return { ok: true, code: "unchanged", reason: "VERSION unchanged" };
  }

  const priorLegal = assessOdometer(pr);
  if (!priorLegal.legal) {
    return { ok: false, code: "illegal-prior", reason: `prior VERSION "${pr}" is illegal (${priorLegal.violation}); reconcile the odometer before bumping` };
  }

  const successors = TIERS
    .map((t) => { const r = computeNextVersion(pr, t); return r.ok ? { tier: t, next: r.next } : null; })
    .filter(Boolean);
  const match = successors.find((s) => s.next === p);
  if (match) {
    return { ok: true, code: "valid-bump", tier: match.tier, reason: `VERSION ${pr} -> ${p} (${match.tier} bump)` };
  }

  // Legacy bare versions may receive a maturity stamp while taking a valid count bump. Once a
  // version already carries a maturity suffix, exact successors above are authoritative.
  const coreOf = (v) => String(v).split("-")[0];
  const priorIsBare = !pr.includes("-");
  if (priorIsBare) {
    const stamped = successors.find((s) => coreOf(s.next) === coreOf(p) && maturityStampSuccessors(s.next).includes(p));
    if (stamped) {
      return { ok: true, code: "valid-bump", tier: stamped.tier, reason: `VERSION ${pr} -> ${p} (${stamped.tier} bump with maturity stamp)` };
    }
  }

  // A maturity promotion (same odometer count; the suffix climbs a rung, or rc -> bare GA) is valid too.
  if (maturitySuccessors(pr).includes(p)) {
    return { ok: true, code: "valid-maturity", reason: `VERSION ${pr} -> ${p} (maturity promotion)` };
  }

  // A legacy bare version may receive a same-core maturity stamp when the repo adopts
  // the suffix policy after the fact. This keeps the odometer count stable.
  if (maturityStampSuccessors(pr).includes(p)) {
    return { ok: true, code: "valid-maturity-stamp", reason: `VERSION ${pr} -> ${p} (maturity stamp)` };
  }

  const expected = [...new Set([
    ...successors.map((s) => `${s.next} [${s.tier}]`),
    ...maturitySuccessors(pr).map((v) => `${v} [maturity]`),
    ...maturityStampSuccessors(pr).map((v) => `${v} [maturity-stamp]`),
  ])];
  return {
    ok: false,
    code: "invalid-transition",
    reason: `VERSION ${pr} -> ${p} is not a valid single-step odometer bump (expected one of: ${expected.join(", ")}); this looks like a hand-set jump - run the bump helper or reconcile`,
    expected,
  };
}

export default { checkVersionTransition };
