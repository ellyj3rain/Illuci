/**
 * illuci/core/mcp/formation-tools.js — formation Phase A as Tier-1 MCP tools
 *
 * Per constitutional/BILL_OF_STANDARDS.md (Standard 16), formation/engine.js Phase A is Tier-1
 * ("NL → topology selection by keyword scoring; pure function"). Exposes the two
 * synchronous, pure Phase-A functions — complexity inference and keyword-based
 * team formation. The async, model-backed Phase-B functions (formTeamWithModel,
 * generateTopology) are NOT exposed (they invoke dispatch → Tier-Z).
 */

import { inferComplexity, formTeam } from "../formation/engine.js";

export const FORMATION_TOOLS = [
  {
    name: "infer_complexity_v1",
    schema_version: "1.0.0",
    description:
      "Infer a task's complexity by keyword scoring (formation Phase A). Read-only, pure — no model call.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The natural-language task to assess." } },
      required: ["task"],
    },
    handler(args = {}) {
      const task = args.task;
      if (!task || typeof task !== "string") {
        throw new Error("infer_complexity_v1: task (string) is required");
      }
      return inferComplexity(task);
    },
  },
  {
    name: "form_team_v1",
    schema_version: "1.0.0",
    description:
      "Form a team for a task by keyword-based role selection against the capability matrix " +
      "(formation Phase A). Read-only, pure — no model call.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The natural-language task to staff." } },
      required: ["task"],
    },
    handler(args = {}) {
      const task = args.task;
      if (!task || typeof task !== "string") {
        throw new Error("form_team_v1: task (string) is required");
      }
      return formTeam(task);
    },
  },
];

export default { FORMATION_TOOLS };
