/**
 * illuci — Formation Engine (Phase A)
 *
 * Translates natural language task descriptions into topology selections.
 * Phase A: select from existing topologies only — no freeform generation.
 *
 * Formation rulings: R9 (formation split), R10 (cost model prerequisite).
 *
 * Flow:
 *   1. Score all topologies against the task using keyword + heuristic matching
 *   2. If confidence is low, escalate to an architect model for selection
 *   3. Assemble lineup via capability matrix auto-fill
 *   4. Return { topologyId, lineup, confidence, reasoning }
 */

import { TOPOLOGIES, describeTopologies, getSeatModeRequirements, getSeatCapabilityDemand } from "../topologies/index.js";
import { calculateTopologyCost } from "./cost-model.js";
import { supportsMode, resolveRole } from "../matrix/capability-matrix.js";

export const DEFAULT_FORMATION_ARCHITECT_MODEL = "claude-opus";

export function resolveFormationArchitectModel(options = {}) {
  return options.architectModel || DEFAULT_FORMATION_ARCHITECT_MODEL;
}

// ─── TOPOLOGY SCORING ───
// Keyword-based heuristic scoring. Fast, no model call needed for clear cases.

const TOPOLOGY_KEYWORDS = {
  "direct":              ["simple", "quick", "just ask", "one question", "single", "passthrough"],
  "adversarial-debate":  ["debate", "argue", "red team", "blue team", "adversarial", "pros cons", "attack defend", "security review"],
  "judiciary":           ["judge", "prosecute", "defend", "legal", "ruling", "verdict", "evaluate evidence"],
  "dev-team":            ["build", "implement", "code", "develop", "feature", "architect", "review code", "qa", "test"],
  "devops-pipeline":     ["pipeline", "staged", "sequential", "gate", "workflow", "multi-step", "process", "deploy", "ci cd"],
  "delphi-panel":        ["estimate", "predict", "forecast", "anonymous", "consensus", "how many", "how long"],
  "research-swarm":      ["research", "investigate", "explore", "decompose", "analyze", "study", "deep dive"],
  "tournament-bracket":  ["compare", "compete", "best solution", "tournament", "rank", "which is better"],
  "peer-review-ring":    ["refine", "improve", "iterate", "polish", "edit", "revise", "peer review"],
  "war-room":            ["collaborate", "brainstorm", "co-create", "shared", "together", "workshop"],
  "incident-command":    ["incident", "crisis", "emergency", "outage", "breach", "response", "triage"],
  "scenario-simulation": ["scenario", "future", "risk", "what if", "best case", "worst case", "plan"],
  "apprentice-master":   ["teach", "learn", "mentor", "explain", "tutor", "lesson"],
  "market-auction":      ["bid", "auction", "proposal", "rfp", "assign"],
  "legislature":         ["propose", "amend", "vote", "resolution", "policy", "decide"],
  "corporate-hierarchy": ["executive", "report", "brief", "synthesis", "strategy", "management"],
  "triage-funnel":       ["filter", "narrow", "funnel", "screen", "eliminate", "shortlist"],
  "commune":             ["consensus", "equal", "democratic", "collective", "no hierarchy"],
  "co-operative":        ["cooperative", "equal voice", "flat", "synthesis not voting"],
  "classroom":           ["academic", "lecture", "study", "professor", "student"],
  "perception-council":  ["perception", "identity", "self-assess", "peer review models"],
};

/**
 * Score topologies against a task description using keyword matching.
 *
 * @param {string} task — natural language task description
 * @returns {Array<{ id: string, score: number, matches: string[] }>}
 */
function scoreTopologies(task) {
  const lower = task.toLowerCase();
  const scores = [];

  for (const [topoId, keywords] of Object.entries(TOPOLOGY_KEYWORDS)) {
    const matches = keywords.filter(kw => lower.includes(kw));
    const score = matches.length;
    if (score > 0) {
      scores.push({ id: topoId, score, matches });
    }
  }

  // Sort by score descending, break ties by cost ascending (R10: cheapest wins)
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Equal keyword scores — break by estimated cost (cheaper topology wins)
    const costA = calculateTopologyCost(a.id, task);
    const costB = calculateTopologyCost(b.id, task);
    return costA - costB;
  });
  return scores;
}

/**
 * Infer task complexity from the description.
 * Used to decide between light topologies (direct) and heavy ones (dev-team, pipeline).
 */
export function inferComplexity(task) {
  const lower = task.toLowerCase();
  const highSignals = ["security", "architecture", "refactor", "migration", "critical", "production", "deploy", "audit"];
  const lowSignals = ["simple", "quick", "just", "only", "small", "minor", "trivial"];

  const highCount = highSignals.filter(s => lower.includes(s)).length;
  const lowCount = lowSignals.filter(s => lower.includes(s)).length;

  if (highCount >= 2) return "high";
  if (lowCount >= 2 || task.length < 50) return "low";
  return "medium";
}

/**
 * Select a topology and assemble a lineup for a natural language task.
 *
 * @param {string} task — what the operator wants done
 * @param {object} options
 * @param {object} options.lineup — partial lineup overrides (operator preferences)
 * @param {string} options.projectId
 * @returns {{ topologyId: string, lineup: object, confidence: number, reasoning: string }}
 */
export function formTeam(task, options = {}) {
  const scores = scoreTopologies(task);
  const complexity = inferComplexity(task);

  let topologyId;
  let confidence;
  let reasoning;

  if (scores.length === 0) {
    // No keyword matches — fall back based on complexity
    if (complexity === "low") {
      topologyId = "direct";
      confidence = 0.5;
      reasoning = "No keyword matches, low complexity — defaulting to direct execution";
    } else if (complexity === "high") {
      topologyId = "dev-team";
      confidence = 0.4;
      reasoning = "No keyword matches, high complexity — defaulting to dev-team for structured execution";
    } else {
      topologyId = "research-swarm";
      confidence = 0.4;
      reasoning = "No keyword matches, medium complexity — defaulting to research-swarm for exploration";
    }
  } else {
    const best = scores[0];
    const secondBest = scores[1];

    // Confidence based on margin between best and second-best
    if (!secondBest || best.score > secondBest.score * 2) {
      confidence = Math.min(0.95, 0.5 + best.score * 0.15);
    } else {
      confidence = Math.min(0.7, 0.3 + best.score * 0.1);
    }

    topologyId = best.id;
    reasoning = `Matched keywords: [${best.matches.join(", ")}] → ${topologyId} (${complexity} complexity)`;
  }

  // Override if operator specifies topology
  if (options.topologyId) {
    topologyId = options.topologyId;
    confidence = 1.0;
    reasoning = "Operator-specified topology";
  }

  // Assemble lineup via capability matrix auto-fill
  const topology = TOPOLOGIES[topologyId];
  if (!topology) {
    throw new Error(`Formation engine selected unknown topology: ${topologyId}`);
  }

  // Auto-fill any empty seats considering mode requirements
  const lineup = autoFillWithModes(topology, options.lineup || {});

  return {
    topologyId,
    lineup,
    confidence,
    reasoning,
    complexity,
    estimatedCost: calculateTopologyCost(topologyId, task),
    scores: scores.slice(0, 5), // Top 5 for transparency
  };
}

/**
 * Escalated formation — uses a model to select topology when heuristics are low confidence.
 * Only called when confidence < threshold.
 *
 * @param {string} task
 * @param {object} options
 * @returns {Promise<object>} Same shape as formTeam
 */
export async function formTeamWithModel(task, options = {}) {
  const heuristic = formTeam(task, options);

  // If heuristic is confident enough, use it
  if (heuristic.confidence >= (options.minConfidence || 0.6)) {
    return heuristic;
  }

  // Escalate to architect model
  try {
    const { queryModel } = await import("../dispatch/dispatch.js");
    const topologyList = describeTopologies().map(t => `${t.id}: ${t.description}`).join("\n");

    const architectModel = resolveFormationArchitectModel(options);
    const result = await queryModel(architectModel,
      `Select the best topology for this task. Reply with ONLY the topology ID.\n\nTask: ${task}\n\nTopologies:\n${topologyList}`,
      { raw: true, projectId: options.projectId }
    );

    const selectedId = (result.response || "").trim().replace(/["`']/g, "");
    if (TOPOLOGIES[selectedId]) {
      const topology = TOPOLOGIES[selectedId];
      const lineup = options.lineup || {};
      return {
        topologyId: selectedId,
        lineup,
        confidence: 0.8,
        reasoning: `Model-selected (architect: ${architectModel}): ${selectedId}`,
        complexity: heuristic.complexity,
        scores: heuristic.scores,
        escalated: true,
      };
    }
  } catch {}

  // Fallback to heuristic result
  return heuristic;
}

// ─── MODE-AWARE AUTO-FILL ───

/**
 * Auto-fill empty seats with mode capability awareness.
 *
 * The mode field on a phase implies capability requirements:
 * - write → model must produce structured file operations
 * - execute → model must reason about commands
 * - delegate → model must have native tool-use (Codex only)
 * - respond/read → any model
 *
 * This function filters candidates by mode capability before applying
 * the standard role-based selection from the capability matrix.
 *
 * @param {object} topology — topology definition
 * @param {object} lineup — partial lineup (operator overrides)
 * @returns {object} filled lineup
 */
function autoFillWithModes(topology, lineup) {
  const filled = { ...lineup };
  const assigned = new Set(Object.values(filled).flat());

  // Get mode requirements for each seat
  const seatModes = getSeatModeRequirements(topology.id);

  for (const seat of topology.seats) {
    if (filled[seat.id]) continue; // operator assigned — don't touch

    // Determine the most demanding phase-effect capability this seat needs.
    const capabilityDemand = getSeatCapabilityDemand(topology.id, seat.id) || "respond";

    // Try to suggest a fill from the capability matrix
    let candidates = seat.roleHint ? resolveRole(seat.roleHint) : [];
    if (candidates.length === 0) candidates = resolveRole("analyst");
    if (candidates.length === 0) continue;

    // Filter candidates by mode capability
    const capableCandidates = candidates.filter(c => supportsMode(c.model, capabilityDemand));

    // If no capable candidates, warn and fall back to any candidate
    // (the topology will likely fail at runtime, but we provide visibility)
    const pool = capableCandidates.length > 0 ? capableCandidates : candidates;
    if (capableCandidates.length === 0) {
      console.warn(`[formation] No models available for seat "${seat.id}" with capability demand "${capabilityDemand}". Falling back to any candidate.`);
    }

    // Prefer models not already assigned
    const unassigned = pool.filter(c => !assigned.has(c.model));
    const finalPool = unassigned.length > 0 ? unassigned : pool;

    const count = Math.max(seat.min, 1);
    const models = finalPool.slice(0, count).map((c) => c.model);
    for (const m of models) assigned.add(m);
    filled[seat.id] = models.length === 1 ? models[0] : models;
  }

  return filled;
}

// Phase B: freeform topology generation

const TOPOLOGY_GEN_PROMPT = `Design a custom topology for this task. A topology has:
- seats: named positions (e.g., "architect", "reviewer") with min/max model counts
- phases: ordered execution steps, each with a type (parallel/single/sequential/rotating)

Reply with ONLY a JSON object:
{
  "name": "Short topology name",
  "description": "One-line description",
  "seats": [
    { "id": "seat-id", "label": "Human Label", "min": 1, "max": 1, "roleHint": "capability-matrix-role-or-null" }
  ],
  "phases": [
    { "id": "phase-id", "type": "parallel|single|sequential|rotating", "seats": ["seat-id"], "input": "prompt|phase:prev-id" }
  ]
}

Task: `;

/**
 * Generate a custom topology using a model when no existing topology fits.
 * Saves the result as a global artifact for reuse.
 *
 * @param {string} task
 * @param {object} options
 * @returns {Promise<object>} Generated topology definition
 */
export async function generateTopology(task, options = {}) {
  const { queryModel } = await import("../dispatch/dispatch.js");

  const architectModel = resolveFormationArchitectModel(options);
  const result = await queryModel(architectModel,
    `${TOPOLOGY_GEN_PROMPT}${task}`,
    { raw: true, projectId: options.projectId }
  );

  if (!result?.response) throw new Error("Topology generation returned empty response");

  const jsonMatch = result.response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse topology JSON from model response");

  const generated = JSON.parse(jsonMatch[0]);
  const topoId = `custom-${Date.now()}`;

  const topology = {
    id: topoId,
    name: generated.name || `Custom: ${task.substring(0, 40)}`,
    description: generated.description || task.substring(0, 100),
    origin: {
      proposedBy: "model",
      models: [architectModel],
      timestamp: new Date().toISOString(),
      context: `Formation engine Phase B: ${task.substring(0, 80)}`,
    },
    seats: generated.seats || [],
    phases: generated.phases || [],
  };

  // Validate basic structure
  if (topology.seats.length === 0) throw new Error("Generated topology has no seats");
  if (topology.phases.length === 0) throw new Error("Generated topology has no phases");

  // Save as global artifact for reuse
  try {
    const store = await import("../context/store.js");
    store.writeArtifact(options.projectId || "illuci-formation", {
      name: topoId,
      type: "topology",
      content: JSON.stringify(topology, null, 2),
      author: "formation-engine",
      metadata: { scope: "global", task: task.substring(0, 200) },
    });
  } catch {}

  return topology;
}

/**
 * Full formation: heuristic → model escalation → freeform generation.
 * Uses the cheapest path that produces a confident result.
 *
 * @param {string} task
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function formTeamFull(task, options = {}) {
  // Try heuristic first
  const heuristic = formTeam(task, options);
  if (heuristic.confidence >= (options.minConfidence || 0.7)) {
    return heuristic;
  }

  // Try model-assisted selection from existing topologies
  const modelAssisted = await formTeamWithModel(task, {
    ...options,
    minConfidence: options.minConfidence || 0.6,
  });
  if (modelAssisted.confidence >= (options.minConfidence || 0.6)) {
    return modelAssisted;
  }

  // Generate a custom topology
  try {
    const topology = await generateTopology(task, options);
    return {
      topologyId: topology.id,
      topology,
      lineup: options.lineup || {},
      confidence: 0.7,
      reasoning: `Generated custom topology: ${topology.name}`,
      complexity: heuristic.complexity,
      generated: true,
    };
  } catch (err) {
    // Fall back to best heuristic
    return { ...modelAssisted, fallback: true, generationError: err.message };
  }
}

export default { formTeam, formTeamWithModel, generateTopology, formTeamFull };
