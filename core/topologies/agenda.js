/**
 * illuci — Agenda (the execution plan as a first-class, recorded object)
 *
 * M2 of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §3, tier 3).
 * Demotes the authored `phases[]` from LAW to DEFAULT: an Agenda is the plan
 * for ONE run, derived in one of three modes on a continuum with a hard
 * fallback chain (conducted → derived → ritual). M2 ships the ritual mode +
 * the cursor machinery; derived (edge-rule table) lands at M3, conducted (the
 * anchor's planning faculty) at M4. Steps keep the exact phase shape today's
 * executors consume, so executeParallel/Single/Sequential/Rotating run
 * untouched regardless of which mode produced the plan.
 *
 * The ARRANGEMENT TIMELINE is the recorded history of the run's organization:
 * which agenda was chosen and why, every step start/finish, every mid-run
 * mutation (M4+ replans, seat changes, mandate revisions). It is the memory
 * stratum-4 seed (session record = transcript + arrangement timeline) and the
 * data the run-ledger GUI renders. M2 records it on the trace; durable
 * persistence joins the session store at M5.
 */

import { deriveAgenda } from "./conductor.js";
import { planAgenda } from "./anchor.js";

/**
 * Build the agenda for a run.
 *
 * @param {object} topology   the charter (a TOPOLOGIES entry)
 * @param {object} [options]
 * @param {"ritual"|"derived"|"conducted"} [options.mode="ritual"]
 * @returns {{ mode: string, steps: object[], rationale: string }}
 */
export function buildAgenda(topology, options = {}) {
  const requested = options.mode || "ritual";

  // M3: "derived" computes order from the relationship graph (edge-rule table).
  // If the graph has no orderable structure, deriveAgenda returns null and we
  // fall back to ritual (recorded) — a run can never strand on a mode.
  if (requested === "derived") {
    const derived = deriveAgenda(topology);
    if (derived) {
      return { mode: "derived", steps: derived.steps, rationale: derived.rationale, requestedMode: "derived", fallback: false };
    }
    return {
      mode: "ritual",
      steps: [...(topology.phases || [])],
      rationale: `derived agenda unavailable (no orderable structure in the graph); fell back to ritual`,
      requestedMode: "derived",
      fallback: true,
    };
  }

  // M2: conducted is not yet available (the anchor planning faculty is M4) —
  // fall back HARD to ritual, recording the fallback.
  if (requested === "conducted") {
    return {
      mode: "ritual",
      steps: [...(topology.phases || [])],
      rationale: `agenda mode "conducted" not yet available (M4); fell back to ritual (defaultAgenda as authored)`,
      requestedMode: "conducted",
      fallback: true,
    };
  }

  return {
    mode: "ritual",
    steps: [...(topology.phases || [])],
    rationale: "ritual: the charter's defaultAgenda as authored",
    fallback: false,
  };
}

/**
 * Async agenda resolution for a run. Routes "conducted" through the delegated
 * anchor (a lead model proposes a plan, validated against the charter bounds,
 * falling back conducted→derived→ritual); ritual/derived stay synchronous.
 *
 * @param {object} topology
 * @param {object} opts
 * @param {"ritual"|"derived"|"conducted"} [opts.mode]
 * @param {object} [opts.mandate]
 * @param {string} [opts.anchorModelId]   the delegated lead model (conducted)
 * @param {(modelId:string, prompt:string)=>Promise<string>} [opts.dispatch]
 * @returns {Promise<object>} agenda { mode, steps, rationale, brief?, fallback }
 */
export async function resolveAgenda(topology, opts = {}) {
  if (opts.mode === "conducted") {
    return planAgenda({
      topology,
      mandate: opts.mandate || null,
      anchorModelId: opts.anchorModelId || null,
      dispatch: opts.dispatch || null,
    });
  }
  return buildAgenda(topology, { mode: opts.mode || "ritual" });
}

/**
 * A mutable cursor over the agenda's steps. M2 iterates in order (ritual);
 * the mutation primitives (insert / reorder / skip / extend) exist now so the
 * conductor (M4) and the operator's steering surface (M4.5) have one place to
 * act, with every mutation recorded by the caller into the arrangement
 * timeline.
 */
export function createCursor(agenda) {
  const steps = [...agenda.steps];
  let index = 0;

  return {
    hasNext: () => index < steps.length,
    next: () => (index < steps.length ? steps[index++] : null),
    /** Steps not yet executed (excludes the one currently in flight). */
    remaining: () => steps.slice(index),
    executedCount: () => index,
    /** Insert a step after the current position. Returns the step. */
    insert(step) {
      steps.splice(index, 0, step);
      return step;
    },
    /** Reorder the REMAINING steps by id list; ids absent keep relative order at the end. */
    reorder(idOrder) {
      const remaining = steps.splice(index);
      const byId = new Map(remaining.map((s) => [s.id, s]));
      const next = [];
      for (const id of idOrder) {
        if (byId.has(id)) {
          next.push(byId.get(id));
          byId.delete(id);
        }
      }
      next.push(...byId.values());
      steps.push(...next);
    },
    /** Skip the next pending step with the given id. Returns true if skipped. */
    skip(stepId) {
      const i = steps.findIndex((s, idx) => idx >= index && s.id === stepId);
      if (i === -1) return false;
      steps.splice(i, 1);
      return true;
    },
    snapshot: () => ({ executed: steps.slice(0, index).map((s) => s.id), pending: steps.slice(index).map((s) => s.id) }),
  };
}

/** Create an arrangement-timeline recorder. Events are plain, ordered, cheap. */
export function createArrangementTimeline() {
  const events = [];
  const record = (type, payload = {}) => {
    events.push({ t: new Date().toISOString(), type, ...payload });
    return events[events.length - 1];
  };
  return { record, events };
}

export default { buildAgenda, createCursor, createArrangementTimeline };
