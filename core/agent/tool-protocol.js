/**
 * illuci Agent SDK — Tool-Call Protocol (hybrid)
 *
 * How a model signals "call tool X with args Y", parsed back into structured
 * calls the loop can gate + execute. Hybrid by design (the ratified §6.2
 * default), in priority order:
 *
 *   1. NATIVE — the bridge's stream final event already carries structured
 *      tool calls (finalEvent.toolCalls / .tool_calls). Extension point: the
 *      moment a bridge surfaces provider-native function-calling, it flows
 *      through here with zero loop changes. (claude.js / codex.js do not today.)
 *   2. JSON tool_calls — { "tool_calls": [ { "tool", "args" } ] } emitted in
 *      the response text. The model-agnostic universal path.
 *   3. WRITE-MODE MANIFEST — illuci's existing { "operations": [ { type, path,
 *      content } ] } convention (see topologies/runner.js extractFileOperations)
 *      mapped onto file_write / file_edit / file_delete, so models already
 *      trained on illuci's write convention keep working unchanged.
 *   4. FENCED FALLBACK — ```tool\n{ "tool", "args" }\n``` blocks.
 *
 * Returns [] when the response is a final answer with no tool calls — that is
 * the loop's terminal signal. looksLikeToolAttempt() lets the loop tell that
 * clean terminal apart from a malformed attempt that parsed to zero calls (the
 * audited silent-success failure), so it can issue a bounded repair turn
 * instead of terminating as success.
 *
 * @typedef {object} ToolCall
 * @property {string} id    — synthesized stable id for request/result correlation
 * @property {string} name  — tool name (must be a illuci TOOL_NAMES member to execute)
 * @property {object} args  — tool arguments
 */

let _counter = 0;
function nextId() {
  _counter += 1;
  return `tc_${Date.now().toString(36)}_${_counter}`;
}

/**
 * Parse tool calls from a model turn.
 *
 * @param {string} text — the assistant's text response
 * @param {object} [finalEvent] — the dispatch final event (native path)
 * @returns {ToolCall[]}
 */
export function parseToolCalls(text = "", finalEvent = null) {
  // ── 1. NATIVE — bridge already structured them ──
  const native = finalEvent?.toolCalls || finalEvent?.tool_calls;
  if (Array.isArray(native) && native.length > 0) {
    return native
      .map((c) => ({
        id: c.id || nextId(),
        name: c.tool || c.name || c.function?.name,
        args: c.args || c.arguments || c.input || {},
      }))
      .filter((c) => c.name);
  }

  if (typeof text !== "string" || text.length === 0) return [];

  // ── 2. JSON tool_calls ──
  const toolCallsObj = extractJsonWith(text, "tool_calls");
  if (toolCallsObj && Array.isArray(toolCallsObj.tool_calls)) {
    const calls = toolCallsObj.tool_calls
      .map((c) => ({
        id: c.id || nextId(),
        name: c.tool || c.name,
        args: c.args || c.arguments || c.input || {},
      }))
      .filter((c) => c.name);
    if (calls.length > 0) return calls;
  }

  // ── 3. WRITE-MODE MANIFEST — { operations: [...] } → file_* tool calls ──
  const opsObj = extractJsonWith(text, "operations");
  if (opsObj && Array.isArray(opsObj.operations)) {
    const calls = opsObj.operations
      .map((op) => operationToCall(op))
      .filter(Boolean);
    if (calls.length > 0) return calls;
  }

  // ── 4. FENCED FALLBACK — ```tool { ... } ``` ──
  const fenced = [];
  const fenceRe = /```tool\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const name = parsed.tool || parsed.name;
      if (name) fenced.push({ id: parsed.id || nextId(), name, args: parsed.args || parsed.arguments || {} });
    } catch { /* malformed fence — skip */ }
  }
  return fenced;
}

/**
 * Heuristic: does this turn LOOK like an attempted tool call that extraction
 * could not parse? The loop uses it when parseToolCalls() returns [] to tell a
 * clean final answer apart from a malformed tool attempt. Conservative on
 * purpose - it matches only the protocol's own signatures (the quoted
 * tool_calls / operations keys and the ```tool fence), so ordinary prose that
 * merely mentions tools never trips it.
 *
 * @param {string} text - the assistant's text response
 * @returns {boolean}
 */
export function looksLikeToolAttempt(text = "") {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    /```tool\b/i.test(text) ||
    /"tool_calls"\s*:/.test(text) ||
    /"operations"\s*:/.test(text)
  );
}

/**
 * The corrective instruction for a bounded repair turn. Owned by the protocol
 * module (not the loop) so the calling convention it restates lives in exactly
 * one place, next to the parser it must match.
 *
 * @param {"empty"|"unparsed"} reason
 * @returns {string}
 */
export function buildRepairInstruction(reason) {
  if (reason === "empty") {
    return [
      "Your previous turn was empty. Reply with either a tool call as exactly one JSON object -",
      '{"tool_calls":[{"tool":"<name>","args":{...}}]}',
      "- or your final answer as plain text.",
    ].join("\n");
  }
  return [
    "Your previous turn looked like a tool call, but no tool call could be parsed from it.",
    "Re-emit it as exactly one valid JSON object -",
    '{"tool_calls":[{"tool":"<name>","args":{...}}]}',
    "- using a real tool name and valid JSON. If you intended a final answer instead, reply in plain text with no tool syntax.",
  ].join("\n");
}

/** Map a write-mode operation to a file_* ToolCall. */
function operationToCall(op) {
  if (!op || !op.path) return null;
  const type = (op.type || op.action || "create").toLowerCase();
  switch (type) {
    case "create":
    case "write":
      return { id: nextId(), name: "file_write", args: { path: op.path, content: op.content || "" } };
    case "edit":
    case "update":
      return { id: nextId(), name: "file_edit", args: { path: op.path, content: op.content || "" } };
    case "delete":
    case "remove":
      return { id: nextId(), name: "file_delete", args: { path: op.path } };
    default:
      return null;
  }
}

/**
 * Pull the first JSON object containing `key` out of free text. Tries a fenced
 * ```json block first, then a brace-balanced scan so prose around the JSON does
 * not defeat extraction.
 */
function extractJsonWith(text, key) {
  // Fenced ```json … ``` first
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);

  // Brace-balanced scan from each "key" occurrence's enclosing object
  const keyIdx = text.indexOf(`"${key}"`);
  if (keyIdx !== -1) {
    const start = text.lastIndexOf("{", keyIdx);
    if (start !== -1) {
      const slice = balancedObject(text, start);
      if (slice) candidates.push(slice);
    }
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === "object" && key in parsed) return parsed;
    } catch { /* try next candidate */ }
  }
  return null;
}

/** Return the substring of a brace-balanced object starting at `start` ('{'). */
function balancedObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The tool-instruction block appended to the system/turn prompt so a raw model
 * knows the available tools and the calling convention. Concise on purpose —
 * the loop re-sends it each turn, so it must stay cheap.
 *
 * @param {string[]} toolNames — allowed tool names for this run
 * @returns {string}
 */
export function buildToolInstructions(toolNames = []) {
  if (!toolNames.length) return "";
  return [
    "",
    "## Tools",
    "You may call tools. To call one, emit a JSON object (optionally in a ```json block):",
    '{"tool_calls":[{"tool":"<name>","args":{...}}]}',
    "Call only when an action is needed; otherwise reply normally and the turn ends.",
    "After each call you will see its result and may call again. When the task is done, reply with the final answer and no tool call.",
    `Available tools: ${toolNames.join(", ")}.`,
    "",
  ].join("\n");
}

export default { parseToolCalls, buildToolInstructions, looksLikeToolAttempt, buildRepairInstruction };
