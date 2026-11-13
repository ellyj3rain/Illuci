// illuci/core/governance/authortime/operator-pause.js
//
// FLOOR-layer presence for the operator-mediated-pause adherence atom (constitutional/CONSTITUTION.md).
//
// The substantive judgment lives in the CEILING rule (ceiling/operator-pause.js): it is
// intrinsically a heuristic, so it is WARN-tier and never blocks. This floor-layer module is the
// thin presence that lets the floor aggregator surface the same signal through its policy
// machinery. It carries its own atom name (ATOM) and warn-tier default (DEFAULT_POLICY) so the
// floor aggregator can register it under the existing { atom: "block"|"warn"|"off" } contract
// without this module re-implementing any logic - it delegates to the ceiling's
// checkOperatorPause and re-shapes the verdict into the floor atom's { ok, code, reason }
// contract, mirroring haltDontDefault's { route: "operator" } posture so the flag emits to the
// operator-route channel rather than the blocking channel.
//
// Pure + hook-agnostic: the hook reads the prior (HEAD) and proposed (staged / working) content
// and calls assessOperatorPause. No git, no I/O, no clock here.

import { checkOperatorPause } from "./ceiling/operator-pause.js";

/** The floor-policy atom name this module registers under. */
export const ATOM = "operator-pause";

/** The operator-default audit posture: warn-tier (the doc names this a judgment; it never blocks). */
export const DEFAULT_POLICY = "warn";

/**
 * Floor-layer wrapper over the ceiling's operator-pause heuristic. Always advisory: a positive
 * detection is routed to the operator (route: "operator"), never blocked. The reason / signals
 * pass through verbatim from the ceiling rule.
 *
 * @param {string} path        repo-relative path of the changed file
 * @param {string} oldContent  prior committed content (empty/null = new file)
 * @param {string} newContent  proposed content
 * @returns {{ok:boolean, code:string, reason:string, route?:string, signals?:Array<{line:number,text:string}>}}
 *   ok:true  -> out-of-scope | ok                              (no route)
 *   ok:false -> unratified-lock-language, route:"operator"     (warn-tier; surfaces, never blocks)
 */
export function assessOperatorPause(path, oldContent, newContent) {
  const v = checkOperatorPause(path, oldContent, newContent);
  if (v.ok) return { ok: true, code: v.code, reason: v.reason };
  return { ok: false, code: v.code, route: "operator", reason: v.reason, signals: v.signals };
}

export default { assessOperatorPause, ATOM, DEFAULT_POLICY };
