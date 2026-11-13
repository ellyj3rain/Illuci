import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bindResolvedModelsToAgents,
  publicAgentAssignments,
  resolveAgentLineup,
  resolveStageAgentOptions,
} from "./assignment.js";

test("agent manifest seats repeated topology seats with public assignment metadata", () => {
  const manifest = {
    agents: {
      researcher_a: {
        agentSlug: "researcher-a",
        modelResource: "deepseek",
        role: "investigator",
        skills: ["source-triage"],
        public: { displayName: "Researcher A", color: "#44aa99" },
      },
      researcher_b: {
        agentSlug: "researcher-b",
        modelResource: "glm",
        role: "investigator",
        public: { displayName: "Researcher B" },
      },
    },
    seats: {
      "research-swarm": {
        investigator: ["researcher_a", "researcher_b"],
      },
    },
  };

  const resolved = resolveAgentLineup({ topologyId: "research-swarm", lineup: {}, agentManifest: manifest });
  assert.deepEqual(resolved.lineup.investigator, ["deepseek", "glm"]);

  const seatAgents = bindResolvedModelsToAgents(resolved.lineup, resolved.seatAgents);
  assert.deepEqual(
    publicAgentAssignments(seatAgents).investigator.map((agent) => ({
      id: agent.agentId,
      slug: agent.agentSlug,
      model: agent.model,
      color: agent.public.color || null,
    })),
    [
      { id: "researcher_a", slug: "researcher-a", model: "deepseek", color: "#44aa99" },
      { id: "researcher_b", slug: "researcher-b", model: "glm", color: null },
    ],
  );
});

test("explicit lineup model override preserves agent identity binding", () => {
  const manifest = {
    agents: {
      builder: { agentSlug: "stable-builder", modelResource: "qwen-code" },
    },
    seats: { implementer: "builder" },
  };

  const resolved = resolveAgentLineup({
    topologyId: "dev-team",
    lineup: { implementer: "codex-local" },
    agentManifest: manifest,
  });
  const seatAgents = bindResolvedModelsToAgents(resolved.lineup, resolved.seatAgents);

  assert.equal(resolved.lineup.implementer, "codex-local");
  assert.equal(seatAgents.implementer[0].agentId, "builder");
  assert.equal(seatAgents.implementer[0].agentSlug, "stable-builder");
  assert.equal(seatAgents.implementer[0].model, "codex-local");
});

test("stage maps carry the same agent manifest across pipeline stages", () => {
  const agents = {
    agents: {
      mousecat: { agentSlug: "mousecat", modelResource: "claude-local" },
    },
  };
  const stageMap = {
    0: { seats: { investigator: "mousecat" } },
    1: { seats: { implementer: "mousecat" } },
  };

  const research = resolveStageAgentOptions({
    agents,
    stageMap,
    stageDef: { topologyId: "research-swarm" },
    stageIndex: 0,
  });
  const build = resolveStageAgentOptions({
    agents,
    stageMap,
    stageDef: { topologyId: "devops-pipeline" },
    stageIndex: 1,
  });

  assert.equal(research.seatAgents.investigator, "mousecat");
  assert.equal(build.seatAgents.implementer, "mousecat");
  assert.equal(research.agents.agents.mousecat.agentSlug, "mousecat");
  assert.equal(build.agents.agents.mousecat.agentSlug, "mousecat");
});
