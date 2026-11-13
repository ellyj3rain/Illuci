/**
 * illuci — Conductor (deterministic half: the edge-rule agenda deriver)
 *
 * M3 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3 tier 3,
 * "derived" mode). Generalizes generatePhasesFromGraph (index.js) from
 * precedes-only Kahn layering into an EDGE-RULE TABLE that computes a run's
 * order FROM the relationship semantics — so the arbiter closes because its
 * `integrates-from` edges make it a sink, not because it is phases[2], and the
 * executive briefs-then-synthesizes because of its `parent-of` edges.
 *
 * No LLM. Pure: (topology) → { steps, rationale } | null. Returns null when the
 * graph has no orderable structure beyond "everyone at once" AND that is not a
 * confident derivation — the caller (agenda.js) falls back to ritual, recorded.
 *
 * The conductor's PLANNING half (the anchor model reordering/replanning from
 * the task + memory) lands at M4 and consumes this deterministic plan as its
 * starting proposal.
 *
 * --- The edge rules (how a seat's edges become ACTS in a partial order) ---
 *   parent-of(S→C)       S appears as a BRIEF act (before its children) and a
 *                        SYNTH act (after them): S frames, children work, S rolls up.
 *   integrates-from(S→T) S is a SINK: it runs after every source T (T's last act).
 *   precedes(S→T)        S's act precedes T's act (pipeline order).
 *   adversarial-to(A↔B)  A and B each appear as an OPEN act (parallel, from the
 *                        prompt) and a REBUT act (parallel, from the opponents' opens).
 *   mentors(S→M)         M attempts first; S reviews after (M's act precedes S's).
 *   child-of / mentored-by / peer-of / informs … treated as the inverse or as
 *                        lateral (no precedence) — they shape the lens, not the order.
 *
 * Acts are layered by dependency depth; same-depth acts run as one phase
 * (parallel if >1 seat, single if 1). Each phase's input is derived from the
 * phases its acts consume ("prompt" at depth 0, else "phase:…+phase:…").
 */

/** Edge types that, on seat S targeting T, mean "T must run before S" (S is a sink/successor). */
const SOURCE_BEFORE_SELF = new Set(["integrates-from", "mentored-by"]);
/** Edge types that, on seat S targeting T, mean "S must run before T" (S precedes T). */
const SELF_BEFORE_TARGET = new Set(["precedes", "mentors"]);

function seatEdges(seat) {
  return seat.relationships || [];
}

/**
 * Derive an agenda from a topology's relationship graph.
 * @returns {{ steps: object[], rationale: string } | null}
 */
export function deriveAgenda(topology) {
  const seats = topology.seats || [];
  if (seats.length === 0) return null;
  const seatIds = new Set(seats.map((s) => s.id));
  const seatById = new Map(seats.map((s) => [s.id, s]));

  // ── 1. Expand seats into ACTS. An act is one appearance of a seat in the run. ──
  // act = { id, seatId, kind, consumes:Set<actId> }  consumes drives layering + input.
  /** @type {Map<string, {id:string, seatId:string, kind:string, consumes:Set<string>, fromPrompt:boolean}>} */
  const acts = new Map();
  const actsOf = new Map(); // seatId → [actId in run order]
  const mk = (seatId, kind, { fromPrompt = false } = {}) => {
    const id = kind === "single" ? seatId : `${seatId}#${kind}`;
    if (!acts.has(id)) {
      acts.set(id, { id, seatId, kind, consumes: new Set(), fromPrompt });
      if (!actsOf.has(seatId)) actsOf.set(seatId, []);
      actsOf.get(seatId).push(id);
    }
    return acts.get(id);
  };

  // detect patterns per seat
  const isParent = (s) => seatEdges(s).some((r) => r.type === "parent-of" && seatIds.has(r.target));
  const adversaryTargets = (s) =>
    seatEdges(s).filter((r) => r.type === "adversarial-to" && seatIds.has(r.target)).map((r) => r.target);
  const isSink = (s) => seatEdges(s).some((r) => r.type === "integrates-from" && seatIds.has(r.target));

  let usedRule = false;

  for (const s of seats) {
    if (isParent(s)) {
      usedRule = true;
      mk(s.id, "brief", { fromPrompt: true });
      mk(s.id, "synth");
    } else if (adversaryTargets(s).length > 0) {
      usedRule = true;
      mk(s.id, "open", { fromPrompt: true });
      mk(s.id, "rebut");
    } else {
      // sink or plain seat → a single act
      mk(s.id, "single", { fromPrompt: !isSink(s) });
    }
  }

  // ── 2. Wire ACT dependencies from the edge rules. ──
  const lastActOf = (seatId) => {
    const list = actsOf.get(seatId);
    return list ? list[list.length - 1] : null;
  };
  const firstBriefOf = (seatId) => {
    const list = actsOf.get(seatId) || [];
    return list.find((a) => acts.get(a).kind === "brief") || list[0] || null;
  };

  for (const s of seats) {
    for (const r of seatEdges(s)) {
      if (!seatIds.has(r.target)) continue;
      switch (r.type) {
        case "parent-of": {
          // brief(S) precedes each child's first act; each child's last act precedes synth(S).
          const briefId = firstBriefOf(s.id);
          const synthId = `${s.id}#synth`;
          const child = seatById.get(r.target);
          const childFirst = firstBriefOf(r.target);
          const childLast = lastActOf(r.target);
          if (childFirst && briefId) acts.get(childFirst).consumes.add(briefId);
          if (childLast && acts.has(synthId)) acts.get(synthId).consumes.add(childLast);
          usedRule = true;
          break;
        }
        case "adversarial-to": {
          // rebut(S) consumes the opponent's OPEN act.
          const rebutId = `${s.id}#rebut`;
          const oppOpen = `${r.target}#open`;
          if (acts.has(rebutId) && acts.has(oppOpen)) acts.get(rebutId).consumes.add(oppOpen);
          usedRule = true;
          break;
        }
        default:
          if (SOURCE_BEFORE_SELF.has(r.type)) {
            // S runs after T: S's act consumes T's last act.
            const selfId = lastActOf(s.id);
            const srcId = lastActOf(r.target);
            if (selfId && srcId) acts.get(selfId).consumes.add(srcId);
            usedRule = true;
          } else if (SELF_BEFORE_TARGET.has(r.type)) {
            // S precedes T: T's first act consumes S's last act.
            const selfId = lastActOf(s.id);
            const tgtId = firstBriefOf(r.target);
            if (selfId && tgtId) acts.get(tgtId).consumes.add(selfId);
            usedRule = true;
          }
          // lateral types (peer-of, child-of, informs, …) add no precedence.
          break;
      }
    }
  }

  if (!usedRule) return null; // no orderable structure → caller falls back to ritual

  // ── 3. Layer acts by dependency depth (Kahn over the act DAG). ──
  const depth = new Map();
  const compute = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0; // cycle guard — treat as root
    stack.add(id);
    const c = acts.get(id).consumes;
    let d = 0;
    if (c.size > 0) {
      let max = -1;
      for (const dep of c) max = Math.max(max, compute(dep, stack));
      d = max + 1;
    }
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of acts.keys()) compute(id);

  const byDepth = new Map();
  for (const a of acts.values()) {
    if (!byDepth.has(depth.get(a.id))) byDepth.set(depth.get(a.id), []);
    byDepth.get(depth.get(a.id)).push(a);
  }
  const depths = [...byDepth.keys()].sort((x, y) => x - y);

  // ── 4. Emit phases (one per depth layer). Derive input from consumed acts' layers. ──
  const actToPhase = new Map(); // actId → phaseId
  const steps = [];
  depths.forEach((d, layerIdx) => {
    const layer = byDepth.get(d);
    const phaseId = layer.length === 1
      ? `${layer[0].seatId}-${layer[0].kind}`.replace(/-single$/, "")
      : `layer-${layerIdx}`;
    const seatsInLayer = [...new Set(layer.map((a) => a.seatId))];

    // input = distinct source phases of this layer's acts, plus "prompt" if any act is a root.
    const srcPhases = new Set();
    let fromPrompt = false;
    for (const a of layer) {
      if (a.consumes.size === 0 || a.fromPrompt) fromPrompt = true;
      for (const dep of a.consumes) {
        const p = actToPhase.get(dep);
        if (p) srcPhases.add(p);
      }
    }
    const inputParts = [];
    if (fromPrompt) inputParts.push("prompt");
    for (const p of srcPhases) inputParts.push(`phase:${p}`);
    const input = inputParts.length > 0 ? inputParts.join("+") : "prompt";

    const step = layer.length === 1
      ? { id: phaseId, type: "single", seat: seatsInLayer[0], input }
      : { id: phaseId, type: "parallel", seats: seatsInLayer, input };
    steps.push(step);
    for (const a of layer) actToPhase.set(a.id, phaseId);
  });

  return {
    steps,
    rationale: `derived: order computed from ${steps.length} dependency layer(s) over the relationship graph (edge-rule table)`,
  };
}

export default { deriveAgenda };
