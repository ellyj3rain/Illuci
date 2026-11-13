/**
 * illuci — Seat Frame (the single seat-message composition site)
 *
 * M1 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3, tier 4).
 * Replaces the five hand-assembled `msg` sites in runner.js with ONE fixed
 * block order, every seat, every turn:
 *
 *   [Mandate]                — operator identity + verbatim ask (mandate.js).
 *                              ALWAYS FIRST; token-reserved by position.
 *   [Seat lens]              — the seat rendered FROM its relationship edges,
 *                              explicitly subordinate to the mandate (the
 *                              escape clause). The previously-dead edge data
 *                              goes live here as in-prompt addressing.
 *   [Behavioral Disposition] — verbatim block from the canonical resolver
 *                              (composed by the caller; placed here so it
 *                              reads as "how I lean", before the task).
 *   [Task]                   — the resolved step input ONLY. The operator's
 *                              ask no longer rides (or dies) with this block.
 *   <mode suffix>            — getModePromptSuffix output, unchanged.
 *   [Operator Injection]     — drained mid-run injections, unchanged channel.
 *
 * [You] (identity + persona-memory digest) and [Skills] slots land at M5/M6
 * (memory strata / skill framework); the block order already reserves their
 * positions so their arrival is additive.
 *
 * composeSeatFrame is PURE (string in, string out) — the runner resolves
 * disposition/injections and passes them in, keeping this trivially testable.
 *
 * Relationship: composition/resolve-agent.js remains the preamble-LAYER shim
 * (world/voice/disposition). The frame is the seat-MESSAGE composer that
 * consumes the disposition layer's output. The two converge at M5 when
 * resolveAgent's memory/role slots open.
 */

import { renderMandateBlock } from "./mandate.js";

/** Human verb phrases for the relationship edge vocabulary (index.js). */
const EDGE_PHRASES = {
  "parent-of": "you direct",
  "child-of": "you report to",
  "peer-of": "you work alongside",
  "adversarial-to": "you challenge",
  "mentors": "you mentor",
  "mentored-by": "you are mentored by",
  "evaluates": "you evaluate",
  "evaluated-by": "you are evaluated by",
  "critiques": "you critique",
  "informs": "you inform",
  "oversees": "you oversee",
  "integrates-from": "you integrate the work of",
  "precedes": "your output feeds",
  "audits": "you audit",
  "defends-against": "you defend against",
};

/**
 * Render the [Seat lens] block from the seat's typed relationship edges.
 * The lens is explicitly subordinate to the mandate — the escape clause is
 * the load-bearing sentence (collaborator-first, fixed point 2).
 *
 * @param {object} seatDef    topology seat definition ({ id, label, relationships })
 * @param {Map<string,string>|object} seatLabels  seatId → label lookup
 * @param {string|null} assignment  per-participant assignment note (parallel phases)
 */
export function renderSeatLens(seatDef, seatLabels = {}, assignment = null) {
  if (!seatDef) return "";
  const label = seatDef.label || seatDef.id;
  const labelOf = (id) =>
    (seatLabels instanceof Map ? seatLabels.get(id) : seatLabels[id]) || id;

  const lines = [`[Seat lens]`, `In this council you sit as the "${label}"${assignment ? ` (assigned: ${assignment})` : ""}.`];

  const edges = seatDef.relationships || [];
  if (edges.length > 0) {
    const rels = edges
      .map((r) => {
        const phrase = EDGE_PHRASES[r.type] || `you relate (${r.type}) to`;
        return `${phrase} ${labelOf(r.target)}`;
      })
      .join("; ");
    lines.push(`Your working relationships: ${rels}.`);
  }

  lines.push(
    `The seat is a lens that biases your contribution - it does not limit your competence. ` +
    `If performing the seat conflicts with the mandate, the mandate wins: say so instead of performing.`,
  );
  return lines.join("\n");
}

/**
 * Render the [You] block — collaborator-first identity + the persona's
 * accrued per-project memory digest (stratum 3 recall, M5). Returns null
 * when there is nothing to say (no digest), so the frame degrades cleanly
 * for unbound seats and fresh projects.
 *
 * @param {string} agentSlug
 * @param {object|null} digest  loadPersonaDigest output ({ summary, … }) or null
 */
export function renderYouBlock(agentSlug, digest) {
  if (!agentSlug) return null;
  const lines = [`[You]`, `You are "${agentSlug}" — a capable collaborator first; your seat and role are how you contribute here, not the limit of what you are.`];
  if (digest?.summary) lines.push(digest.summary);
  return lines.join("\n");
}

/**
 * Compose the full framed seat message. Pure.
 *
 * @param {object} input
 * @param {object} input.mandate           the run mandate (mandate.js)
 * @param {object} [input.seatDef]         topology seat definition
 * @param {Map|object} [input.seatLabels]  seatId → label lookup for edge rendering
 * @param {string|null} [input.assignment] per-participant assignment note
 * @param {string|null} [input.dispositionBlock]  "[Behavioral Disposition]\n…" or null
 * @param {string} input.task              the resolved step input (the [Task] body)
 * @param {string} [input.modeSuffix]      getModePromptSuffix output ("" if none)
 * @param {string[]} [input.injections]    drained operator injections (contents)
 * @param {boolean} [input.includeLens=true]  false for auxiliary dispatches (e.g.
 *                                            the rotating merge step) that still
 *                                            must carry the mandate
 * @returns {string}
 */
export function composeSeatFrame({
  mandate,
  seatDef = null,
  seatLabels = {},
  assignment = null,
  youBlock = null,
  cognitiveBlock = null,
  dispositionBlock = null,
  skillsBlock = null,
  skillFrameworksBlock = null,
  awarenessBlock = null,
  workspaceBlock = null,
  task,
  modeSuffix = "",
  injections = [],
  includeLens = true,
} = {}) {
  const blocks = [];

  const mandateBlock = renderMandateBlock(mandate);
  if (mandateBlock) blocks.push(mandateBlock);

  if (youBlock) blocks.push(youBlock);

  if (includeLens && seatDef) {
    blocks.push(renderSeatLens(seatDef, seatLabels, assignment));
  }

  if (cognitiveBlock) blocks.push(cognitiveBlock);

  if (dispositionBlock) blocks.push(dispositionBlock);

  // [Skills] — after disposition (how I lean), before the task (what to do).
  if (skillsBlock) blocks.push(skillsBlock);

  if (skillFrameworksBlock) blocks.push(skillFrameworksBlock);

  // [Cross-Team Awareness] — what the other teams in this company have done, read
  // before the task so the seat can stay coherent with concurrent topologies.
  if (awarenessBlock) blocks.push(awarenessBlock);

  // [Workspace context] records what the runner actually supplied. It prevents
  // single-shot seats from implying live file inspection when no tool loop is active.
  if (workspaceBlock) blocks.push(workspaceBlock);

  blocks.push(`[Task]\n${task ?? ""}${modeSuffix || ""}`);

  if (injections && injections.length > 0) {
    blocks.push(`[Operator Injection]\n${injections.join("\n")}`);
  }

  return blocks.join("\n\n");
}

/** Build a seatId → label Map from a topology definition. */
export function buildSeatLabels(topology) {
  const m = new Map();
  for (const s of topology?.seats || []) m.set(s.id, s.label || s.id);
  return m;
}

export default { composeSeatFrame, renderSeatLens, renderYouBlock, buildSeatLabels };
