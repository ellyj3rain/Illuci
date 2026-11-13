import test from "node:test";
import assert from "node:assert/strict";

import { classifyOperatorPosture } from "./posture-profile-classifier.js";

test("classifier routes version-only behavioral mandates to the operator", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    claim: { versionDeterminesBehavior: true },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.requiresOperator, true);
  assert.ok(verdict.signals.some((signal) => signal.code === "version-only-posture-mandate"));
});

test("classifier warns on false binary posture bindings", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { contextReach: 0.7 } },
    claim: { binaryModeBinding: true },
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.requiresOperator, false);
  assert.ok(verdict.signals.some((signal) => signal.code === "false-binary-posture-binding"));
});

test("classifier blocks posture claims that remove basic competence", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { checkpointDensity: 1 } },
    claim: { removesBasicCompetence: true },
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.requiresOperator, false);
  assert.ok(verdict.signals.some((signal) => signal.code === "competence-floor-removal"));
});

test("classifier warns when historical residue is kept live only because it existed", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    operatorProfile: { variables: { changeAssertiveness: 0.9 } },
    claim: { keepSurfaceBecauseHistorical: true },
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.requiresOperator, false);
  assert.ok(verdict.signals.some((signal) => signal.code === "historical-residue-kept-live"));
});

test("classifier allows explicit profile-resolved posture", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    subject: "session-default",
    operatorProfile: { variables: { contextReach: 0.7, changeAssertiveness: 0.85 } },
    claim: {},
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.requiresOperator, false);
  assert.equal(verdict.decision, "profile-resolved");
  assert.equal(verdict.posture.authority, "operatorProfile");
});

test("irreversible posture-sensitive action needs explicit authority", () => {
  const verdict = classifyOperatorPosture({
    version: "6.0.0.0-alpha",
    claim: { irreversibleChange: true },
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.signals.some((signal) => signal.code === "irreversible-change-without-profile-authority"));
});
