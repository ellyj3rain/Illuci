// illuci/core/governance/authortime/ceiling/cast-trailer.js
//
// Ceiling rule: the Standard 15 attribution advisory.
//
// The floor atom (../cast-trailer.js, checkAttribution) checks the one Git-scope
// attribution grammar illuci can enforce mechanically: a commit message must not carry a
// model-named Co-Authored-By trailer. Cast, persona, role, topology, harness, and model
// provenance belongs in ledgers, runtime records, or explanatory prose when relevant; a
// Cast: trailer is not required repository hygiene.
//
// STYLE: pure rule (message in, finding out), JSDoc, no Date.now()/Math.random().

import { checkAttribution } from "../cast-trailer.js";

const FINDINGS = Object.freeze({
  "model-coauthor-present": {
    code: "attribution-model-coauthor",
    reason:
      "commit message carries a model Co-Authored-By trailer; per Standard 15, Git authorship stays with the human operator while model and harness participation belong in provenance records",
  },
});

/**
 * Weigh a commit message's attribution surface and return a ceiling advisory finding.
 * PURE + message-aware because attribution lives in the message, not the diff. Never
 * raises a HALT and never blocks; attribution remains advisory at this layer.
 *
 * @param {string|null} message  the full commit message text
 * @returns {{ok:boolean, severity:('clean'|'advisory'), route:(string|null),
 *            code:string, reason:string}}
 */
export function ruleAttribution(message) {
  const verdict = checkAttribution(message);
  if (verdict.ok) {
    return {
      ok: true,
      severity: "clean",
      route: null,
      code: verdict.code,
      reason:
        verdict.code === "no-message"
          ? "no commit message to weigh"
          : "commit carries no model-named Git coauthor trailer",
    };
  }

  const finding = FINDINGS[verdict.code] || {
    code: "attribution-issue",
    reason: verdict.reason,
  };
  return {
    ok: false,
    severity: "advisory",
    route: "operator",
    code: finding.code,
    reason: finding.reason,
  };
}

export default { ruleAttribution };
