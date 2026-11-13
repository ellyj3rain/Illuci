/**
 * Illuci — Topology-Derived Skills Registry
 *
 * Skills are portable capabilities derived from the structural requirements
 * of each topology. Every topology implies skills that agents need to
 * operate effectively within its structure. Skills are interchangeable
 * across topologies — an agent with "cross-examination" skill can use it
 * in judiciary, sanhedrin, or any topology that has adversarial phases.
 *
 * Skills are distinct from roles (positional assignments) and personalities
 * (behavioral dispositions). An agent = model + skills + role + disposition.
 *
 * Attribution: skill catalog concept operator-originated.
 * Topology-skill derivation: systematic extraction from 34 topology structures.
 *
 * @module core/skills/topology-skills
 */

export const TOPOLOGY_SKILLS = {

  // ═══════════════════════════════════════════
  // REASONING & ANALYSIS
  // ═══════════════════════════════════════════

  "steel-manning": {
    id: "steel-manning",
    name: "Steel-Manning",
    description: "Constructing the strongest possible version of an opposing argument before attacking it",
    category: "reasoning",
    derivedFrom: ["adversarial-debate"],
    applicableTo: ["adversarial-debate", "judiciary", "sanhedrin", "tournament-bracket"],
  },

  "evidence-chain-construction": {
    id: "evidence-chain-construction",
    name: "Evidence Chain Construction",
    description: "Building a case from facts to conclusion with no logical gaps, timestamped and provenance-stamped",
    category: "reasoning",
    derivedFrom: ["judiciary", "sanhedrin", "mob-sit-down"],
    applicableTo: ["judiciary", "sanhedrin", "censorate", "mob-sit-down", "panopticon"],
  },

  "cross-examination": {
    id: "cross-examination",
    name: "Cross-Examination",
    description: "Exposing weaknesses in testimony or output through targeted, sequential questions",
    category: "reasoning",
    derivedFrom: ["judiciary"],
    applicableTo: ["judiciary", "sanhedrin", "turing-test", "censorate"],
  },

  "independent-estimation": {
    id: "independent-estimation",
    name: "Independent Estimation",
    description: "Producing a forecast without anchoring to others' estimates or prior outputs",
    category: "reasoning",
    derivedFrom: ["delphi-panel"],
    applicableTo: ["delphi-panel", "conclave", "scenario-simulation"],
  },

  "question-decomposition": {
    id: "question-decomposition",
    name: "Question Decomposition",
    description: "Splitting a complex question into investigable sub-questions with clear scope boundaries",
    category: "reasoning",
    derivedFrom: ["research-swarm"],
    applicableTo: ["research-swarm", "incident-command", "dev-team"],
  },

  "scenario-branching": {
    id: "scenario-branching",
    name: "Scenario Branching",
    description: "Constructing plausible divergent futures from a shared set of assumptions",
    category: "reasoning",
    derivedFrom: ["scenario-simulation"],
    applicableTo: ["scenario-simulation", "darwinian", "deadlock"],
  },

  "risk-quantification": {
    id: "risk-quantification",
    name: "Risk Quantification",
    description: "Assigning probability and impact scores to scenario outcomes with explicit uncertainty",
    category: "reasoning",
    derivedFrom: ["scenario-simulation"],
    applicableTo: ["scenario-simulation", "incident-command", "devops-pipeline"],
  },

  "unanimity-detection": {
    id: "unanimity-detection",
    name: "Unanimity Detection",
    description: "Recognizing when consensus is suspiciously total — a signal of procedural failure or groupthink",
    category: "reasoning",
    derivedFrom: ["sanhedrin"],
    applicableTo: ["sanhedrin", "conclave", "legislature", "co-operative"],
  },

  "precedent-recitation": {
    id: "precedent-recitation",
    name: "Precedent Recitation",
    description: "Grounding decisions in prior rulings, established norms, and historical patterns",
    category: "reasoning",
    derivedFrom: ["thing"],
    applicableTo: ["thing", "judiciary", "sanhedrin", "legislature"],
  },

  // ═══════════════════════════════════════════
  // PRODUCTION & IMPLEMENTATION
  // ═══════════════════════════════════════════

  "architecture-decomposition": {
    id: "architecture-decomposition",
    name: "Architecture Decomposition",
    description: "Breaking a system into implementable components with clear interfaces and dependency ordering",
    category: "production",
    derivedFrom: ["dev-team"],
    applicableTo: ["dev-team", "devops-pipeline", "incident-command"],
  },

  "incremental-improvement": {
    id: "incremental-improvement",
    name: "Incremental Improvement",
    description: "Making a good artifact better without rewriting it — compounding quality through iteration",
    category: "production",
    derivedFrom: ["peer-review-ring"],
    applicableTo: ["peer-review-ring", "war-room", "classroom"],
  },

  "shared-artifact-co-construction": {
    id: "shared-artifact-co-construction",
    name: "Shared Artifact Co-Construction",
    description: "Contributing to a living document without conflicting edits or scope collision",
    category: "production",
    derivedFrom: ["war-room"],
    applicableTo: ["war-room", "co-operative", "kgotla"],
  },

  "adaptive-mutation": {
    id: "adaptive-mutation",
    name: "Adaptive Mutation",
    description: "Perturbing a working solution to explore nearby possibilities without breaking core functionality",
    category: "production",
    derivedFrom: ["darwinian"],
    applicableTo: ["darwinian", "peer-review-ring", "tournament-bracket"],
  },

  "context-absorption": {
    id: "context-absorption",
    name: "Context Absorption",
    description: "Integrating a fallen competitor's or departed agent's work product into your own output",
    category: "production",
    derivedFrom: ["colosseum"],
    applicableTo: ["colosseum", "darwinian", "market-auction"],
  },

  "bid-construction": {
    id: "bid-construction",
    name: "Bid Construction",
    description: "Formulating a proposal with approach, confidence, risk assessment, and cost estimate",
    category: "production",
    derivedFrom: ["market-auction"],
    applicableTo: ["market-auction", "legislature"],
  },

  "worked-example-construction": {
    id: "worked-example-construction",
    name: "Worked Example Construction",
    description: "Demonstrating a technique through a complete, annotated example that teaches by showing",
    category: "production",
    derivedFrom: ["apprentice-master"],
    applicableTo: ["apprentice-master", "classroom"],
  },

  "vision-amplification": {
    id: "vision-amplification",
    name: "Vision Amplification",
    description: "Extending and reinforcing a core idea with supporting detail, examples, and implications",
    category: "production",
    derivedFrom: ["cult"],
    applicableTo: ["cult", "corporate-hierarchy"],
  },

  // ═══════════════════════════════════════════
  // EVALUATION & REVIEW
  // ═══════════════════════════════════════════

  "code-review": {
    id: "code-review",
    name: "Code Review",
    description: "Identifying bugs, style violations, architectural problems, and security issues in implementation",
    category: "evaluation",
    derivedFrom: ["dev-team"],
    applicableTo: ["dev-team", "peer-review-ring", "devops-pipeline"],
  },

  "gate-evaluation": {
    id: "gate-evaluation",
    name: "Gate Evaluation",
    description: "Determining pass/fail against defined criteria with zero ambiguity — no partial passes",
    category: "evaluation",
    derivedFrom: ["devops-pipeline"],
    applicableTo: ["devops-pipeline", "triage-funnel", "conclave"],
  },

  "rapid-screening": {
    id: "rapid-screening",
    name: "Rapid Screening",
    description: "Quickly categorizing options as viable or not without deep analysis — triage speed",
    category: "evaluation",
    derivedFrom: ["triage-funnel"],
    applicableTo: ["triage-funnel", "colosseum", "darwinian"],
  },

  "pairwise-comparison": {
    id: "pairwise-comparison",
    name: "Pairwise Comparison",
    description: "Evaluating two solutions head-to-head on specific criteria to determine which is stronger",
    category: "evaluation",
    derivedFrom: ["tournament-bracket"],
    applicableTo: ["tournament-bracket", "colosseum", "darwinian"],
  },

  "fitness-evaluation": {
    id: "fitness-evaluation",
    name: "Fitness Evaluation",
    description: "Scoring solutions against multiple criteria simultaneously with weighted priorities",
    category: "evaluation",
    derivedFrom: ["darwinian"],
    applicableTo: ["darwinian", "colosseum", "triage-funnel"],
  },

  "blind-evaluation": {
    id: "blind-evaluation",
    name: "Blind Evaluation",
    description: "Judging quality without knowing the source — eliminating identity bias from assessment",
    category: "evaluation",
    derivedFrom: ["turing-test", "delphi-panel"],
    applicableTo: ["turing-test", "delphi-panel", "tournament-bracket"],
  },

  "deployment-risk-assessment": {
    id: "deployment-risk-assessment",
    name: "Deployment Risk Assessment",
    description: "Evaluating whether a change is safe to promote based on test results, scan findings, and blast radius",
    category: "evaluation",
    derivedFrom: ["devops-pipeline"],
    applicableTo: ["devops-pipeline", "incident-command"],
  },

  "constructive-critique": {
    id: "constructive-critique",
    name: "Constructive Critique",
    description: "Identifying issues while preserving the author's intent — critique that improves, not destroys",
    category: "evaluation",
    derivedFrom: ["peer-review-ring"],
    applicableTo: ["peer-review-ring", "classroom", "apprentice-master"],
  },

  "error-diagnosis": {
    id: "error-diagnosis",
    name: "Error Diagnosis",
    description: "Identifying why an attempt failed and what misconception or architectural flaw caused it",
    category: "evaluation",
    derivedFrom: ["apprentice-master"],
    applicableTo: ["apprentice-master", "dev-team", "incident-command"],
  },

  "memorial-writing": {
    id: "memorial-writing",
    name: "Memorial Writing",
    description: "Structuring a formal accusation with evidence standards — the censor's art",
    category: "evaluation",
    derivedFrom: ["censorate"],
    applicableTo: ["censorate", "judiciary", "mob-sit-down"],
  },

  // ═══════════════════════════════════════════
  // SYNTHESIS & INTEGRATION
  // ═══════════════════════════════════════════

  "upward-synthesis": {
    id: "upward-synthesis",
    name: "Upward Synthesis",
    description: "Distilling multiple reports into an executive-level summary without losing critical detail",
    category: "synthesis",
    derivedFrom: ["corporate-hierarchy"],
    applicableTo: ["corporate-hierarchy", "incident-command", "research-swarm"],
  },

  "finding-synthesis": {
    id: "finding-synthesis",
    name: "Finding Synthesis",
    description: "Merging multiple investigation threads into a coherent picture — integrator's craft",
    category: "synthesis",
    derivedFrom: ["research-swarm"],
    applicableTo: ["research-swarm", "delphi-panel", "kgotla"],
  },

  "consensus-synthesis": {
    id: "consensus-synthesis",
    name: "Consensus Synthesis",
    description: "Summarizing group will without imposing — reflecting the group back to itself accurately",
    category: "synthesis",
    derivedFrom: ["kgotla", "co-operative"],
    applicableTo: ["kgotla", "co-operative", "commune", "thing"],
  },

  "equal-voice-synthesis": {
    id: "equal-voice-synthesis",
    name: "Equal Voice Synthesis",
    description: "Integrating contributions without weighting by authority or volume — pure content merit",
    category: "synthesis",
    derivedFrom: ["co-operative"],
    applicableTo: ["co-operative", "commune", "kgotla"],
  },

  "estimate-revision": {
    id: "estimate-revision",
    name: "Estimate Revision",
    description: "Updating a position based on anonymized peer data without capitulating to social pressure",
    category: "synthesis",
    derivedFrom: ["delphi-panel"],
    applicableTo: ["delphi-panel", "conclave"],
  },

  "acclamation-reading": {
    id: "acclamation-reading",
    name: "Acclamation Reading",
    description: "Gauging consensus strength without formal vote counts — reading the room",
    category: "synthesis",
    derivedFrom: ["thing"],
    applicableTo: ["thing", "kgotla", "commune"],
  },

  "ballot-strategy": {
    id: "ballot-strategy",
    name: "Ballot Strategy",
    description: "Shifting position strategically across repeated voting rounds to build coalition",
    category: "synthesis",
    derivedFrom: ["conclave"],
    applicableTo: ["conclave", "legislature"],
  },

  // ═══════════════════════════════════════════
  // COORDINATION & LEADERSHIP
  // ═══════════════════════════════════════════

  "delegation-framing": {
    id: "delegation-framing",
    name: "Delegation Framing",
    description: "Breaking a directive into actionable sub-tasks with clear ownership and success criteria",
    category: "coordination",
    derivedFrom: ["corporate-hierarchy"],
    applicableTo: ["corporate-hierarchy", "incident-command", "research-swarm"],
  },

  "situation-assessment": {
    id: "situation-assessment",
    name: "Situation Assessment",
    description: "Rapidly determining scope, severity, and priority under pressure with incomplete information",
    category: "coordination",
    derivedFrom: ["incident-command"],
    applicableTo: ["incident-command", "devops-pipeline"],
  },

  "parallel-coordination": {
    id: "parallel-coordination",
    name: "Parallel Coordination",
    description: "Managing multiple workstreams with conflicting resource needs without serializing",
    category: "coordination",
    derivedFrom: ["incident-command"],
    applicableTo: ["incident-command", "research-swarm", "dev-team"],
  },

  "facilitation-rotation": {
    id: "facilitation-rotation",
    name: "Facilitation Rotation",
    description: "Switching between leading discussion and contributing to it — shared leadership",
    category: "coordination",
    derivedFrom: ["war-room"],
    applicableTo: ["war-room", "co-operative", "classroom"],
  },

  "amendment-drafting": {
    id: "amendment-drafting",
    name: "Amendment Drafting",
    description: "Modifying a proposal to address objections while preserving the original intent",
    category: "coordination",
    derivedFrom: ["legislature"],
    applicableTo: ["legislature", "co-operative", "conclave"],
  },

  "coalition-building": {
    id: "coalition-building",
    name: "Coalition Building",
    description: "Identifying which members' concerns can be jointly addressed to build voting majority",
    category: "coordination",
    derivedFrom: ["legislature"],
    applicableTo: ["legislature", "conclave", "thing"],
  },

  "deferral-judgment": {
    id: "deferral-judgment",
    name: "Deferral Judgment",
    description: "Knowing when consensus hasn't formed and the matter should wait rather than forcing a decision",
    category: "coordination",
    derivedFrom: ["kgotla"],
    applicableTo: ["kgotla", "co-operative", "conclave"],
  },

  // ═══════════════════════════════════════════
  // ADVERSARIAL & SECURITY
  // ═══════════════════════════════════════════

  "rebuttal-construction": {
    id: "rebuttal-construction",
    name: "Rebuttal Construction",
    description: "Responding to specific points rather than arguing past them — precise counterargument",
    category: "adversarial",
    derivedFrom: ["adversarial-debate"],
    applicableTo: ["adversarial-debate", "judiciary", "sanhedrin"],
  },

  "defense-under-pressure": {
    id: "defense-under-pressure",
    name: "Defense Under Pressure",
    description: "Defending your work product when directly challenged with specific evidence against it",
    category: "adversarial",
    derivedFrom: ["mob-sit-down"],
    applicableTo: ["mob-sit-down", "sanhedrin", "censorate", "thing"],
  },

  "evidence-based-charging": {
    id: "evidence-based-charging",
    name: "Evidence-Based Charging",
    description: "Constructing charges with specific timestamps, file references, and provenance — not vague accusations",
    category: "adversarial",
    derivedFrom: ["mob-sit-down"],
    applicableTo: ["mob-sit-down", "censorate", "sanhedrin"],
  },

  "principled-dissent": {
    id: "principled-dissent",
    name: "Principled Dissent",
    description: "Questioning a dominant narrative with evidence, not just contrarianism — the dissenter's discipline",
    category: "adversarial",
    derivedFrom: ["cult"],
    applicableTo: ["cult", "commune", "conclave", "legislature"],
  },

  "competitive-analysis": {
    id: "competitive-analysis",
    name: "Competitive Analysis",
    description: "Evaluating your own output against peers under elimination pressure — knowing where you stand",
    category: "adversarial",
    derivedFrom: ["colosseum"],
    applicableTo: ["colosseum", "tournament-bracket", "darwinian"],
  },

  "output-anonymization": {
    id: "output-anonymization",
    name: "Output Anonymization",
    description: "Stripping identifying patterns from work product so evaluation is purely on merit",
    category: "adversarial",
    derivedFrom: ["turing-test", "delphi-panel"],
    applicableTo: ["turing-test", "delphi-panel"],
  },

  "behavioral-observation": {
    id: "behavioral-observation",
    name: "Behavioral Observation",
    description: "Detecting changes in work patterns that indicate compromise, deception, or degradation",
    category: "adversarial",
    derivedFrom: ["panopticon"],
    applicableTo: ["panopticon", "honeypot", "mob-sit-down"],
  },

  "selective-reporting-detection": {
    id: "selective-reporting-detection",
    name: "Selective Reporting Detection",
    description: "Identifying when an observer or reporter is omitting information to serve a hidden agenda",
    category: "adversarial",
    derivedFrom: ["panopticon"],
    applicableTo: ["panopticon", "censorate", "turing-test"],
  },

  "constraint-negotiation": {
    id: "constraint-negotiation",
    name: "Constraint Negotiation",
    description: "Finding partial solutions when full solutions are impossible — the art of productive deadlock",
    category: "adversarial",
    derivedFrom: ["deadlock"],
    applicableTo: ["deadlock", "legislature", "conclave"],
  },

  "defection-detection": {
    id: "defection-detection",
    name: "Defection Detection",
    description: "Identifying when a negotiation partner has abandoned good faith while maintaining appearances",
    category: "adversarial",
    derivedFrom: ["deadlock"],
    applicableTo: ["deadlock", "panopticon", "turing-test"],
  },

  "corruption-tracing": {
    id: "corruption-tracing",
    name: "Corruption Tracing",
    description: "Following a defect backward through the phase chain to its origin — forensic root cause analysis",
    category: "adversarial",
    derivedFrom: ["honeypot", "panopticon"],
    applicableTo: ["honeypot", "panopticon", "mob-sit-down", "censorate"],
  },

  "honeypot-deployment": {
    id: "honeypot-deployment",
    name: "Honeypot Deployment",
    description: "Creating convincing but deliberately vulnerable artifacts that look like real code — the planter's craft",
    category: "adversarial",
    derivedFrom: ["honeypot"],
    applicableTo: ["honeypot"],
  },

  "honeypot-analysis": {
    id: "honeypot-analysis",
    name: "Honeypot Analysis",
    description: "Classifying agent behavior when encountering a planted vulnerability — report vs exploit vs ignore",
    category: "adversarial",
    derivedFrom: ["honeypot"],
    applicableTo: ["honeypot", "panopticon"],
  },

  "diff-forensics": {
    id: "diff-forensics",
    name: "Diff Forensics",
    description: "Security-focused diff analysis — detecting disguised vulnerabilities, unauthorized modifications, subtle backdoors",
    category: "adversarial",
    derivedFrom: ["dev-team", "panopticon"],
    applicableTo: ["dev-team", "panopticon", "mob-sit-down", "devops-pipeline"],
  },

  "provenance-verification": {
    id: "provenance-verification",
    name: "Provenance Verification",
    description: "Verifying that every change traces to an authorized decision — the audit trail check",
    category: "adversarial",
    derivedFrom: ["mob-sit-down", "censorate"],
    applicableTo: ["mob-sit-down", "censorate", "devops-pipeline", "panopticon"],
  },

  "consensus-analysis": {
    id: "consensus-analysis",
    name: "Consensus Analysis",
    description: "Detecting vote manipulation patterns in deliberative phases — who shifted whom and why",
    category: "adversarial",
    derivedFrom: ["conclave", "legislature"],
    applicableTo: ["conclave", "legislature", "thing", "kgotla", "deadlock"],
  },

  // ═══════════════════════════════════════════
  // PEDAGOGY & MENTORING
  // ═══════════════════════════════════════════

  "lecture-construction": {
    id: "lecture-construction",
    name: "Lecture Construction",
    description: "Presenting complex material in a structured, progressive sequence — scaffolded learning",
    category: "pedagogy",
    derivedFrom: ["classroom"],
    applicableTo: ["classroom", "apprentice-master"],
  },

  "socratic-questioning": {
    id: "socratic-questioning",
    name: "Socratic Questioning",
    description: "Asking questions that lead the learner to discover the answer themselves",
    category: "pedagogy",
    derivedFrom: ["classroom"],
    applicableTo: ["classroom", "apprentice-master", "kgotla"],
  },

  // ═══════════════════════════════════════════
  // META & SELF-AWARENESS
  // ═══════════════════════════════════════════

  "self-assessment-calibration": {
    id: "self-assessment-calibration",
    name: "Self-Assessment Calibration",
    description: "Honestly evaluating your own strengths and weaknesses with minimal self-serving bias",
    category: "meta",
    derivedFrom: ["perception-council"],
    applicableTo: ["perception-council", "darwinian", "colosseum"],
  },

  "peer-perception": {
    id: "peer-perception",
    name: "Peer Perception",
    description: "Forming accurate assessments of other agents' capabilities, tendencies, and reliability",
    category: "meta",
    derivedFrom: ["perception-council"],
    applicableTo: ["perception-council", "mob-sit-down", "panopticon"],
  },

  "raw-prompting": {
    id: "raw-prompting",
    name: "Raw Prompting",
    description: "Formulating precise queries without structural scaffolding — direct, unmediated interaction",
    category: "meta",
    derivedFrom: ["direct"],
    applicableTo: ["direct"],
  },

  "counter-investigation": {
    id: "counter-investigation",
    name: "Counter-Investigation",
    description: "Investigating the investigator's motives and methods — the censor who watches the censors",
    category: "meta",
    derivedFrom: ["censorate"],
    applicableTo: ["censorate", "panopticon"],
  },

  "convergence-under-isolation": {
    id: "convergence-under-isolation",
    name: "Convergence Under Isolation",
    description: "Narrowing options without new external information — making progress in a sealed environment",
    category: "meta",
    derivedFrom: ["conclave"],
    applicableTo: ["conclave"],
  },
};

// ─── SKILLS API ───

/** Get a skill by ID */
export function getSkillDef(id) {
  const s = TOPOLOGY_SKILLS[id];
  if (!s) throw new Error(`Unknown skill: ${id}`);
  return s;
}

/** List all skill IDs */
export function listSkillIds() {
  return Object.keys(TOPOLOGY_SKILLS);
}

/** List skills by category */
export function listByCategory() {
  const groups = {};
  for (const [id, skill] of Object.entries(TOPOLOGY_SKILLS)) {
    if (!groups[skill.category]) groups[skill.category] = [];
    groups[skill.category].push(id);
  }
  return groups;
}

/** Find skills derived from a specific topology */
export function findByTopology(topologyId) {
  return Object.entries(TOPOLOGY_SKILLS)
    .filter(([, s]) => s.derivedFrom.includes(topologyId))
    .map(([id]) => id);
}

/** Find skills applicable to a specific topology */
export function findApplicableTo(topologyId) {
  return Object.entries(TOPOLOGY_SKILLS)
    .filter(([, s]) => s.applicableTo.includes(topologyId))
    .map(([id]) => id);
}

export default { TOPOLOGY_SKILLS, getSkillDef, listSkillIds, listByCategory, findByTopology, findApplicableTo };
