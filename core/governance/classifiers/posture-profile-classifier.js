// illuci/core/governance/classifiers/posture-profile-classifier.js
//
// [A59] Detect posture drift: version-only behavioral mandates, false
// binaries, historical compatibility residue, hardcoded phrase bindings, and
// competence-removing profile claims are operator-routed instead of silently
// shaping the runtime.

import { resolvePostureProfile } from "../posture-profile.js";
import { makeGovernedVerdict, makeSignal, SEVERITIES } from "./governed-verdict.js";

export const POSTURE_PROFILE_CLASSIFIER = "illuci.governance.posture-profile-classifier/1";

function hasExplicitAuthority(input = {}) {
  return Boolean(input.operatorProfile || input.projectPolicy || input.agentProfile);
}

export function classifyOperatorPosture(input = {}) {
  const posture = resolvePostureProfile(input);
  const claim = input.claim && typeof input.claim === "object" ? input.claim : {};
  const signals = [];

  if (claim.versionDeterminesBehavior === true) {
    signals.push(makeSignal({
      code: "version-only-posture-mandate",
      severity: SEVERITIES.OPERATOR,
      dimension: "authority",
      evidence: "A claim makes version or maturity alone prescribe runtime behavior.",
      next: "Resolve behavior through an operator, project, or agent posture profile.",
      data: { version: posture.version, maturity: posture.maturity },
    }));
  }

  if (claim.fixedPhraseActionBinding === true) {
    signals.push(makeSignal({
      code: "fixed-phrase-action-binding",
      severity: SEVERITIES.CAUTION,
      dimension: "operator-optionality",
      evidence: "A claim binds user phrases directly to actions instead of treating bindings as configurable data.",
      next: "Expose action bindings as operator/project policy, not engine folklore.",
    }));
  }

  if (claim.binaryModeBinding === true) {
    signals.push(makeSignal({
      code: "false-binary-posture-binding",
      severity: SEVERITIES.CAUTION,
      dimension: "operator-optionality",
      evidence: "A claim frames posture as a forced binary/mode when the surface should be a justified gradient or truly discrete rule.",
      next: "Express the behavior as a named variable with range, effect, and justification, or prove the choice is genuinely discrete.",
    }));
  }

  if (claim.removesBasicCompetence === true) {
    signals.push(makeSignal({
      code: "competence-floor-removal",
      severity: SEVERITIES.BLOCK,
      dimension: "competence-floor",
      evidence: "A posture claim would remove basic task pursuit, context awareness, authorized tool use, verification, or uncertainty reporting.",
      next: "Reject the variable or rewrite it so it only biases priorities/thresholds while preserving the competence floor.",
    }));
  }

  if (claim.keepSurfaceBecauseHistorical === true) {
    signals.push(makeSignal({
      code: "historical-residue-kept-live",
      severity: SEVERITIES.CAUTION,
      dimension: "surface-retirement",
      evidence: "A claim preserves a live surface only because it existed before.",
      next: "Prove current purpose or retire the surface with recorded replacement/history.",
    }));
  }

  if (claim.irreversibleChange === true && !hasExplicitAuthority(input)) {
    signals.push(makeSignal({
      code: "irreversible-change-without-profile-authority",
      severity: SEVERITIES.OPERATOR,
      dimension: "authority",
      evidence: "An irreversible posture-sensitive action lacks explicit operator/project/agent authority.",
      next: "Attach a current posture profile or route the decision to the operator.",
    }));
  }

  const requiresOperator = signals.some((signal) => signal.severity === SEVERITIES.OPERATOR);
  return {
    ...makeGovernedVerdict({
      classifier: POSTURE_PROFILE_CLASSIFIER,
      subject: String(input.subject || "posture-profile"),
      decision: requiresOperator ? "operator-required" : "profile-resolved",
      strategy: "profile-precedence",
      allowed: signals.every((signal) => signal.severity !== SEVERITIES.OPERATOR && signal.severity !== SEVERITIES.BLOCK),
      requiresOperator,
      code: requiresOperator ? "posture-profile-authority-required" : signals.length ? "posture-profile-caution" : "posture-profile-clear",
      evidence: "Posture was resolved through profile precedence with version maturity treated as evidence and variables treated as justified gradients.",
      next: requiresOperator ? "Collect or select explicit posture authority before acting." : null,
      dimensions: { posture },
      signals,
    }),
    posture,
  };
}

export default { POSTURE_PROFILE_CLASSIFIER, classifyOperatorPosture };
