/**
 * illuci — Mixed Council Preset
 *
 * Composes dev-team and devops-pipeline topologies into a single
 * mixed council run. Both topologies execute with full seat rosters —
 * this is not bilateral, it's a full council for each side.
 *
 * Phase 1 - Build (dev-team):
 *   Architect designs, implementers build, reviewers critique, QA validates.
 *   Output: vetted implementation plan + code.
 *
 * Phase 2 — DevOps Pipeline:
 *   Build, test, security scan, staging review, deploy review, monitoring.
 *   Input: dev-team output. Output: production-ready assessment.
 *
 * The two councils share context: DevOps seniors receive the full dev-team
 * trace and evaluate it through their operational lens.
 *
 * Default lineups use all available models, distributed by strength:
 *   Build:  claude architects, codex+kimi implement, deepseek+gemini+grok review, ollama QA
 *   DevOps: codex builds, ollama tests, deepseek scans, gemini stages, claude deploys, grok monitors
 */

import { CDC_DEFAULT_LINEUP } from "./cdc.js";

export const MIXED_COUNCIL_ID = "mixed-council";

// Build phase (dev-team)

export const CDC_PHASE = {
  topologyId: "dev-team",
  label: "Build - Design & Implementation",
  lineup: { ...CDC_DEFAULT_LINEUP },
};

// ─── DEVOPS PHASE (devops-pipeline) ───

export const DEVOPS_PHASE = {
  topologyId: "devops-pipeline",
  label: "DevOps — Build, Test, Secure, Deploy",
  lineup: {
    build:    "codex-local",
    test:     "ollama",
    security: "deepseek",
    staging:  "gemini-local",
    deploy:   "claude-local",
    monitor:  "grok",
  },
};

// ─── MIXED COUNCIL COMPOSITION ───

/**
 * Returns the full mixed council phase array for runMixed().
 * @param {object} options
 * @param {object} options.cdcOverrides - seat overrides for the build phase
 * @param {object} options.devopsOverrides — seat overrides for DevOps phase
 * @returns {object[]} phases array for runMixed()
 */
export function mixedCouncilPhases(options = {}) {
  const cdcLineup = { ...CDC_PHASE.lineup, ...(options.cdcOverrides || {}) };
  const devopsLineup = { ...DEVOPS_PHASE.lineup, ...(options.devopsOverrides || {}) };

  return [
    {
      topologyId: CDC_PHASE.topologyId,
      label: CDC_PHASE.label,
      lineup: cdcLineup,
    },
    {
      topologyId: DEVOPS_PHASE.topologyId,
      label: DEVOPS_PHASE.label,
      lineup: devopsLineup,
    },
  ];
}

/**
 * Describe the mixed council for display.
 */
export function describeMixedCouncil() {
  return {
    id: MIXED_COUNCIL_ID,
    name: "Mixed Council (Build + DevOps)",
    description: "Full dev-team council feeds into full devops-pipeline council. Both run with complete seat rosters.",
    phases: [
      { topology: "dev-team", label: CDC_PHASE.label, seats: Object.keys(CDC_PHASE.lineup) },
      { topology: "devops-pipeline", label: DEVOPS_PHASE.label, seats: Object.keys(DEVOPS_PHASE.lineup) },
    ],
    totalSeats: Object.keys(CDC_PHASE.lineup).length + Object.keys(DEVOPS_PHASE.lineup).length,
    totalModels: new Set([
      ...Object.values(CDC_PHASE.lineup).flat(),
      ...Object.values(DEVOPS_PHASE.lineup).flat(),
    ]).size,
  };
}

export default { MIXED_COUNCIL_ID, CDC_PHASE, DEVOPS_PHASE, mixedCouncilPhases, describeMixedCouncil };
