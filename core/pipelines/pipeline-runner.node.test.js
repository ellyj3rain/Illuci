import { test } from "node:test";
import assert from "node:assert/strict";

import { runPipeline } from "./pipeline-runner.js";

function makeTrace(node) {
  return {
    runId: "run-" + node.topologyId,
    phases: {
      final: {
        responses: [
          {
            response: node.topologyId + " output from " + node.prompt,
            seat: "seat",
            model: "model",
            usage: { total_tokens: 1 },
          },
        ],
      },
    },
    totalLatency: 1,
    budget: { spent: 1 },
    halted: false,
  };
}

function makeEmptyTrace(response = "") {
  return {
    runId: "run-empty",
    phases: {
      final: {
        responses: [
          {
            response,
            seat: "seat",
            model: "model",
            usage: { total_tokens: 0 },
          },
        ],
      },
    },
    totalLatency: 1,
    budget: { spent: 0 },
    halted: false,
  };
}

test("instrumented pipeline runner executes stages through runNode", async () => {
  const calls = [];
  const pipeline = await runPipeline({
    type: "standard",
    prompt: "build the thing",
    lineup: { architect: "model-a" },
    options: {
      _runNode: async (node, ctx) => {
        calls.push({ node, ctx });
        return makeTrace(node);
      },
    },
  });

  assert.equal(pipeline.status, "completed");
  assert.deepEqual(calls.map((call) => call.node.kind), ["topology", "topology", "topology"]);
  assert.deepEqual(calls.map((call) => call.node.topologyId), ["research-swarm", "dev-team", "adversarial-debate"]);
  assert.deepEqual(calls.map((call) => call.node.lineup), [
    { architect: "model-a" },
    { architect: "model-a" },
    { architect: "model-a" },
  ]);
  assert.match(calls[0].ctx.busScope, /^pipe-[^-]+-[a-z0-9]+:stage:0$/);
  assert.match(calls[1].ctx.busScope, /^pipe-[^-]+-[a-z0-9]+:stage:1$/);
  assert.notEqual(calls[0].ctx.busScope, calls[1].ctx.busScope);
  assert.equal(calls[0].ctx.mandate.intent.raw, "build the thing");
  assert.equal(calls[1].ctx.mandate, calls[0].ctx.mandate);
  assert.equal(calls[2].ctx.mandate, calls[0].ctx.mandate);
  assert.match(calls[1].node.prompt, /research-swarm output from build the thing/);
  assert.equal(calls[1].ctx.mandate.intent.raw, "build the thing");
});

test("pipeline runner maps stable agents onto different stage seats", async () => {
  const calls = [];
  const pipeline = await runPipeline({
    type: "standard",
    prompt: "carry one agent through the pipeline",
    options: {
      agents: {
        agents: {
          mousecat: { agentSlug: "mousecat", modelResource: "claude-local" },
        },
      },
      stageMap: {
        0: { seats: { investigator: "mousecat" } },
        1: { seats: { implementer: "mousecat" } },
      },
      _runNode: async (node, ctx) => {
        calls.push({ node, ctx });
        return makeTrace(node);
      },
    },
  });

  assert.equal(pipeline.status, "completed");
  assert.equal(calls[0].node.options.seatAgents.investigator, "mousecat");
  assert.equal(calls[1].node.options.seatAgents.implementer, "mousecat");
  assert.equal(calls[0].node.options.agents.agents.mousecat.agentSlug, "mousecat");
  assert.equal(calls[1].node.options.agents.agents.mousecat.agentSlug, "mousecat");
});

test("pipeline runner forwards run-control to every compiled stage node", async () => {
  const calls = [];
  const pipeline = await runPipeline({
    type: "standard",
    prompt: "plan without mutation",
    options: {
      runControl: { execution: { mutationAuthority: "blocked" } },
      _runNode: async (node, ctx) => {
        calls.push({ node, ctx });
        return makeTrace(node);
      },
    },
  });

  assert.equal(pipeline.status, "completed");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].node.options.runControl.execution.mutationAuthority, "blocked");
  assert.equal(calls[1].node.options.runControl.execution.mutationAuthority, "blocked");
  assert.equal(calls[2].node.options.runControl.execution.mutationAuthority, "blocked");
});

test("instrumented pipeline runner fails a stage with no material handoff output", async () => {
  const pipeline = await runPipeline({
    type: "standard",
    prompt: "build the thing",
    options: {
      _runNode: async () => makeEmptyTrace("   "),
    },
  });

  assert.equal(pipeline.status, "failed");
  assert.equal(pipeline.stages[0].status, "failed");
  assert.equal(pipeline.stages[0].error.code, "PIPELINE_STAGE_EMPTY_OUTPUT");
  assert.equal(pipeline.error.stageId, pipeline.stages[0].stageId);
});

test("instrumented pipeline runner includes response errors when a stage produces no handoff", async () => {
  const pipeline = await runPipeline({
    type: "standard",
    prompt: "build the thing",
    options: {
      _runNode: async () => ({
        runId: "run-error",
        phases: {
          final: {
            responses: [
              {
                error: "bridge failed",
                seat: "seat",
                model: "model",
              },
            ],
          },
        },
        totalLatency: 1,
        budget: { spent: 0 },
        halted: false,
      }),
    },
  });

  assert.equal(pipeline.status, "failed");
  assert.equal(pipeline.stages[0].error.code, "PIPELINE_STAGE_EMPTY_OUTPUT");
  assert.match(pipeline.stages[0].error.message, /bridge failed/);
});
