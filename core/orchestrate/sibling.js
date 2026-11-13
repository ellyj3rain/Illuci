// Model-led orchestration: a model queries and tunes a sibling through the same governed dispatch.
// One handler, two surfaces — the in-context tool below and the MCP boundary register the same querySibling.
import { queryModel } from "../dispatch/dispatch.js";

export async function querySibling({ model, prompt, role = null, reasoning = null, skills = [], disposition = {}, peerIds = [] }) {
  const result = await queryModel(model, prompt, {
    seat: role || "sibling",
    roleHint: role,
    reasoning,
    skills,
    dispositionBias: disposition,
    peerIds,
  });
  return { model: result.model, response: result.response, usage: result.usage, error: result.error ?? null };
}

export const siblingTool = {
  name: "query_sibling",
  description: "Query a sibling model through illuci, tuning its model, role, reasoning, and skills. Returns the sibling's response.",
  parameters: {
    type: "object",
    properties: {
      model: { type: "string", description: "fleet model id, e.g. grok-build, deepseek, gemini-local" },
      prompt: { type: "string" },
      role: { type: "string", description: "role to tune the sibling toward" },
      reasoning: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
      skills: { type: "array", items: { type: "string" } },
    },
    required: ["model", "prompt"],
  },
  handler: querySibling,
};

export default { querySibling, siblingTool };
