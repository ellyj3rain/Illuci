import test from "node:test";
import assert from "node:assert/strict";

import { TOPOLOGIES, compileGraph } from "./index.js";

const CANONICAL_TOPOLOGY_IDS = Object.freeze([
  "adversarial-debate",
  "apprentice-master",
  "censorate",
  "classroom",
  "co-operative",
  "colosseum",
  "commune",
  "conclave",
  "corporate-hierarchy",
  "cult",
  "darwinian",
  "deadlock",
  "delphi-panel",
  "dev-team",
  "devops-pipeline",
  "direct",
  "honeypot",
  "incident-command",
  "judiciary",
  "kgotla",
  "legislature",
  "market-auction",
  "mob-sit-down",
  "panopticon",
  "peer-review-ring",
  "perception-council",
  "research-swarm",
  "sanhedrin",
  "scenario-simulation",
  "thing",
  "tournament-bracket",
  "triage-funnel",
  "turing-test",
  "war-room",
]);

test("canonical topology IDs are a public contract", () => {
  assert.deepEqual(Object.keys(TOPOLOGIES).sort(), CANONICAL_TOPOLOGY_IDS);
  assert.equal(TOPOLOGIES["devops-pipeline"].id, "devops-pipeline");
  assert.equal(TOPOLOGIES["devops-pipeline"].name, "DevOps Pipeline");
  assert.equal(TOPOLOGIES["release-gate-chain"], undefined);
});

test("devops-pipeline seat and raw relationship semantics are stable", () => {
  const topology = TOPOLOGIES["devops-pipeline"];
  assert.deepEqual(topology.seats.map((seat) => seat.id), [
    "build",
    "test",
    "security",
    "staging",
    "deploy",
    "monitor",
  ]);

  const rawSemantics = topology.seats
    .flatMap((seat) => seat.relationships ?? [])
    .filter((relationship) => relationship.type === "precedes")
    .map((relationship) => relationship.semantics);

  assert.deepEqual(rawSemantics, [
    "pipeline-flow",
    "pipeline-flow",
    "pipeline-flow",
    "pipeline-flow",
    "pipeline-flow",
    "pipeline-flow",
  ]);

  const graph = compileGraph("devops-pipeline");
  for (const edge of graph.edges.filter((candidate) => candidate.semantics === "pipeline-flow")) {
    assert.equal(edge.semanticProfile.raw, "pipeline-flow");
    assert.equal(edge.semanticProfile.canonicalTag, "pipeline-flow");
    assert.equal(edge.semanticProfile.family, "ordered-handoff");
  }
});
