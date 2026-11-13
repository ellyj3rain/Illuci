/**
 * Topology curation manifest.
 *
 * Canonical topology IDs are public API and historical data keys. Curation does
 * not delete them; it records why each topology remains divergent, how it should
 * be presented, and where overlap should be negotiated later.
 */

import { TOPOLOGIES } from "./index.js";

const BASE = Object.freeze({
  status: "stable",
  visibility: "default",
  aliases: [],
  overlapNotes: [],
  retirementCandidate: false,
});

function c(family, divergence, extra = {}) {
  return Object.freeze({ ...BASE, family, divergence, ...extra });
}

export const TOPOLOGY_CURATION = Object.freeze({
  direct: c("direct", "Passthrough harness surface with no structural mediation."),
  "adversarial-debate": c("adversarial", "Two-sided attack/defense with an arbiter ruling."),
  "corporate-hierarchy": c("hierarchy", "Executive hub delegates to direct reports and synthesizes upward."),
  legislature: c("deliberation", "Proposal, amendment, vote, and clerk tally with factional peer dynamics."),
  judiciary: c("adjudication", "Formal adversarial case with prosecutor, defender, witness, and judge."),
  "dev-team": c("engineering", "Design, implementation, review, and QA as distinct engineering seats."),
  "devops-pipeline": c("ordered-handoff", "Gate-oriented operational handoff with build/test/security/stage/deploy/monitor.", {
    aliases: ["devops"],
    overlapNotes: ["The topology name includes pipeline, but pipeline is a separate process layer."],
    status: "curation-needed",
  }),
  "delphi-panel": c("estimation", "Anonymous blind estimation followed by convergence."),
  "research-swarm": c("research", "Dispatcher decomposes questions, investigators fan out, integrator merges."),
  "triage-funnel": c("filtering", "Progressive broad-to-narrow scoring and elimination."),
  "tournament-bracket": c("competition", "Pairwise candidate competition through tournament rounds."),
  "peer-review-ring": c("refinement", "Round-robin improvement where peers compound the prior output."),
  "war-room": c("collaboration", "Shared-state artifact construction with rotating facilitation."),
  "incident-command": c("operations", "Crisis-response hierarchy with commander, operations, safety, communications, and scribe."),
  "scenario-simulation": c("simulation", "Branching future exploration across best, worst, and likely cases."),
  "apprentice-master": c("mentorship", "Expert model teaches and corrects a cheaper or apprentice model."),
  "market-auction": c("allocation", "Models bid for work and a broker assigns by confidence/risk."),
  "co-operative": c("consensus", "Flat consensus collective without hierarchy or vote-first structure."),
  commune: c("consensus", "Organic consensus and social-cohesion dynamics.", {
    overlapNotes: ["Overlaps with co-operative but preserves looser social dynamics."],
  }),
  cult: c("charismatic-hierarchy", "Leader/follower/dissenter structure for charisma and dissent dynamics.", {
    status: "experimental",
    visibility: "advanced",
  }),
  classroom: c("pedagogy", "Professor/student/TA learning topology with peer study synthesis."),
  "mob-sit-down": c("accountability", "High-drama accountability review with asymmetric removal semantics.", {
    visibility: "advanced",
  }),
  "perception-council": c("self-modeling", "Mutual perception and self-assessment data capture."),
  darwinian: c("evolution", "Fitness scoring, mutation, reproduction, and culling across generations."),
  colosseum: c("competition", "Elimination arena with context absorption by survivors.", {
    overlapNotes: ["Overlaps with tournament-bracket but carries elimination/context-absorption semantics."],
  }),
  sanhedrin: c("adjudication", "Supermajority court with anti-bias voting and unanimous-conviction inversion.", {
    visibility: "advanced",
  }),
  censorate: c("oversight", "Independent censors accuse; authority judges; frivolous accusations carry risk."),
  thing: c("assembly", "Precedent recital and acclamation-based assembly decision."),
  conclave: c("sealed-deliberation", "Isolation and repeated ballots force convergence."),
  kgotla: c("consensus", "Chief-facilitated open floor where consensus, not vote, decides."),
  "turing-test": c("sandbox-behavior", "Blind output attribution and adversarial identity detection.", {
    status: "sandbox",
    visibility: "sandbox",
  }),
  panopticon: c("sandbox-behavior", "Observer/worker/auditor structure for surveillance-pressure behavior.", {
    status: "sandbox",
    visibility: "sandbox",
  }),
  honeypot: c("sandbox-behavior", "Behavioral classification around report/exploit/ignore choices.", {
    status: "sandbox",
    visibility: "sandbox",
  }),
  deadlock: c("sandbox-behavior", "Impossible conflicting objectives measure negotiation and honesty.", {
    status: "sandbox",
    visibility: "sandbox",
  }),
});

export function getTopologyCuration(id) {
  return TOPOLOGY_CURATION[id] || c("uncurated", "No curation record exists yet.", {
    status: "uncurated",
    visibility: "advanced",
    retirementCandidate: true,
  });
}

export function listCuratedTopologies(options = {}) {
  const includeAdvanced = Boolean(options.includeAdvanced);
  const includeSandbox = Boolean(options.includeSandbox);
  return Object.values(TOPOLOGIES)
    .map((topology) => ({ ...topology, curation: getTopologyCuration(topology.id) }))
    .filter((topology) => includeAdvanced || topology.curation.visibility !== "advanced")
    .filter((topology) => includeSandbox || topology.curation.visibility !== "sandbox");
}

export function assertTopologyCurationComplete() {
  const missing = Object.keys(TOPOLOGIES).filter((id) => !TOPOLOGY_CURATION[id]);
  return { complete: missing.length === 0, missing };
}

export default {
  TOPOLOGY_CURATION,
  getTopologyCuration,
  listCuratedTopologies,
  assertTopologyCurationComplete,
};
