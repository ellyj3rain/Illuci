/**
 * illuci/core/mcp/analysis-tools.js — analysis (cost + calibration) as Tier-1 MCP tools
 *
 * Per constitutional/BILL_OF_STANDARDS.md (Standard 16), core/analysis/ is Tier-1 ("Calibration +
 * cost estimation; pure function"). Exposes the two named pure-function surfaces:
 * per-invocation cost estimation and cross-response calibration. Read-only, pure —
 * no model call, no state.
 */

import { calculateCost } from "../analysis/cost-model.js";
import { calibrate } from "../analysis/calibration.js";

export const ANALYSIS_TOOLS = [
  {
    name: "estimate_cost_v1",
    schema_version: "1.0.0",
    description:
      "Estimate the cost of a model invocation from its token usage and the model's rate. Read-only, pure.",
    inputSchema: {
      type: "object",
      properties: {
        modelId: { type: "string", description: "The model id (e.g. 'deepseek')." },
        usage: {
          type: "object",
          description: "Token usage: { prompt_tokens?, completion_tokens?, total_tokens? }.",
        },
      },
      required: ["modelId"],
    },
    handler(args = {}) {
      if (!args.modelId || typeof args.modelId !== "string") {
        throw new Error("estimate_cost_v1: modelId (string) is required");
      }
      return calculateCost(args.modelId, args.usage || {});
    },
  },
  {
    name: "calibrate_v1",
    schema_version: "1.0.0",
    description:
      "Compute system confidence + agreement across a set of model responses (calibration). Read-only, pure.",
    inputSchema: {
      type: "object",
      properties: {
        responses: {
          type: "array",
          description: "Array of { model, response, ... } response objects (2+ for a meaningful signal).",
        },
      },
      required: ["responses"],
    },
    handler(args = {}) {
      if (!Array.isArray(args.responses)) {
        throw new Error("calibrate_v1: responses (array) is required");
      }
      return calibrate(args.responses);
    },
  },
];

export default { ANALYSIS_TOOLS };
