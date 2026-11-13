import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPETENCE_FLOOR,
  POSTURE_PROFILE_SCHEMA,
  parseProfileJson,
  postureProfileSnapshot,
  resolvePostureProfile,
} from "./posture-profile.js";

test("version maturity supplies evidence through justified gradients, not a mode", () => {
  const posture = resolvePostureProfile({ version: "6.0.0.0-alpha" });
  assert.equal(posture.schema, POSTURE_PROFILE_SCHEMA);
  assert.equal(posture.maturity, "alpha");
  assert.equal(posture.contracts.versionMaturity, "evidence-not-authority");
  assert.equal(posture.contracts.variables, "justified-gradients-not-modes");
  assert.equal(posture.authority, "productDefault");
  assert.ok(posture.profile.variableDefinitions.contextReach.justification);
  assert.equal(posture.profile.variableDefinitions.contextReach.kind, "gradient");
});

test("operator profile wins over project and agent posture variables", () => {
  const posture = resolvePostureProfile({
    version: "6.0.0.0-alpha",
    agentProfile: { variables: { contextReach: 0.2, delegationDiscretion: 0.2 } },
    projectPolicy: { variables: { contextReach: 0.4, delegationDiscretion: 0.4 } },
    operatorProfile: { variables: { contextReach: 0.93, delegationDiscretion: 0.88 } },
  });
  assert.equal(posture.authority, "operatorProfile");
  assert.equal(posture.profile.variables.contextReach, 0.93);
  assert.equal(posture.profile.variables.delegationDiscretion, 0.88);
});

test("same version can resolve into different gradients by operator discretion", () => {
  const settled = resolvePostureProfile({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { proposalNovelty: 0.1, settlementWeight: 0.9 } },
  });
  const divergent = resolvePostureProfile({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { proposalNovelty: 0.9, settlementWeight: 0.1 } },
  });
  assert.equal(settled.maturity, divergent.maturity);
  assert.notEqual(settled.profile.variables.proposalNovelty, divergent.profile.variables.proposalNovelty);
  assert.notEqual(settled.profile.variables.settlementWeight, divergent.profile.variables.settlementWeight);
});

test("posture profiles carry operator-defined variables and bindings with justification", () => {
  const posture = resolvePostureProfile({
    version: "6.0.0.0-alpha",
    operatorProfile: {
      variables: { operatorTrustGradient: { value: 0.73 } },
      variableDefinitions: {
        operatorTrustGradient: {
          kind: "gradient",
          justification: "Local operator-defined confidence in the selected orchestrator for this session.",
        },
      },
      policies: { cleanupDiscipline: "fix-useful-remove-disposable" },
      actionBindings: { customCommand: "operator-owned-action" },
    },
  });
  assert.equal(posture.profile.customVariables.operatorTrustGradient, 0.73);
  assert.equal(posture.profile.variableDefinitions.operatorTrustGradient.justification, "Local operator-defined confidence in the selected orchestrator for this session.");
  assert.equal(posture.profile.policies.cleanupDiscipline, "fix-useful-remove-disposable");
  assert.equal(posture.profile.actionBindings.customCommand, "operator-owned-action");
  assert.equal(posture.contracts.phraseBinding, "operator-assignable");
});

test("posture cannot remove the competence floor", () => {
  const posture = resolvePostureProfile({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { checkpointDensity: 1 } },
  });
  assert.deepEqual(posture.profile.competenceFloor, [...COMPETENCE_FLOOR]);
  assert.ok(posture.profile.competenceFloor.includes("retain-relevant-world-and-user-context"));
  assert.ok(posture.profile.competenceFloor.includes("use-authorized-tools-and-context-surfaces"));
});

test("env snapshot parses profile JSON and reports invalid JSON without leaking raw values", () => {
  const snap = postureProfileSnapshot({
    env: {
      ILLUCI_VERSION: "6.0.0.0-alpha",
      ILLUCI_POSTURE_PROFILE: JSON.stringify({ variables: { contextReach: 0.61 } }),
      ILLUCI_PROJECT_POSTURE_POLICY: "{bad json",
    },
  });
  assert.equal(snap.profile.variables.contextReach, 0.61);
  assert.ok(JSON.stringify(snap).includes("profile-json-invalid"));
  assert.equal(JSON.stringify(snap).includes("{bad json"), false);
  assert.equal(parseProfileJson("", "empty"), null);
});
