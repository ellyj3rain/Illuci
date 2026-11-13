// core/bridges/reasoning-split.js
//
// [A47]/F-089: reasoning models emit chain-of-thought SEPARATELY from the final
// answer (Ollama native: message.thinking; OpenAI-compat: message.reasoning).
// On a hard task a reasoning model can spend its ENTIRE token budget on the
// chain-of-thought and return an EMPTY final answer. The old bridge fallback
// `content || thinking` then substituted the raw scratchpad AS the answer — the
// F-084 empty-success family: a genuinely empty answer masked by returning the
// reasoning trace, which then flowed through councils as a seat's response.
//
// The rule: the answer is the CONTENT only. Reasoning is carried separately for
// observability and NEVER substituted for an empty answer. An empty answer with
// nonempty reasoning and no tool calls is an honest budget-STARVED failure — the
// caller must raise the token budget, not receive a scratchpad.

// Defensive strip for models that emit reasoning INLINE in content as tagged
// blocks (<think>…</think>, <reasoning>…</reasoning>) instead of a separate field.
const REASONING_TAG_RE = /<(think|thinking|reason(?:ing)?)>[\s\S]*?<\/\1>/gi;

export function stripInlineReasoning(text) {
  if (typeof text !== "string") return "";
  return text.replace(REASONING_TAG_RE, "").trim();
}

/**
 * Split a bridge message into the final answer and its reasoning.
 * @param {{content?: string, reasoning?: string, hasToolCalls?: boolean}} input
 * @returns {{answer: string, reasoning: string, starved: boolean}}
 *   starved = empty answer with real reasoning and no tool calls (budget-starved).
 */
export function splitReasoning({ content, reasoning, hasToolCalls = false } = {}) {
  const answer = stripInlineReasoning(content || "");
  const think = typeof reasoning === "string" ? reasoning.trim() : "";
  const starved = !answer && think.length > 0 && !hasToolCalls;
  return { answer, reasoning: think, starved };
}

export const REASONING_STARVED_ERROR =
  "reasoning-starved: the model spent its token budget on chain-of-thought and produced no final answer — raise the token budget (num_predict) or reduce the task. Reasoning is not the answer.";

export default { stripInlineReasoning, splitReasoning, REASONING_STARVED_ERROR };
