/**
 * illuci — Anchor (conducted half: a lead model plans the agenda FOR the operator)
 *
 * M4b of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3 tier 3
 * "conducted" + §4 + §9). The default anchor is the OPERATOR (anchor.mode
 * "operator": derived/ritual plan, no model call). The DELEGATED anchor
 * (anchor.mode "delegated" + modelId) is a lead model that holds the operator's
 * goal and proposes an agenda from the charter graph + the operator's request.
 *
 * AUTHORITY BOUNDS (DR-110 — the load-bearing safety property):
 * The agenda schema the anchor may emit is ONLY an ordered list of steps over
 * the charter's EXISTING seats. By construction the anchor therefore CANNOT:
 *   - introduce a seat not declared in the charter (validateAgenda rejects it);
 *   - grant itself or any seat a tool, skill, or MCP access (not in the schema);
 *   - change a seat's model, disposition, or permission posture;
 *   - alter or remove the operator's fire-control checkpoints (M4a, operator-owned);
 *   - escalate beyond reorder / skip / repeat of the declared seats.
 * A malformed or out-of-bounds plan is REJECTED and recorded; the run falls back
 * (conducted → derived → ritual) and never strands. The anchor proposes order;
 * it never widens the permission surface.
 *
 * planAgenda takes an injected `dispatch(modelId, prompt) → Promise<string>`
 * (the runner passes queryModel; tests pass a fake), so this module is pure of
 * any bridge dependency and hermetically testable.
 */

import { deriveAgenda } from "./conductor.js";

const VALID_TYPES = new Set(["single", "parallel"]);

/** Build the planning prompt: charter shape + the operator's verbatim ask. */
function buildPlanningPrompt(topology, mandate) {
  const seatLines = (topology.seats || []).map((s) => {
    const rels = (s.relationships || []).map((r) => `${r.type}→${r.target}`).join(", ");
    return `  - ${s.id} ("${s.label || s.id}")${rels ? ` [${rels}]` : ""}`;
  }).join("\n");
  const seatIds = (topology.seats || []).map((s) => s.id);

  return [
    `You are the ANCHOR of a "${topology.name}" working session, acting for the operator.`,
    `The operator's request: ${mandate?.intent?.raw ?? ""}`,
    ``,
    `The available seats (you may ONLY use these — you cannot invent seats, grant tools, or change anyone's permissions):`,
    seatLines,
    ``,
    `Produce an execution AGENDA: an ordered JSON plan of steps that best serves the operator's request using this organization. Each step:`,
    `  { "id": "<unique>", "type": "single"|"parallel", "seat": "<id>" | "seats": ["<id>", ...], "input": "prompt" | "phase:<priorStepId>" | "prompt+phase:<id>", "rationale": "<why this step, here>" }`,
    `Order should reflect the organization's relationships (who frames, who critiques, who integrates) AND the actual request. A seat may appear more than once (e.g. brief then synthesize).`,
    `Respond with ONLY a JSON object: { "brief": "<one-line restatement of the operator's goal in your words>", "plan": [ ...steps ] }. Seats MUST be from: ${seatIds.join(", ")}.`,
  ].join("\n");
}

/** Extract the first balanced JSON object from a model's text response. */
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * Validate a proposed agenda against the charter — the authority bounds.
 * @returns {{ valid: boolean, errors: string[], steps: object[] }}
 */
export function validateAgenda(plan, topology) {
  const errors = [];
  const seatIds = new Set((topology.seats || []).map((s) => s.id));
  const steps = Array.isArray(plan?.plan) ? plan.plan : Array.isArray(plan) ? plan : null;
  if (!steps || steps.length === 0) return { valid: false, errors: ["no steps"], steps: [] };

  const ids = new Set();
  const normalized = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const id = typeof s.id === "string" && s.id.length ? s.id : `step-${i}`;
    if (ids.has(id)) { errors.push(`duplicate step id "${id}"`); continue; }
    ids.add(id);

    if (!VALID_TYPES.has(s.type)) { errors.push(`step "${id}": invalid type "${s.type}"`); continue; }

    const seats = s.seats || (s.seat ? [s.seat] : []);
    if (seats.length === 0) { errors.push(`step "${id}": no seat(s)`); continue; }
    const bad = seats.filter((x) => !seatIds.has(x));
    if (bad.length) { errors.push(`step "${id}": seats not in charter: ${bad.join(", ")}`); continue; }

    // input must resolve: "prompt", "phase:<priorId>", or a "+" combination of those
    const input = typeof s.input === "string" && s.input.length ? s.input : "prompt";
    const parts = input.split("+").map((p) => p.trim());
    let inputOk = true;
    for (const p of parts) {
      if (p === "prompt" || p === "previous" || p === "shared-artifact") continue;
      const m = p.match(/^phase:(.+)$/);
      if (m && ids.has(m[1])) continue; // references a PRIOR step
      inputOk = false; errors.push(`step "${id}": input "${p}" does not resolve to prompt or a prior step`);
    }
    if (!inputOk) continue;

    normalized.push(
      seats.length === 1 && s.type === "single"
        ? { id, type: "single", seat: seats[0], input, rationale: s.rationale || null }
        : { id, type: "parallel", seats, input, rationale: s.rationale || null },
    );
  }

  if (normalized.length === 0) return { valid: false, errors: errors.length ? errors : ["no valid steps"], steps: [] };
  return { valid: errors.length === 0, errors, steps: normalized };
}

/**
 * [A17.6]/[A24.1] The ordered anchor-seat candidate walk — THE single statement
 * of the "the seat that would act FIRST plans first" rule: authored phase order
 * first, then declared seat order. Consumed by defaultAnchorModel (which resolves
 * the first candidate with a lineup entry) and by the governance manifest
 * (which records the first candidate as the topology's anchorSeat).
 *
 * @param {{phases?: object[], seats?: object[]}} topology
 * @returns {string[]} ordered seat-id candidates (may repeat; callers take first-match)
 */
export function anchorSeatCandidates(topology = {}) {
  const seatsOf = (p) => (Array.isArray(p?.seats) ? p.seats : p?.seat ? [p.seat] : []);
  const candidates = [];
  for (const p of (Array.isArray(topology.phases) ? topology.phases : [])) candidates.push(...seatsOf(p));
  for (const s of (Array.isArray(topology.seats) ? topology.seats : [])) candidates.push(s?.id);
  return candidates.filter((id) => typeof id === "string" && id.length > 0);
}

/**
 * [A17.6] The topology-derived default anchor (DR-114 run-start T): when
 * neither the caller nor the org names a delegated anchor, the seat that would
 * act FIRST plans first — the first seat of the first authored phase, resolved
 * to its lineup entry (a flat model id or an object-form selection; querySeat
 * handles both). Walks anchorSeatCandidates and returns the first seat with a
 * resolvable lineup entry. Deterministic — a seat-order read, not a capability
 * judgment. Returns null when the topology/lineup name no one (planAgenda then
 * falls back derived → ritual).
 *
 * @param {{phases?: object[], seats?: object[]}} topology
 * @param {Record<string, any>} lineup - normalized seat → model(s) map
 * @returns {any|null} the anchor's lineup entry, or null
 */
export function defaultAnchorModel(topology = {}, lineup = {}) {
  for (const seatId of anchorSeatCandidates(topology)) {
    const entry = lineup?.[seatId];
    const model = Array.isArray(entry) ? entry.find((x) => x != null && x !== "") : entry;
    if (model != null && model !== "") return model;
  }
  return null;
}

/**
 * Plan a conducted agenda. The delegated anchor model proposes; validateAgenda
 * enforces the bounds; on any failure we fall back to the deterministic derived
 * agenda, then ritual — recorded, never stranded.
 *
 * @param {object} input
 * @param {object} input.topology
 * @param {object} input.mandate
 * @param {string} input.anchorModelId
 * @param {(modelId:string, prompt:string)=>Promise<string>} input.dispatch
 * @returns {Promise<{ mode:string, steps:object[], rationale:string, brief:string|null, fallback:boolean, errors?:string[] }>}
 */
export async function planAgenda({ topology, mandate, anchorModelId, dispatch }) {
  const fallback = (reason, extra = {}) => {
    const derived = deriveAgenda(topology);
    if (derived) return { mode: "derived", steps: derived.steps, rationale: `conducted unavailable (${reason}); ${derived.rationale}`, brief: null, fallback: true, ...extra };
    return { mode: "ritual", steps: [...(topology.phases || [])], rationale: `conducted unavailable (${reason}); fell back to ritual`, brief: null, fallback: true, ...extra };
  };

  if (typeof dispatch !== "function" || !anchorModelId) return fallback("no delegated anchor configured");

  let text;
  try {
    text = await dispatch(anchorModelId, buildPlanningPrompt(topology, mandate));
  } catch (e) {
    return fallback(`anchor dispatch failed: ${e.message}`);
  }

  const plan = extractJson(text);
  if (!plan) return fallback("anchor returned no parseable plan");

  const { valid, errors, steps } = validateAgenda(plan, topology);
  if (steps.length === 0) return fallback(`anchor plan invalid: ${errors.join("; ")}`, { errors });

  return {
    mode: "conducted",
    steps,
    rationale: valid
      ? `conducted: agenda planned by anchor ${anchorModelId}`
      : `conducted: anchor plan accepted with ${errors.length} out-of-bounds step(s) dropped`,
    brief: typeof plan.brief === "string" ? plan.brief : null,
    fallback: false,
    ...(errors.length ? { errors } : {}),
  };
}

export default { planAgenda, validateAgenda, defaultAnchorModel, anchorSeatCandidates };
