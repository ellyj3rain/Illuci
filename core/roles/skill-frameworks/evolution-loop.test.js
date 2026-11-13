import test from "node:test";
import assert from "node:assert/strict";

import { listTopologies } from "../../topologies/index.js";
import {
  EVOLVING_SKILL_FRAMEWORK_ID,
  HEAD_ORCHESTRATORS,
  runEvolutionLoopCampaign,
  runTopologyEvolutionLoop,
} from "./evolution-loop.js";

test("Illuci and ReviewCoordinator are declared as non-seated orchestrator layers", () => {
  assert.deepEqual(HEAD_ORCHESTRATORS.map((agent) => agent.id), ["illuci", "review-coordinator"]);
  assert.equal(HEAD_ORCHESTRATORS[0].layer, "head-orchestrator");
  assert.equal(HEAD_ORCHESTRATORS[1].layer, "optional-secondary-sub-orchestrator");
  assert.ok(HEAD_ORCHESTRATORS.every((agent) => agent.seated === false));
});

test("recursive evolution loop links Illuci/ReviewCoordinator head passes across topology rounds", () => {
  const result = runTopologyEvolutionLoop("dev-team", { rounds: 3 });

  assert.equal(result.topologyId, "dev-team");
  assert.equal(result.rounds.length, 3);
  assert.equal(result.failures.length, 0);

  for (const round of result.rounds) {
    assert.equal(round.request.frameworkId, EVOLVING_SKILL_FRAMEWORK_ID);
    assert.equal(round.headLoop.postTopology.illuciDecision.type, "illuci.evolution_decision");
    assert.equal(round.headLoop.postTopology.reviewCoordinatorChallenge.type, "review-coordinator.challenge");
    assert.equal(round.headLoop.postTopology.reviewCoordinatorChallenge.passed, true);
    assert.equal(round.metrics.allSeatsCovered, true);
    assert.equal(round.metrics.enabledPersistentControlCount, 0);
    assert.equal(round.candidates.length, result.seatIds.length);
  }

  assert.ok(result.rounds[1].candidates.every((candidate) => candidate.parentCandidateIds.length === 1));
  assert.ok(result.rounds[2].candidates.every((candidate) => candidate.parentCandidateIds.length === 1));
});

test("evolving skill framework structural dogfood covers every canonical topology seat recursively", () => {
  const topologyIds = listTopologies();
  const campaign = runEvolutionLoopCampaign({ rounds: 2 });

  assert.equal(campaign.kind, "illuci.evolving-skill-frameworks.structural-dogfood");
  assert.equal(campaign.frameworkId, EVOLVING_SKILL_FRAMEWORK_ID);
  assert.equal(campaign.topologyCount, topologyIds.length);
  assert.equal(campaign.topologyCount, 34);
  assert.equal(campaign.passed, true);
  assert.deepEqual(campaign.failures, []);
  assert.ok(campaign.totalSeats > 0);
  assert.equal(campaign.totalCandidates, campaign.totalSeats * 2);

  for (const run of campaign.runs) {
    assert.equal(run.rounds.length, 2);
    assert.ok(!run.seatIds.includes("illuci"));
    assert.ok(!run.seatIds.includes("review-coordinator"));
    for (const round of run.rounds) {
      assert.equal(round.metrics.allSeatsCovered, true);
      assert.equal(round.metrics.enabledPersistentControlCount, 0);
      assert.equal(round.candidates.length, run.seatIds.length);
      assert.equal(round.headLoop.postTopology.reviewCoordinatorChallenge.headSeatIds.length, 0);
    }
  }
});
