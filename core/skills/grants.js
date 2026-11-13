/**
 * illuci — Skill Grants (the skill framework as a LIVED permission layer)
 *
 * M6 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §6 stratum 2,
 * §9 skill-as-permission-grant). Skills stop being mere prompt heuristics and
 * become a per-seat LICENSE: which off-floor surface (MCP bridges) a seat may
 * reach, plus the most-restrictive autonomy bounds and invariants its skills
 * impose. Resolved from the org's per-seat skill bindings (M5) via the [A94]
 * composeDisposition algebra; rendered into the [Skills] frame block; enforced at
 * the gate; observable via telemetry/musings.
 *
 * ── THE SECURITY INVARIANT (DR-112) ──
 * A skill grant is a REQUEST STILL SUBJECT TO THE MODE, never a bypass.
 *   1. Floor tools (read/write/edit/shell/search) are the seat's inherent
 *      surface (stratum 1) — skills neither grant nor remove them; they only
 *      bias preference (toolWeights) and impose autonomy bounds.
 *   2. Off-floor surface (MCP/bridge tools) is OPT-IN: a seat may reach MCP
 *      bridge X ONLY if a bound skill grants X. No grant → DENY, regardless of
 *      mode. This is the only place a skill *withholds*.
 *   3. A skill grant can NEVER lower a gate level or auto-approve a gated tool.
 *      evaluateSkillGrant returns at most { allow: true } meaning "licensed —
 *      now proceed to the mode gate", or { allow: false } meaning "not licensed
 *      — deny before the gate". It cannot return "approved".
 * "Wear the deploy skill" therefore can never become "skip the gate".
 */

/**
 * Resolve a seat's effective grants from its bound skills.
 *
 * @param {object[]} skills  skill objects (from skill-registry getSkill)
 * @returns {{
 *   toolWeights: Record<string,number>,   // preference bias (floor stays inherent)
 *   mcpBridges: Set<string>,              // OFF-FLOOR surface this seat is licensed for
 *   autonomy: { maxDepth:number, maxBudgetTokens:number, sandboxRequired:boolean, requiresIntrospector:boolean },
 *   invariants: string[],
 *   skillIds: string[],
 * }}
 */
export function resolveSeatGrants(skills = []) {
  const toolWeights = {};
  const mcpBridges = new Set();
  const invariants = [];
  const seenInv = new Set();
  const autonomy = { maxDepth: Infinity, maxBudgetTokens: Infinity, sandboxRequired: false, requiresIntrospector: false };

  for (const s of skills) {
    if (!s) continue;
    for (const [tool, w] of Object.entries(s.toolWeights || {})) {
      toolWeights[tool] = Math.max(toolWeights[tool] ?? 0, w);
    }
    for (const b of s.bridges || []) {
      if (b?.bridgeId) mcpBridges.add(b.bridgeId);
    }
    for (const inv of s.invariants || []) {
      if (!seenInv.has(inv)) { seenInv.add(inv); invariants.push(inv); }
    }
    const a = s.autonomy || {};
    if (a.maxDepth !== undefined) autonomy.maxDepth = Math.min(autonomy.maxDepth, a.maxDepth);
    if (a.maxBudgetTokens !== undefined) autonomy.maxBudgetTokens = Math.min(autonomy.maxBudgetTokens, a.maxBudgetTokens);
    if (a.sandboxRequired) autonomy.sandboxRequired = true;
    if (a.requiresIntrospector) autonomy.requiresIntrospector = true;
  }

  if (autonomy.maxDepth === Infinity) autonomy.maxDepth = 0;
  if (autonomy.maxBudgetTokens === Infinity) autonomy.maxBudgetTokens = 20000;

  return {
    toolWeights,
    mcpBridges,
    autonomy,
    invariants,
    skillIds: skills.filter(Boolean).map((s) => s.id),
  };
}

/** Heuristic: is this tool name an off-floor MCP/bridge tool? MCP tools are
 *  namespaced "<bridgeId>__<tool>" or "<bridgeId>.<tool>" by the MCP client. */
export function isMcpTool(toolName) {
  return typeof toolName === "string" && /(__|\.)/.test(toolName);
}

/** Extract the bridge id from an MCP tool name ("<bridge>__<tool>" / "<bridge>.<tool>"). */
export function mcpBridgeOf(toolName) {
  if (typeof toolName !== "string") return null;
  const m = toolName.match(/^([^.]+)(?:__|\.)/) || toolName.match(/^(.+?)__/);
  return m ? m[1] : null;
}

/**
 * Evaluate whether a seat's skill grants LICENSE a tool call. Enforces the
 * DR-112 invariant: it may DENY an off-floor MCP call the seat is not licensed
 * for, but it can NEVER approve a gated tool or lower its gate level. The mode
 * gate runs AFTER this returns allow:true.
 *
 * @param {string} toolName
 * @param {object|null} grants  resolveSeatGrants output, or null (no skill layer → floor only)
 * @returns {{ allow: boolean, reason: string }}
 */
export function evaluateSkillGrant(toolName, grants) {
  // No skill layer bound → the floor governs; skills withhold nothing.
  if (!grants) return { allow: true, reason: "no skill layer bound; floor governs" };

  if (isMcpTool(toolName)) {
    const bridge = mcpBridgeOf(toolName);
    if (bridge && grants.mcpBridges.has(bridge)) {
      return { allow: true, reason: `licensed for MCP bridge "${bridge}" by a bound skill — proceeds to the mode gate` };
    }
    return { allow: false, reason: `seat is not licensed for MCP bridge "${bridge}" — no bound skill grants it (DR-112: off-floor access is opt-in)` };
  }

  // Floor tools: always licensed (stratum 1). Skills bias, never block the floor.
  return { allow: true, reason: "floor tool — inherent to the seat; subject to the mode gate" };
}

/** Render the [Skills] frame block from a seat's bound skills. Null when none. */
export function renderSkillsBlock(skills = []) {
  const real = skills.filter(Boolean);
  if (real.length === 0) return null;
  const lines = ["[Skills]", "You are licensed with the following competences (they shape how you work and what you may reach for; they never lift the operator's gate):"];
  for (const s of real) {
    lines.push(`- ${s.name}: ${s.description}`);
  }
  const grants = resolveSeatGrants(real);
  if (grants.mcpBridges.size > 0) {
    lines.push(`Granted external access: ${[...grants.mcpBridges].join(", ")} (each call is still gated).`);
  }
  if (grants.invariants.length > 0) {
    lines.push(`Invariants you must hold: ${grants.invariants.join("; ")}.`);
  }
  return lines.join("\n");
}

export default { resolveSeatGrants, evaluateSkillGrant, renderSkillsBlock, isMcpTool, mcpBridgeOf };
