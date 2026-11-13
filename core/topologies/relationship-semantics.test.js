import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRelationshipSemantics,
  compileGraph,
} from "./index.js";

test("relationship semantic classifier preserves raw freeform tags", () => {
  const profile = classifyRelationshipSemantics("operator-invented-signal", { edgeType: "peer-of" });

  assert.equal(profile.raw, "operator-invented-signal");
  assert.equal(profile.normalizedTag, "operator-invented-signal");
  assert.equal(profile.canonicalTag, "operator-invented-signal");
  assert.equal(profile.known, false);
  assert.equal(profile.family, "freeform-emergent");
  assert.equal(profile.dataStatus, "freeform-observed");
  assert.equal(profile.edgeType, "peer-of");
});

test("compiled graph keeps raw semantics and adds derived telemetry profile", () => {
  const graph = compileGraph("devops-pipeline");
  const edge = graph.edges.find((candidate) => candidate.semantics === "pipeline-flow");

  assert.ok(edge, "devops-pipeline keeps the observed pipeline-flow semantic tag");
  assert.equal(edge.semanticProfile.raw, "pipeline-flow");
  assert.equal(edge.semanticProfile.canonicalTag, "pipeline-flow");
  assert.equal(edge.semanticProfile.known, true);
  assert.equal(edge.semanticProfile.family, "ordered-handoff");
  assert.equal(edge.semanticProfile.edgeType, "precedes");
});

test("semantic aliases classify without overwriting observations", () => {
  const profile = classifyRelationshipSemantics("stage handoff", { edgeType: "precedes" });

  assert.equal(profile.raw, "stage handoff");
  assert.equal(profile.normalizedTag, "stage-handoff");
  assert.equal(profile.canonicalTag, "pipeline-flow");
  assert.equal(profile.aliasOf, "pipeline-flow");
  assert.equal(profile.family, "ordered-handoff");
});
