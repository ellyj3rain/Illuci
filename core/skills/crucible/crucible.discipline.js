/**
 * illuci/core/skills/crucible/crucible.discipline.js — the harness-neutral crucible discipline.
 *
 * THE SINGLE SOURCE OF TRUTH for the decision-elicitation discipline, expressed as data
 * (not as one harness's prose). Both harnesses consume THIS:
 *
 *   - the Claude harness reads the discipline semantically from `~/.claude/skills/crucible/SKILL.md`
 *     and binds it to the AskUserQuestion tool;
 *   - the illuci harness imports THIS module and binds the same discipline to illuci's operator-decision
 *     surface (MCP `elicitation/create`, reached via `ctx.elicit` — see illuci/core/mcp/crucible-tools.js).
 *
 * The discipline is harness-neutral reasoning: the continuum gate, the four forms, the
 * recommend-always invariant, and the recursion rule do not depend on which surface renders the
 * question. What differs per harness is ONLY the surface the discipline binds to. Keeping the
 * discipline here as data means the two bindings cannot drift on the substance: they render the
 * same forms, enforce the same invariants, and route by the same rules.
 *
 * The crucible SKILL.md (user-global) remains the human-readable canonical statement; this module
 * is its machine-readable twin for the programmatic (illuci) harness. When the discipline changes,
 * both move together — the SKILL.md for the Claude side, this module for the illuci side.
 *
 * @module illuci/core/skills/crucible/crucible.discipline
 */

/** The crucible forms. Each is a distinct decision shape; the binding renders the matching surface. */
export const CRUCIBLE_FORMS = Object.freeze({
  /** One fork — binary confirmation, multi-select on orthogonal axes, a sequencing choice, a mid-workflow branch. */
  POINT: "point",
  /** Genuinely distinct system shapes — up to four fully-specified, meaningfully-different designs. */
  ARCHITECTURE: "architecture",
  /** Multi-decision plan walk — many interdependent decisions stress-tested one at a time. */
  TREE: "tree",
  /** A large backlog of already-mapped, independent decisions — hand to the mass-assault batch-discharge. */
  BATCH: "batch",
});

/** A spectrum answer is not a form: it routes to the continuum default rather than a discrete pick. */
export const CONTINUUM = "continuum";

/** The invariants every form honors, regardless of harness. */
export const CRUCIBLE_INVARIANTS = Object.freeze([
  "recursion: after every answer, re-evaluate for the next decision and re-fire; never one-shot.",
  "recommendation-always: every question carries the recommended option/answer, placed first and labeled (Recommended).",
  "surface-always: never flat prose for a real decision needing operator input; render it through the harness's operator-decision surface.",
  "options-span-the-space: never padded to fill a count with filler; if only two real alternatives exist, present two.",
  "use-other: leverage the surface's operator-supplied-path affordance rather than guessing an option the operator did not offer.",
]);

/**
 * Step 0 — the skip-gate. A decision matching any of these is NOT surfaced.
 * The binding evaluates these (or has its caller assert them) before rendering anything.
 */
export const SKIP_GATE = Object.freeze([
  { id: "settled", test: "the decision is already settled or ratified", action: "do not re-prompt" },
  { id: "naming", test: "the decision is pure naming (operator-arbitrary; no architectural alternative to compare)", action: "state the candidates and wait; do not force a choice unless the operator asks" },
  { id: "trivial", test: "the decision is trivially decidable in a second of judgment", action: "pick and move" },
]);

/**
 * Step 1 — the continuum-check (the universal first gate). Before classifying a shape, ask whether
 * the real answer is a spectrum/parameter rather than a discrete pick. When it is a spectrum, do NOT
 * manufacture discrete alternatives — name the parameter, its range, and the principled default.
 */
export const CONTINUUM_CHECK = Object.freeze({
  question: "is the real answer a spectrum/parameter (each candidate more/less of the same thing), or a genuinely discrete pick (each a different shape)?",
  onSpectrum: {
    route: CONTINUUM,
    surface: ["parameter", "range", "principledDefault"],
    rule: "forcing a spectrum into A-vs-B erases the valid middle (the fake binary the platform-coherence discipline guards against).",
  },
  onDiscrete: { route: "classify", next: "Step 2 — classify the shape, pick the form" },
});

/**
 * Step 2 — the routing table. Maps a decision's shape to its form and the rendering constraints the
 * binding applies. `maxOptions` is the recommended ceiling per render; `recommendedFirst` is invariant.
 */
export const FORM_ROUTING = Object.freeze({
  [CRUCIBLE_FORMS.POINT]: {
    when: "binary confirmation, multi-select on orthogonal axes, sequencing, a mid-workflow branch",
    maxOptions: 4,
    multiSelect: "true when choices are NOT mutually exclusive (orthogonal axes); else false",
    parallelQuestions: "up to 4 independent simultaneous points in one render",
    recommendedFirst: true,
  },
  [CRUCIBLE_FORMS.ARCHITECTURE]: {
    when: "design/architectural deliberations where each option is a concrete, fully-specified, meaningfully-different design",
    maxOptions: 4,
    distinctness: "each option must produce a meaningfully different artifact or system shape; graded variants of one idea are a continuum, not distinct alternatives",
    padding: "if only two real alternatives exist, present two — never pad to four with weak filler",
    recommendedFirst: true,
  },
  [CRUCIBLE_FORMS.TREE]: {
    when: "stress-testing a whole plan/design where many decisions interdepend (grill-me / plan-this-out / deliberate-the-whole-thing)",
    walk: "one question at a time; resolve dependencies in order (upstream first, its answer constrains downstream)",
    batchSiblings: "batch independent sibling questions (up to 4 in one render); serialize only where genuinely dependent",
    exploreFirst: "if a question can be answered by exploring the codebase, explore instead of asking",
    terminus: "at pipeline scale, a ratified Markdown specification (transcript-evidenced decisions + a decision-registry entry + dual-TZ time metadata); for a short walk, the resolved answers are the terminus",
    recommendedFirst: true,
  },
  [CRUCIBLE_FORMS.BATCH]: {
    when: "roughly 10+ already-mapped, independent decisions piled up at once",
    route: "hand to the mass-assault skill (this router's batch-discharge leaf): one flat numbered battery with recommendations pre-marked, cleared in a single 'all rec except ...' pass",
    reentry: "mass-assault re-enters this router for any battery item that turns out to be a deep/interdependent fork — that item escalates to a Point/Architecture/Tree walk, then returns to the battery",
    recommendedFirst: true,
  },
});

/**
 * Step 3 — the recursion rule (mandatory, every form). After the operator answers, take the answer
 * as input and return to Step 0 for the next decision it surfaces. Exit only when no real
 * operator-decision remains.
 */
export const RECURSION_RULE = Object.freeze({
  rule: "after every answer, re-evaluate for the next decision the answer surfaces and re-fire; firing once and stopping is the primary failure mode.",
  constrains: "the answer constrains the next question — an 'all of the above' or combination answer surfaces a sequencing/priority decision, not silence.",
  explore: "resolve sub-decisions a tool can answer by exploring the codebase, not by firing.",
  exit: "exit the loop only when no real operator-decision remains; then proceed to prose or execution.",
});

/**
 * Classify a decision against the discipline. Harness-neutral and side-effect-free: returns the
 * routing verdict (skip / continuum / a form) plus the rendering constraints the binding applies.
 * This is the read-shaped core both bindings call before they render anything.
 *
 * @param {object} decision
 * @param {boolean} [decision.settled]      — the decision is already settled/ratified
 * @param {boolean} [decision.pureNaming]   — operator-arbitrary naming, no architectural alternative
 * @param {boolean} [decision.trivial]      — decidable in a second of judgment
 * @param {boolean} [decision.spectrum]     — the real answer is a parameter/spectrum, not a discrete pick
 * @param {string}  [decision.shape]        — caller's shape hint: one of CRUCIBLE_FORMS values
 * @param {number}  [decision.optionCount]  — how many genuinely-distinct options exist
 * @param {number}  [decision.backlogSize]  — how many already-mapped independent decisions are queued
 * @returns {{ route: string, form?: string, skip?: string, constraints?: object, reason: string }}
 */
export function classifyDecision(decision = {}) {
  // Step 0 — skip-gate.
  if (decision.settled) return { route: "skip", skip: "settled", reason: "already settled/ratified — do not re-prompt" };
  if (decision.pureNaming) return { route: "skip", skip: "naming", reason: "pure naming (operator-arbitrary) — state candidates and wait" };
  if (decision.trivial) return { route: "skip", skip: "trivial", reason: "trivially decidable — pick and move" };

  // Step 1 — continuum-check (the universal first gate).
  if (decision.spectrum) {
    return {
      route: CONTINUUM,
      reason: "the answer is a spectrum/parameter — name the parameter, its range, and the principled default rather than manufacturing discrete options",
      constraints: { surface: CONTINUUM_CHECK.onSpectrum.surface },
    };
  }

  // A large mapped backlog routes to batch-discharge regardless of the per-item shape.
  if (typeof decision.backlogSize === "number" && decision.backlogSize >= 10) {
    return { route: CRUCIBLE_FORMS.BATCH, form: CRUCIBLE_FORMS.BATCH, constraints: FORM_ROUTING[CRUCIBLE_FORMS.BATCH], reason: "roughly 10+ mapped independent decisions — hand to mass-assault batch-discharge" };
  }

  // Step 2 — classify the discrete shape.
  const shape = decision.shape && CRUCIBLE_FORMS[String(decision.shape).toUpperCase()]
    ? String(decision.shape).toLowerCase()
    : inferShape(decision);
  return { route: shape, form: shape, constraints: FORM_ROUTING[shape], reason: `discrete decision classified as ${shape}` };
}

/** Infer a form when the caller gave no explicit shape hint. Conservative: defaults to point. */
function inferShape(decision) {
  if (typeof decision.backlogSize === "number" && decision.backlogSize >= 10) return CRUCIBLE_FORMS.BATCH;
  if (decision.interdependent || decision.planWalk) return CRUCIBLE_FORMS.TREE;
  if (decision.architectural) return CRUCIBLE_FORMS.ARCHITECTURE;
  return CRUCIBLE_FORMS.POINT;
}

/**
 * Normalize an option list to the recommend-always + recommended-first invariant. Harness-neutral:
 * the binding renders the result through its own surface. Marks the recommended option first and
 * labels it "(Recommended)" without duplicating the label if the caller already set it.
 *
 * @param {Array<{label: string, description?: string, recommended?: boolean}>} options
 * @returns {Array<{label: string, description?: string, recommended: boolean}>}
 */
export function normalizeOptions(options = []) {
  const list = Array.isArray(options) ? options.map((o) => ({ ...o, recommended: !!o.recommended })) : [];
  const recIdx = list.findIndex((o) => o.recommended);
  const ordered = recIdx > 0 ? [list[recIdx], ...list.slice(0, recIdx), ...list.slice(recIdx + 1)] : list;
  return ordered.map((o, i) => ({
    ...o,
    recommended: i === 0 ? (recIdx >= 0 ? true : o.recommended) : false,
    label: i === 0 && (recIdx >= 0) && !/\(recommended\)/i.test(o.label || "") ? `${o.label} (Recommended)` : o.label,
  }));
}

export default {
  CRUCIBLE_FORMS,
  CONTINUUM,
  CRUCIBLE_INVARIANTS,
  SKIP_GATE,
  CONTINUUM_CHECK,
  FORM_ROUTING,
  RECURSION_RULE,
  classifyDecision,
  normalizeOptions,
};
