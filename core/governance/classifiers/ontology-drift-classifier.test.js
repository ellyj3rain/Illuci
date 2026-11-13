import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyOntologyDrift } from "./ontology-drift-classifier.js";

test("ontology drift classifier flags fresh retired active API terms", () => {
  const verdict = classifyOntologyDrift({
    path: "core/topologies/runner.js",
    oldContent: "const options = {};\n",
    newContent: "const options = {};\nconst active = options.seatPersonalities;\n",
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.requiresOperator, true);
  assert.equal(verdict.signals[0].data.term, "seatPersonalities");
  assert.equal(verdict.signals[0].data.canonical, "seatDispositions");
});

test("ontology drift classifier routes old cast command additions", () => {
  const verdict = classifyOntologyDrift({
    path: "cli/illuci.mjs",
    oldContent: "switch (verb) {}\n",
    newContent: "switch (verb) {}\nasync function cmdCast(rest) { return rest; }\n",
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.signals[0].data.term, "cmdCast");
});

test("ontology drift classifier flags retired module names and profile keys", () => {
  const moduleVerdict = classifyOntologyDrift({
    path: "core/agents/agent-core.js",
    oldContent: "",
    newContent: 'import { listPresets } from "./personality-presets.js";\n',
  });
  const profileVerdict = classifyOntologyDrift({
    path: "core/roles/specialists/profiles/example.md",
    oldContent: "",
    newContent: "---\nslug: example\npersonality: analyst\n---\n",
  });

  assert.equal(moduleVerdict.allowed, false);
  assert.equal(moduleVerdict.signals[0].data.term, "personality-presets");
  assert.equal(profileVerdict.allowed, false);
  assert.equal(profileVerdict.signals[0].data.term, "personality:");
});

test("ontology drift classifier flags active persona composition vocabulary", () => {
  const verdict = classifyOntologyDrift({
    path: "core/agents/composition.js",
    oldContent: "",
    newContent: "export function composePersona() { return `[Persona: Critic]`; }\n",
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.signals[0].data.term, "composePersona");
  assert.equal(verdict.signals.some((signal) => signal.data.term === "[Persona:"), true);
});

test("ontology drift classifier allows explicit retirement context", () => {
  const verdict = classifyOntologyDrift({
    path: "core/composition/seat-disposition-config.test.js",
    oldContent: "",
    newContent: 'test("retired key rejection", () => ({ personalityTypeId: "analyst" }));\n',
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, "clear");
});

test("ontology drift classifier allows named retired-key declaration tables", () => {
  const verdict = classifyOntologyDrift({
    path: "core/composition/seat-disposition-config.js",
    oldContent: "",
    newContent: 'const RETIRED_DISPOSITION_KEYS = Object.freeze([\n  "personalityTypeId",\n  "pathologicalProfiles",\n]);\n',
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, "clear");
});

test("ontology drift classifier allows active dimensional profile vocabulary", () => {
  const verdict = classifyOntologyDrift({
    path: "core/composition/disposition-resolver.js",
    oldContent: "",
    newContent: "const summary = { activeDarkTriad: activations.darkTriad.length, enneagramCore: activations.enneagram };\n",
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, "clear");
});

test("ontology drift classifier ignores append-only ledgers but flags cast source resurrection", () => {
  const ledger = classifyOntologyDrift({
    path: "BATCH_LOG.md",
    oldContent: "",
    newContent: "- Historical note: seatPersonalities existed here.\n",
  });
  const source = classifyOntologyDrift({
    path: "core/cast/personae.js",
    oldContent: "",
    newContent: "export const cmdCast = null;\n",
  });

  assert.equal(ledger.allowed, true);
  assert.equal(ledger.code, "out-of-scope");
  assert.equal(source.allowed, false);
  assert.equal(source.signals[0].data.term, "core/cast/");
});

test("ontology drift classifier allows deletion of retired paths", () => {
  const verdict = classifyOntologyDrift({
    path: "core/cast/personae.js",
    oldContent: "export const personae = [];\n",
    newContent: "",
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, "clear");
});
