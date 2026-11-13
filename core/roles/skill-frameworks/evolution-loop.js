/**
 * Structural dogfood for Illuci's evolving skill-framework loop.
 *
 * This is intentionally deterministic: it proves that the Illuci/ReviewCoordinator head loop
 * and topology-seat propagation are wired through the graph-native skill
 * framework resolver before any live model/provider campaign is allowed to
 * claim behavioral evidence.
 */

import { listTopologies, TOPOLOGIES } from "../../topologies/index.js";
import { resolveSkillFrameworkBlocksForTopology } from "./frame.js";

export const EVOLVING_SKILL_FRAMEWORK_ID = "evolving-skill-frameworks";

export const HEAD_ORCHESTRATORS = Object.freeze([
  {
    id: "illuci",
    label: "Illuci",
    layer: "head-orchestrator",
    seated: false,
  },
  {
    id: "review-coordinator",
    label: "ReviewCoordinator",
    layer: "optional-secondary-sub-orchestrator",
    seated: false,
    optional: true,
  },
]);

const ROUND_ONE_SKILLS = Object.freeze([
  "evolution.self-reflection-checkpoint",
  "evolution.trace-driven-skill-evolution",
  "evolution.review-coordinator-alignment-challenge",
  "evolution.semantic-preservation-gate",
  "evolution.evolution-backpressure",
]);

const ROUND_TWO_PLUS_SKILLS = Object.freeze([
  "evolution.self-reflection-checkpoint",
  "evolution.experience-library-curation",
  "evolution.trace-driven-skill-evolution",
  "evolution.pareto-framework-selection",
  "evolution.review-coordinator-alignment-challenge",
  "evolution.semantic-preservation-gate",
  "evolution.runtime-overlay-incubation",
  "evolution.evolution-backpressure",
]);

const PERSISTENT_ACTION_RE = /(stage|activate|promote|write|mutate)$/i;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function topologyFor(topologyId) {
  const topology = TOPOLOGIES[topologyId];
  if (!topology) throw new Error(`unknown topology: ${topologyId}`);
  return topology;
}

function seatIdsFor(topology) {
  return (topology.seats || []).map((seat) => seat.id);
}

function frameworkRequestForRound(round) {
  return {
    frameworkId: EVOLVING_SKILL_FRAMEWORK_ID,
    skillRefs: round <= 1 ? [...ROUND_ONE_SKILLS] : [...ROUND_TWO_PLUS_SKILLS],
  };
}

function persistentControlsForUse(use) {
  return (use?.resolved?.permissionControls || [])
    .filter((control) => {
      const action = String(control.actionRef || "");
      const boundaryRefs = control.boundaryRefs || [];
      return PERSISTENT_ACTION_RE.test(action)
        || boundaryRefs.includes("evolution-stage")
        || boundaryRefs.includes("evolution-promote");
    })
    .map((control) => ({
      actionRef: control.actionRef,
      enabled: control.enabled === true,
      requiresExplicitGrant: control.requiresExplicitGrant === true,
      boundaryRefs: [...(control.boundaryRefs || [])],
    }));
}

function summarizeSeatUse({ topologyId, seat, uses, round, previousCandidateIds }) {
  const selectedSkillRefs = unique(uses.flatMap((use) => use?.resolved?.selectedSkillRefs || []));
  const enabledActionRefs = unique(uses.flatMap((use) => use?.resolved?.enabledActionRefs || []));
  const enabledToolChannels = unique(uses.flatMap((use) => use?.resolved?.enabledToolChannels || []));
  const persistentControls = uses.flatMap(persistentControlsForUse);
  const enabledPersistentControls = persistentControls.filter((control) => control.enabled);
  const parentCandidateIds = previousCandidateIds.filter((id) => id.includes(`/${seat.id}/`));

  return {
    topologyId,
    seatId: seat.id,
    roleHint: seat.roleHint || null,
    round,
    frameworkResolved: uses.some((use) => use?.resolved?.frameworkId === EVOLVING_SKILL_FRAMEWORK_ID),
    selectedSkillRefs,
    enabledActionRefs,
    enabledToolChannels,
    persistentControls,
    enabledPersistentControls,
    candidate: {
      id: `${topologyId}/${seat.id}/round-${round}`,
      type: "seat.improvement_candidate",
      parentCandidateIds,
      targetSurface: "skill-framework",
      evidence: {
        frameworkId: EVOLVING_SKILL_FRAMEWORK_ID,
        selectedSkillRefs,
        enabledActionRefs,
        enabledToolChannels,
      },
      mutationAllowed: enabledPersistentControls.length > 0,
    },
  };
}

function headLoopForRound({
  topologyId,
  topology,
  round,
  request,
  priorCandidateIds,
  seatRecords,
}) {
  const producedCandidateIds = seatRecords.map((record) => record.candidate.id);
  const enabledPersistentControls = seatRecords.flatMap((record) => record.enabledPersistentControls);
  const allSeatsCovered = seatRecords.every((record) => record.frameworkResolved);
  const headSeatIds = HEAD_ORCHESTRATORS
    .filter((agent) => seatIdsFor(topology).includes(agent.id))
    .map((agent) => agent.id);

  const illuciDecision = {
    type: "illuci.evolution_decision",
    actor: "Illuci",
    layer: "head-orchestrator",
    round,
    inputCandidateIds: priorCandidateIds,
    selectedFrameworkId: request.frameworkId,
    selectedSkillRefs: request.skillRefs,
    outputCandidateIds: producedCandidateIds,
    targetSurface: round <= 1 ? "recursive topology evidence" : "evolved skill-framework candidate",
  };

  const reviewCoordinatorChallenge = {
    type: "review-coordinator.challenge",
    actor: "ReviewCoordinator",
    layer: "optional-secondary-sub-orchestrator",
    round,
    checks: [
      "head agents are not topology seats",
      "all topology seats received the evolving framework",
      "persistent mutation controls remain disabled",
      "candidate deltas carry evidence and parentage",
    ],
    passed: headSeatIds.length === 0 && allSeatsCovered && enabledPersistentControls.length === 0,
    headSeatIds,
    allSeatsCovered,
    enabledPersistentControls,
  };

  return {
    preTopology: {
      type: "head.loop.plan",
      actors: HEAD_ORCHESTRATORS,
      topologyId,
      topologyName: topology.name,
      round,
      request,
    },
    postTopology: {
      illuciDecision,
      reviewCoordinatorChallenge,
    },
  };
}

function failuresForRound({ topologyId, round, seatRecords, headLoop, priorCandidateIds }) {
  const failures = [];
  const missingFramework = seatRecords.filter((record) => !record.frameworkResolved);
  if (missingFramework.length > 0) {
    failures.push({
      topologyId,
      round,
      kind: "missing-framework-seat-coverage",
      seats: missingFramework.map((record) => record.seatId),
    });
  }

  const enabledPersistent = seatRecords.flatMap((record) =>
    record.enabledPersistentControls.map((control) => ({ seatId: record.seatId, ...control })));
  if (enabledPersistent.length > 0) {
    failures.push({
      topologyId,
      round,
      kind: "persistent-mutation-enabled",
      controls: enabledPersistent,
    });
  }

  if (!headLoop.postTopology.reviewCoordinatorChallenge.passed) {
    failures.push({
      topologyId,
      round,
      kind: "review-coordinator-challenge-failed",
      challenge: headLoop.postTopology.reviewCoordinatorChallenge,
    });
  }

  if (round > 1 && priorCandidateIds.length > 0) {
    const unparented = seatRecords.filter((record) => record.candidate.parentCandidateIds.length === 0);
    if (unparented.length > 0) {
      failures.push({
        topologyId,
        round,
        kind: "recursive-parentage-missing",
        seats: unparented.map((record) => record.seatId),
      });
    }
  }

  return failures;
}

export function runTopologyEvolutionLoop(topologyId, { rounds = 2 } = {}) {
  const topology = topologyFor(topologyId);
  const iterations = [];
  let priorCandidateIds = [];

  for (let round = 1; round <= rounds; round += 1) {
    const request = frameworkRequestForRound(round);
    const resolution = resolveSkillFrameworkBlocksForTopology({
      topology,
      topologyId,
      skillFrameworks: [request],
    });
    const seatRecords = (topology.seats || []).map((seat) =>
      summarizeSeatUse({
        topologyId,
        seat,
        uses: resolution.usesBySeat[seat.id] || [],
        round,
        previousCandidateIds: priorCandidateIds,
      }));
    const headLoop = headLoopForRound({
      topologyId,
      topology,
      round,
      request,
      priorCandidateIds,
      seatRecords,
    });
    const failures = failuresForRound({ topologyId, round, seatRecords, headLoop, priorCandidateIds });
    const candidates = seatRecords.map((record) => record.candidate);

    iterations.push({
      round,
      request,
      headLoop,
      seatRecords,
      candidates,
      failures,
      metrics: {
        seatCount: seatRecords.length,
        candidateCount: candidates.length,
        allSeatsCovered: seatRecords.every((record) => record.frameworkResolved),
        enabledPersistentControlCount: seatRecords.reduce((sum, record) => sum + record.enabledPersistentControls.length, 0),
      },
    });
    priorCandidateIds = candidates.map((candidate) => candidate.id);
  }

  return {
    topologyId,
    topologyName: topology.name,
    headAgents: HEAD_ORCHESTRATORS,
    seatIds: seatIdsFor(topology),
    rounds: iterations,
    failures: iterations.flatMap((round) => round.failures),
  };
}

export function runEvolutionLoopCampaign({ topologyIds = listTopologies(), rounds = 2 } = {}) {
  const runs = topologyIds.map((topologyId) => runTopologyEvolutionLoop(topologyId, { rounds }));
  const failures = runs.flatMap((run) => run.failures);
  const totalSeats = runs.reduce((sum, run) => sum + run.seatIds.length, 0);
  const totalCandidates = runs.reduce((sum, run) =>
    sum + run.rounds.reduce((roundSum, round) => roundSum + round.candidates.length, 0), 0);

  return {
    kind: "illuci.evolving-skill-frameworks.structural-dogfood",
    frameworkId: EVOLVING_SKILL_FRAMEWORK_ID,
    rounds,
    headAgents: HEAD_ORCHESTRATORS,
    topologyCount: runs.length,
    totalSeats,
    totalCandidates,
    failures,
    passed: failures.length === 0,
    runs,
  };
}

export default {
  EVOLVING_SKILL_FRAMEWORK_ID,
  HEAD_ORCHESTRATORS,
  runTopologyEvolutionLoop,
  runEvolutionLoopCampaign,
};
