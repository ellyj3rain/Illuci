/**
 * illuci — Baseline Benchmarking
 *
 * Runs a single-model baseline alongside a council topology run
 * to measure whether the council actually outperformed direct query.
 *
 * When --baseline is set:
 *   1. Before the topology runs, dispatch the same prompt to one model (direct)
 *   2. After topology completes, produce a side-by-side comparison
 *   3. Log the comparison as a benchmark decision
 *
 * Over time, operators can run `illuci benchmark report` to see win rates.
 */

import { queryModel } from "../dispatch/dispatch.js";
import { logDecision } from "../decisions/logger.js";

/**
 * Run a baseline comparison for a topology execution.
 *
 * @param {string} prompt — same prompt sent to the topology
 * @param {string} baselineModelId — model to use for baseline (defaults to first model in lineup)
 * @param {object} topologyTrace — the completed topology trace
 * @returns {object} Baseline comparison result
 */
export async function runBaseline(prompt, baselineModelId, topologyTrace) {
  const start = Date.now();

  // Run single-model baseline
  const baselineResult = await queryModel(baselineModelId, prompt, { raw: true });
  const baselineLatency = Date.now() - start;

  // Extract topology final output
  const phaseKeys = Object.keys(topologyTrace.phases);
  const lastPhase = topologyTrace.phases[phaseKeys[phaseKeys.length - 1]];
  const councilResponses = lastPhase?.responses || [];
  const councilOutput = councilResponses.map((r) => r.response || "").join("\n\n---\n\n");

  // Compute comparison metrics
  const councilTokens = phaseKeys.reduce((sum, k) => sum + (topologyTrace.phases[k].totalTokens || 0), 0);
  const baselineTokens = baselineResult.usage?.total_tokens || 0;

  const comparison = {
    baseline: {
      model: baselineModelId,
      response: baselineResult.response,
      tokens: baselineTokens,
      latency: baselineLatency,
    },
    council: {
      topology: topologyTrace.topologyName,
      response: councilOutput.substring(0, 2000),
      tokens: councilTokens,
      latency: topologyTrace.totalLatency,
      phases: phaseKeys.length,
    },
    ratios: {
      tokenRatio: baselineTokens > 0 ? (councilTokens / baselineTokens).toFixed(1) + "x" : "N/A",
      latencyRatio: baselineLatency > 0 ? (topologyTrace.totalLatency / baselineLatency).toFixed(1) + "x" : "N/A",
    },
  };

  // Log the benchmark decision
  logDecision({
    humanStatus: "operator-initiated",
    modelStatus: [
      { model: baselineModelId, seat: "baseline" },
      ...councilResponses.map((r) => ({ model: r.model, seat: r.seat })),
    ],
    context: `Baseline benchmark: ${baselineModelId} vs ${topologyTrace.topologyName}`,
    type: "benchmark",
    decision: `Baseline comparison: ${comparison.ratios.tokenRatio} tokens, ${comparison.ratios.latencyRatio} latency`,
    inputs: { prompt: prompt.substring(0, 200) },
    outputs: comparison.ratios,
    metadata: comparison,
  });

  return comparison;
}

export default { runBaseline };
