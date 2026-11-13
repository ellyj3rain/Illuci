/**
 * illuci — company-rounds: the ClashArtifact — the DETERMINISTIC, NON-EXPERT-LEGIBLE record
 * of one round's collision between the two adversarial bodies.
 *
 * EVERYTHING IN THIS FILE IS PURE + DETERMINISTIC. No LLM call, no embeddings, no
 * Math.random, no Date — the same inputs always produce byte-identical outputs. The clash
 * is ASSEMBLED FROM the company result the round already produced; it never dispatches and
 * never alters that result. (The heterogeneityProof is a CHEAP lexical token-overlap ratio,
 * NOT a semantic similarity — embeddings were explicitly rejected as over-engineered.)
 *
 * The clash is the surface a non-expert reads to see WHAT changed between the divergent body
 * (commune) and the convergent body (devStructure) in a round:
 *   - tension          — the headline framing of the disagreement
 *   - objection        — devStructure's push-back text (the convergent body's stance)
 *   - mutation         — commune's text (the divergent body's stance / proposed change)
 *   - carriedForward   — the stable hash of the round's settled content (the no-progress key)
 *   - collisionHunks   — a unified-diff hunk list between the two bodies (the literal delta)
 *   - heterogeneityProof — { ratio, cosmetic } cross-body token overlap (is the clash real?)
 */

/**
 * Deterministically extract ONE member's final text from the real company result/trace shape.
 *
 * The real shapes (grounded against company.js / node.js / runner.js):
 *   companyResult.members : [{ index, topologyId, runId, status, trace, error }]
 *   trace.phases          : { [phaseId]: { responses: [{ model, seat, response, error }] } }
 * The "final text" of a member is the concatenation of the LAST phase's non-empty responses
 * (a member's terminal product), joined deterministically. A member with no usable trace
 * yields "".
 *
 * @param {object} companyResult — the resolved orchestrate()/runCompany() result
 * @param {object} [memberSelector]
 * @param {string} [memberSelector.topologyId] — select the first member with this topologyId
 * @param {number} [memberSelector.index]      — select by member index
 * @returns {string} the member's final text (deterministic; "" when absent)
 */
export function extractMemberText(companyResult, memberSelector = {}) {
  const members = Array.isArray(companyResult?.members) ? companyResult.members : [];
  if (members.length === 0) return "";

  let member = null;
  if (memberSelector && Number.isInteger(memberSelector.index)) {
    member = members.find((m) => m && m.index === memberSelector.index) || null;
  }
  if (!member && memberSelector && typeof memberSelector.topologyId === "string") {
    member = members.find((m) => m && m.topologyId === memberSelector.topologyId) || null;
  }
  if (!member) member = members[0];

  return extractTraceText(member?.trace);
}

/** The terminal text of a topology trace: the last phase's non-empty responses, joined. */
function extractTraceText(trace) {
  if (!trace || typeof trace !== "object") return "";
  const phases = trace.phases && typeof trace.phases === "object" ? trace.phases : {};
  const keys = Object.keys(phases); // insertion order = phase execution order (runner.js)
  if (keys.length === 0) return "";
  const lastPhase = phases[keys[keys.length - 1]];
  const responses = Array.isArray(lastPhase?.responses) ? lastPhase.responses : [];
  return responses
    .map((r) => (r && typeof r.response === "string" ? r.response : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/** Split text into lines, dropping a single trailing empty line (deterministic). */
function toLines(text) {
  const s = typeof text === "string" ? text : "";
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Deterministic unified-diff hunk list between two texts. A line-level LCS produces the
 * shared backbone; the runs of added/removed lines between matched anchors become hunks.
 * Pure (no external diff lib, no clock) — the LCS table is a plain DP over line arrays.
 *
 * @returns {Array<{ communeStart, communeLines, devStart, devLines, removed, added }>}
 *   removed = lines present in commune but not dev; added = lines present in dev but not
 *   commune. Each hunk also carries 1-based start lines + line counts for the diff header.
 */
export function makeCollisionHunks(communeText, devText) {
  const a = toLines(communeText); // "commune" = the original/left side
  const b = toLines(devText);     // "dev" = the new/right side

  // LCS DP table over lines.
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk the table, emitting a flat op stream: "eq" | "del" | "add".
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "eq", line: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: "del", line: a[i] });
      i++;
    } else {
      ops.push({ op: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ op: "del", line: a[i] }); i++; }
  while (j < m) { ops.push({ op: "add", line: b[j] }); j++; }

  // Coalesce consecutive non-eq runs into hunks, tracking 1-based positions.
  const hunks = [];
  let aPos = 1;
  let bPos = 1;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === "eq") { aPos++; bPos++; k++; continue; }
    const communeStart = aPos;
    const devStart = bPos;
    const removed = [];
    const added = [];
    while (k < ops.length && ops[k].op !== "eq") {
      if (ops[k].op === "del") { removed.push(ops[k].line); aPos++; }
      else { added.push(ops[k].line); bPos++; }
      k++;
    }
    hunks.push({
      communeStart,
      communeLines: removed.length,
      devStart,
      devLines: added.length,
      removed,
      added,
    });
  }
  return hunks;
}

/** Deterministic word tokenization: lowercase, split on non-word runs, drop empties. */
function tokenize(text) {
  const s = typeof text === "string" ? text : "";
  if (s === "") return [];
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
}

/**
 * Cross-body token-overlap ratio (a CHEAP lexical heterogeneity proof — NOT semantic).
 * ratio = |shared unique tokens| / |union of unique tokens| (Jaccard over token sets).
 * cosmetic = ratio > maxTokenOverlap (the disagreement is too superficial to be real).
 *
 * Two empty texts are vacuously identical: ratio 1, cosmetic true (there is no real clash).
 *
 * @returns {{ ratio:number, cosmetic:boolean }}
 */
export function heterogeneityProof(communeText, devText, maxTokenOverlap = 0.85) {
  const setA = new Set(tokenize(communeText));
  const setB = new Set(tokenize(devText));
  if (setA.size === 0 && setB.size === 0) {
    return { ratio: 1, cosmetic: true };
  }
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  const ratio = union === 0 ? 1 : shared / union;
  return { ratio, cosmetic: ratio > maxTokenOverlap };
}

/**
 * Deterministic FNV-1a 32-bit hash of a string, rendered as 8 hex chars. Used for the
 * carriedForward stability key (the no-progress brake compares this hash across rounds).
 * Pure + dependency-free; no Node crypto, no clock.
 */
export function stableHash(text) {
  const s = typeof text === "string" ? text : "";
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit space via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Assemble the ClashArtifact for one round — PURE + DETERMINISTIC.
 *
 * @param {object} companyResult — the round's resolved orchestrate result
 * @param {object|null} priorClash — the previous round's clash (null on round 1)
 * @param {object} stopCondition — the normalized StopCondition (for maxTokenOverlap)
 * @param {number} round — 1-based round number
 * @param {string} sessionId — the round's company sessionId
 * @param {object} [selectors] — { commune, devStructure } member selectors
 * @returns {object} ClashArtifact
 */
export function assembleClashArtifact(companyResult, priorClash, stopCondition, round, sessionId, selectors = {}) {
  const communeSelector = selectors.commune || { index: 0 };
  const devSelector = selectors.devStructure || { index: 1 };

  const communeText = extractMemberText(companyResult, communeSelector);
  const devText = extractMemberText(companyResult, devSelector);

  const maxTokenOverlap = stopCondition && Number.isFinite(stopCondition.maxTokenOverlap)
    ? stopCondition.maxTokenOverlap : 0.85;

  const collisionHunks = makeCollisionHunks(communeText, devText);
  const proof = heterogeneityProof(communeText, devText, maxTokenOverlap);

  // carriedForward = the stable hash of the round's settled content (both bodies). The
  // no-progress brake compares this hash to the prior round's; an unchanged hash means the
  // bodies produced byte-identical content again (one of the triple-gate conditions).
  const carriedForward = stableHash(`${communeText}\0${devText}`);

  return {
    kind: "ClashArtifact",
    round,
    sessionId: sessionId ?? companyResult?.sessionId ?? null,
    // tension: the headline framing — deterministic, derived from the diff magnitude.
    tension: collisionHunks.length === 0
      ? "no divergence: the two bodies produced identical content"
      : `${collisionHunks.length} collision hunk(s) between commune and devStructure`,
    // objection: devStructure's stance (the convergent body's text).
    objection: devText,
    // mutation: commune's stance (the divergent body's proposed change).
    mutation: communeText,
    carriedForward,
    collisionHunks,
    heterogeneityProof: proof,
    // Filled later (advisory only) by round-evaluator.js; null until/unless an evaluator runs.
    evaluatorAdvice: null,
    // Filled by the loop after evaluateBrakes; null until the brakes decide.
    brakeTriggered: null,
  };
}

/**
 * Render a ClashArtifact as human-readable Markdown — the non-expert legibility surface.
 * Named sections: Tension / Objection / Mutation / Carried-forward, then the diff hunks.
 * Pure (string assembly only).
 *
 * @param {object} clash — a ClashArtifact
 * @returns {string} Markdown
 */
export function renderMarkdown(clash) {
  if (!clash || typeof clash !== "object") return "";
  const lines = [];
  lines.push(`# Clash — round ${clash.round ?? "?"}`);
  if (clash.sessionId) lines.push(`*session ${clash.sessionId}*`);
  lines.push("");

  lines.push("## Tension");
  lines.push(clash.tension || "(none)");
  lines.push("");

  lines.push("## Objection");
  lines.push("> devStructure (the convergent body)");
  lines.push("");
  lines.push(clash.objection ? clash.objection : "(empty)");
  lines.push("");

  lines.push("## Mutation");
  lines.push("> commune (the divergent body)");
  lines.push("");
  lines.push(clash.mutation ? clash.mutation : "(empty)");
  lines.push("");

  lines.push("## Carried-forward");
  lines.push(`content hash: \`${clash.carriedForward ?? "(none)"}\``);
  const proof = clash.heterogeneityProof || {};
  lines.push(
    `heterogeneity: token-overlap ratio ${typeof proof.ratio === "number" ? proof.ratio.toFixed(3) : "?"}` +
      ` — ${proof.cosmetic ? "COSMETIC (overlap above threshold)" : "substantive"}`,
  );
  if (clash.evaluatorAdvice != null) lines.push(`evaluator advice: ${clash.evaluatorAdvice}`);
  if (clash.brakeTriggered != null) lines.push(`brake: ${clash.brakeTriggered}`);
  lines.push("");

  lines.push("## Collision hunks");
  const hunks = Array.isArray(clash.collisionHunks) ? clash.collisionHunks : [];
  if (hunks.length === 0) {
    lines.push("(none — the two bodies are line-identical)");
  } else {
    for (const h of hunks) {
      lines.push(
        "```diff",
        `@@ -${h.communeStart},${h.communeLines} +${h.devStart},${h.devLines} @@`,
        ...(h.removed || []).map((l) => `-${l}`),
        ...(h.added || []).map((l) => `+${l}`),
        "```",
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

export default {
  extractMemberText,
  makeCollisionHunks,
  heterogeneityProof,
  stableHash,
  assembleClashArtifact,
  renderMarkdown,
};
