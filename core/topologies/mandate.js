/**
 * illuci — Mandate (the operator anchor of every dispatch)
 *
 * M1 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3, tier 4).
 * The Mandate is the run-scoped object that makes "who the operator is, what
 * they actually asked, and that every seat serves that ask" a STRUCTURAL
 * property of every dispatch, instead of a string that survives only where a
 * phase's input spec happens to say "prompt".
 *
 * Built once at the top of runTopology, threaded through dispatchOpts, and
 * rendered by composeSeatFrame (frame.js) as the first, token-reserved block
 * of every seat message in every phase.
 *
 * intent.raw is immutable except through reviseMandate (the operator's
 * "INTENT:" injection channel) — each revision bumps `revision` so later
 * steps can see the ask changed mid-run. The anchor's working brief is a
 * separate, optional field (conducted mode, M4) so the verbatim ask is never
 * paraphrased away.
 */

/**
 * Build the run mandate.
 *
 * @param {object} input
 * @param {string} input.prompt        the operator's verbatim request (immutable)
 * @param {string} [input.operator]    operator display identity
 * @param {string} [input.brief]       anchor's working brief (conducted mode; M4)
 * @param {string} [input.projectId]
 * @param {string} [input.topologyId]
 * @param {object} [input.fireControl] per-seat firing modes (the operator's baton)
 * @param {number} [input.stabilityThreshold]
 * @param {object} [input.repoLineage] dispatched repo lineage ({canonicalRoot,branch,worktreePath,remote}) the repo-authority gate verifies actual context against
 * @returns {object} mandate
 */
export function buildMandate({
  prompt,
  operator = "the operator",
  brief = null,
  projectId = null,
  topologyId = null,
  fireControl = null,
  stabilityThreshold = null,
  repoLineage = null,
} = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("buildMandate: a verbatim operator prompt is required");
  }
  return {
    operator: { name: operator },
    intent: {
      raw: prompt,
      brief,
      revision: 1,
      updatedAt: new Date().toISOString(),
    },
    project: { id: projectId },
    topology: { id: topologyId },
    posture: { fireControl, stabilityThreshold },
    repo: { lineage: repoLineage },
  };
}

/**
 * Revise the mandate's intent (operator INTENT: injection). Returns a NEW
 * mandate object — revisions are explicit, never silent mutation.
 */
export function reviseMandate(mandate, newIntent, { brief = null } = {}) {
  if (!mandate || !mandate.intent) throw new Error("reviseMandate: invalid mandate");
  if (typeof newIntent !== "string" || newIntent.length === 0) return mandate;
  return {
    ...mandate,
    intent: {
      raw: newIntent,
      brief: brief ?? mandate.intent.brief,
      revision: mandate.intent.revision + 1,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Render the [Mandate] block — the first block of every framed seat message.
 * Kept terse: the mandate is identity + verbatim ask + (optional) brief,
 * not a second system prompt.
 */
export function renderMandateBlock(mandate) {
  if (!mandate) return "";
  const rev = mandate.intent.revision > 1 ? ` (revised ×${mandate.intent.revision})` : "";
  const lines = [
    `[Mandate]`,
    `You serve ${mandate.operator.name}. Their request this run${rev}:`,
    mandate.intent.raw,
  ];
  if (mandate.intent.brief) {
    lines.push("", `Anchor's working brief: ${mandate.intent.brief}`);
  }
  return lines.join("\n");
}

export default { buildMandate, reviseMandate, renderMandateBlock };
