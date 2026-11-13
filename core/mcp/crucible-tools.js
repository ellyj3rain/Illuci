/**
 * illuci/core/mcp/crucible-tools.js — the illuci-side binding of the cross-harness crucible discipline.
 *
 * The crucible is a single decision-elicitation discipline (`~/.claude/skills/crucible/SKILL.md` for
 * the human-readable canonical statement; `illuci/core/skills/crucible/crucible.discipline.js` for the
 * machine-readable twin). The discipline is harness-neutral reasoning; what differs per harness is
 * only the operator-decision SURFACE it binds to:
 *
 *   - the Claude harness binds it to the AskUserQuestion tool;
 *   - THIS module binds the SAME discipline to illuci's operator-decision surface — the MCP
 *     `elicitation/create` request, reached in a tool handler via `ctx.elicit({ message,
 *     requestedSchema })`, which resolves to `{ action: 'accept' | 'decline' | 'cancel', content? }`.
 *
 * Two verbs, mirroring the discipline's read half and its surface half:
 *
 *   crucible_classify_v1 — READ-SHAPED. Runs the discipline's Step 0 skip-gate, Step 1
 *     continuum-check, and Step 2 shape-classification on a described decision, returning the routing
 *     verdict (skip / continuum / point / architecture / tree / batch) plus the rendering constraints.
 *     Pure, no side effects, no gate (the same property that qualifies the composition resolvers for
 *     Tier-1). A illuci seat (or Claude via illuci_intent_v1) calls this to learn which form a decision is,
 *     before surfacing anything.
 *
 *   crucible_elicit_v1 — SURFACE-BOUND. Renders one classified decision to the operator through
 *     illuci's decision surface and returns the operator's choice. Recommendation-first and recursive by
 *     contract (the result names the next-decision obligation). Fail-closed: when the host has no
 *     elicitation surface, or the operator declines/cancels, no decision is fabricated — the verb
 *     returns `answered:false` with the reason, exactly as illuci's gate fails closed. This is the
 *     structural twin of AskUserQuestion: same forms, same recommend-always invariant, illuci's surface.
 *
 * BICAMERAL BRIDGE: Claude reaches these verbs through the existing `illuci_intent_v1` entry spine and
 * the `illuci-orchestration` umbrella's `crucible.*` subskills, so a Claude session can drive a decision
 * through ILLUCI's operator surface (e.g. when the operator is watching the illuci TUI / IDE rather than the
 * Claude pane), and a illuci seat can run the same discipline natively. One discipline, two surfaces.
 *
 * @module core/mcp/crucible-tools
 */

import {
  classifyDecision,
  normalizeOptions,
  CRUCIBLE_FORMS,
  CONTINUUM,
  RECURSION_RULE,
} from "../skills/crucible/crucible.discipline.js";

/** Build the recursion obligation the discipline attaches to every answered decision. */
function recursionObligation() {
  return {
    mustRecurse: true,
    rule: RECURSION_RULE.rule,
    note: "take this answer as input and re-classify for the next decision it surfaces; do not hand back to prose/execution while a real operator-decision remains open.",
  };
}

/**
 * Render one classified decision through illuci's operator-decision surface (`ctx.elicit`). Fail-closed:
 * no surface, or anything but an explicit accept, yields `answered:false`. The recommended option is
 * placed first per the discipline; the elicitation schema offers the option set plus a free-text
 * "other" path (the surface's operator-supplied-path affordance).
 */
async function elicitDecision(ctx, { question, form, options, parameter }) {
  if (!ctx || typeof ctx.elicit !== "function") {
    return {
      answered: false,
      reason: "host has no elicitation surface (operator-decision surface unavailable); the discipline fails closed rather than fabricating a choice",
    };
  }

  const normalized = normalizeOptions(options);
  const enumLabels = normalized.map((o) => o.label);
  const requestedSchema = {
    type: "object",
    properties: {
      choice: {
        type: "string",
        title: question,
        description: form === CONTINUUM
          ? `Spectrum decision. Parameter: ${parameter?.name || "(unnamed)"}; range: ${parameter?.range || "(unstated)"}. The principled default is offered first.`
          : "Pick one. The recommended option is first.",
        ...(enumLabels.length ? { enum: enumLabels } : {}),
      },
      other: { type: "string", description: "An operator-supplied path not listed above (leave empty to choose from the list)." },
    },
    required: ["choice"],
  };

  const res = await ctx.elicit({
    message: renderMessage({ question, form, options: normalized, parameter }),
    requestedSchema,
  });

  const accepted = !!res && res.action === "accept";
  if (!accepted) {
    return {
      answered: false,
      action: res?.action || "cancel",
      reason: `operator did not accept (action: ${res?.action || "cancel"}); fail-closed — no decision recorded`,
    };
  }

  const content = res.content || {};
  const picked = (typeof content.other === "string" && content.other.trim()) ? content.other.trim() : content.choice;
  return {
    answered: true,
    choice: picked,
    viaOther: !!(typeof content.other === "string" && content.other.trim()),
    recommendedWas: normalized.find((o) => o.recommended)?.label ?? null,
    overrodeRecommendation: normalized.length > 0 && picked !== (normalized.find((o) => o.recommended)?.label ?? null),
  };
}

/** Compose the human-facing elicitation message: the question, the form, and the recommendation-first option list. */
function renderMessage({ question, form, options, parameter }) {
  const head = `[crucible:${form}] ${question}`;
  if (form === CONTINUUM) {
    return `${head}\nParameter: ${parameter?.name || "(unnamed)"} | range: ${parameter?.range || "(unstated)"} | principled default: ${parameter?.principledDefault || "(unstated)"}`;
  }
  if (!options || !options.length) return head;
  const lines = options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
  return `${head}\n${lines.join("\n")}`;
}

export const CRUCIBLE_TOOLS = [
  {
    name: "crucible_classify_v1",
    schema_version: "1.0.0",
    description:
      "Classify a decision against the cross-harness crucible discipline: run the skip-gate, the " +
      "continuum-check, and shape-classification, returning the routing verdict (skip / continuum / " +
      "point / architecture / tree / batch) plus the rendering constraints. Read-only and pure — no " +
      "operator surface, no side effects. Call this to learn which form a decision is before surfacing it.",
    // Read-shaped, pure: no requiredActions (raises no gate concern at the boundary, like the
    // composition resolvers — the property that qualifies it for an unrestricted Tier-1 surface).
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision to classify (a one-line statement of the fork)." },
        settled: { type: "boolean", description: "Skip-gate: the decision is already settled/ratified." },
        pureNaming: { type: "boolean", description: "Skip-gate: operator-arbitrary naming with no architectural alternative." },
        trivial: { type: "boolean", description: "Skip-gate: decidable in a second of judgment." },
        spectrum: { type: "boolean", description: "Continuum-check: the real answer is a parameter/spectrum, not a discrete pick." },
        architectural: { type: "boolean", description: "Hint: genuinely distinct system shapes are in play." },
        interdependent: { type: "boolean", description: "Hint: many decisions interdepend (a plan walk)." },
        shape: { type: "string", enum: [...Object.values(CRUCIBLE_FORMS)], description: "Optional explicit shape hint." },
        optionCount: { type: "number", description: "How many genuinely-distinct options exist." },
        backlogSize: { type: "number", description: "How many already-mapped independent decisions are queued (10+ routes to batch)." },
      },
      required: ["question"],
    },
    async handler(args = {}) {
      const { question } = args;
      if (!question || typeof question !== "string") {
        throw new Error("crucible_classify_v1: question (string) is required");
      }
      const verdict = classifyDecision(args);
      return {
        question,
        ...verdict,
        recursion: recursionObligation(),
      };
    },
  },
  {
    name: "crucible_elicit_v1",
    schema_version: "1.0.0",
    description:
      "Surface one decision to the operator through illuci's operator-decision surface (MCP elicitation) " +
      "and return the operator's choice — the illuci-harness twin of AskUserQuestion. Classifies first " +
      "(skip-gate + continuum-check + shape), then renders recommendation-first with an operator- " +
      "supplied 'other' path. Fail-closed: no elicitation surface, or a decline/cancel, returns " +
      "answered:false (no fabricated choice). Recursive by contract — the result names the next- " +
      "decision obligation. A skip-gated or spectrum decision returns its verdict WITHOUT prompting.",
    // Surfaces a decision to the operator (an elicitation round-trip) but performs NO substrate
    // mutation and dispatches nothing to the fleet — it asks. It therefore raises no shell/file
    // requiredActions; the operator-pause IS the safety surface. (The gate posture still governs any
    // downstream action the answer leads to; this verb only obtains the answer.)
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision to surface (a one-line statement of the fork)." },
        options: {
          type: "array",
          description: "The options to offer (2-4 for point/architecture). One SHOULD be marked recommended; it is placed first.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "The option label." },
              description: { type: "string", description: "What this option means / its trade." },
              recommended: { type: "boolean", description: "Mark exactly one option recommended." },
            },
            required: ["label"],
          },
        },
        parameter: {
          type: "object",
          description: "For a spectrum decision: the parameter, its range, and the principled default (in place of discrete options).",
          properties: {
            name: { type: "string" },
            range: { type: "string" },
            principledDefault: { type: "string" },
          },
        },
        settled: { type: "boolean" },
        pureNaming: { type: "boolean" },
        trivial: { type: "boolean" },
        spectrum: { type: "boolean" },
        architectural: { type: "boolean" },
        interdependent: { type: "boolean" },
        shape: { type: "string", enum: [...Object.values(CRUCIBLE_FORMS)] },
        backlogSize: { type: "number" },
      },
      required: ["question"],
    },
    async handler(args = {}, ctx = {}) {
      const { question, options = [], parameter } = args;
      if (!question || typeof question !== "string") {
        throw new Error("crucible_elicit_v1: question (string) is required");
      }

      // Classify first — the discipline's gates run before anything is surfaced.
      const verdict = classifyDecision(args);

      // Skip-gated decisions are never surfaced; return the verdict so the caller acts on it.
      if (verdict.route === "skip") {
        return { question, surfaced: false, ...verdict, recursion: recursionObligation() };
      }

      // A spectrum decision surfaces the principled default + the dial, not a forced binary.
      if (verdict.route === CONTINUUM) {
        const outcome = await elicitDecision(ctx, { question, form: CONTINUUM, options: [], parameter });
        return { question, surfaced: true, form: CONTINUUM, ...verdict, outcome, recursion: recursionObligation() };
      }

      // A large mapped backlog routes to batch-discharge (mass-assault); this single-decision verb
      // declines to fire it four-at-a-time and names the route instead.
      if (verdict.route === CRUCIBLE_FORMS.BATCH) {
        return {
          question,
          surfaced: false,
          ...verdict,
          handoff: "mass-assault: lay the whole mapped battery out as one flat numbered list with recommendations pre-marked; do not fire it through one-decision elicitation.",
          recursion: recursionObligation(),
        };
      }

      // Point / architecture / tree-node: surface this one decision through illuci's operator surface.
      const outcome = await elicitDecision(ctx, { question, form: verdict.form, options, parameter });
      return { question, surfaced: true, form: verdict.form, ...verdict, outcome, recursion: recursionObligation() };
    },
  },
];

export default { CRUCIBLE_TOOLS };
