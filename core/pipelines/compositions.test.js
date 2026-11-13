import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPipelinePlan,
  compilePipelineNode,
  compilePipelineStageNode,
  listPipelineCompositions,
  resolvePipelineComposition,
} from "./compositions.js";

test("resolves named pipeline compositions from one registry", () => {
  assert.equal(resolvePipelineComposition("standard")?.id, "standard");
  assert.equal(resolvePipelineComposition("governed-dev")?.id, "governed-dev");
  assert.equal(resolvePipelineComposition("total-axes")?.id, "total-axes");
  assert.equal(resolvePipelineComposition("not-real"), null);
});

test("lists registry compositions including total-axes", () => {
  const ids = listPipelineCompositions().map((composition) => composition.id);

  assert.ok(ids.includes("standard"));
  assert.ok(ids.includes("governed-dev"));
  assert.ok(ids.includes("total-axes"));
});

test("builds a pipeline plan without inventing topology identity", () => {
  const plan = buildPipelinePlan({ type: "standard", lineup: { architect: "model-a" } });

  assert.equal(plan.composition.id, "standard");
  assert.deepEqual(plan.stages.map((stage) => stage.topologyId), ["research-swarm", "dev-team", "adversarial-debate"]);
  assert.deepEqual(plan.stages.map((stage) => stage.sequence), [0, 1, 2]);
});

test("compiles stages into runNode topology leaves", () => {
  const node = compilePipelineStageNode(
    { topologyId: "dev-team", label: "Build" },
    { lineup: { implementer: "model-a" }, prompt: "do it", options: { reasoning: "high" } },
  );

  assert.equal(node.kind, "topology");
  assert.equal(node.topologyId, "dev-team");
  assert.equal(node.prompt, "do it");
  assert.deepEqual(node.lineup, { implementer: "model-a" });
  assert.equal(node.options.reasoning, "high");
});

test("compiles a named composition into a unified pipeline node", () => {
  const node = compilePipelineNode({
    type: "governed-dev",
    prompt: "ship it",
    options: { runControl: { execution: { mutationAuthority: "blocked" } } },
  });

  assert.equal(node.kind, "pipeline");
  assert.equal(node.id, "governed-dev");
  assert.deepEqual(node.stages.map((stage) => stage.kind), ["topology", "topology", "topology"]);
  assert.deepEqual(node.stages.map((stage) => stage.topologyId), ["dev-team", "judiciary", "mob-sit-down"]);
  assert.equal(node.stages[0].options.runControl.execution.mutationAuthority, "blocked");
});
