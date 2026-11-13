/**
 * illuci — Fire-Control Checkpoints (the operator's baton)
 *
 * M4a of the orchestration reconception (OTL_ILLUCI_ARCHITECTURE.md §4). Wires the
 * long-dead fire-control vocabulary (semi / burst / auto — declared per
 * topology+seat in FIRE_CONTROL_DEFAULTS, resolved into the run, checked by NO
 * executor until now) into the agenda loop as operator confirm/redirect
 * checkpoints. This is what makes operator-DRIVEN orchestration the rich path:
 * the operator conducts at a chosen granularity instead of either hand-writing
 * a spec or ceding to a head model.
 *
 *   auto  — no checkpoint; the step runs. (exploration / no write risk)
 *   burst — checkpoint at phase/step boundaries (before each agenda step).
 *   semi  — checkpoint before each step (and, a later refinement, each seat
 *           dispatch within a parallel step). Maximum hands-on control.
 *
 * A step's effective mode is the STRICTEST among its seats (semi > burst >
 * auto), so a single "semi" seat in a parallel layer makes the operator a
 * gate on that layer.
 *
 * The host (OTL GUI, a CLI prompt) provides a CheckpointPort. ABSENT a port the
 * checkpoint resolves to "proceed" (auto-equivalent) so headless / CLI runs are
 * never blocked — fire-control is operator PACING, not a safety gate (the
 * write/tool gate is separate and still fail-closed). The operator opts into
 * semi/burst by supplying a port.
 *
 * A checkpoint decision is one of:
 *   { action: "proceed" }                 run the step as planned
 *   { action: "redirect", intent: "…" }   revise the mandate (M1 reviseMandate)
 *                                          for THIS and all later steps, then run
 *   { action: "skip" }                    skip this step (M2 cursor.skip)
 *   { action: "abort" }                   stop the run here
 */

const RANK = { auto: 0, burst: 1, semi: 2 };

/**
 * Effective firing mode for a step = the strictest among its seats.
 * @param {object} step          agenda step ({ seat } | { seats })
 * @param {object} fireControl   map of seatId -> mode. A value is EITHER the mode string
 *   ("semi"|"burst"|"auto") OR the rich seat fire-control object getSeatFireControl
 *   returns ({ firingMode, burstCount, stabilityThreshold }). Both are accepted: the
 *   runner builds this map from getSeatFireControl (the object), and reading that object
 *   as a bare string made RANK[object] undefined -> "auto", so no seat ever needed a
 *   checkpoint and the whole fire-control surface was dead (audit #1). The mode is
 *   coerced out of either shape here, at the point of consumption.
 * @returns {"auto"|"burst"|"semi"}
 */
export function stepFiringMode(step, fireControl = {}) {
  const seats = step.seats || (step.seat ? [step.seat] : []);
  let mode = "auto";
  for (const s of seats) {
    const raw = fireControl[s];
    const m = (typeof raw === "string" ? raw : raw?.firingMode) || "auto";
    if ((RANK[m] ?? 0) > (RANK[mode] ?? 0)) mode = m;
  }
  return mode;
}

/** Whether a step needs an operator checkpoint before it runs. */
export function needsCheckpoint(step, fireControl) {
  return stepFiringMode(step, fireControl) !== "auto";
}

/**
 * Resolve a checkpoint via the host port. Validates and normalizes the
 * decision; any malformed/throwing port resolves to "proceed" (never strands a
 * run on a flaky UI). Pure of side effects — the caller applies the decision.
 *
 * @param {object} input
 * @param {object} input.step
 * @param {string} input.firingMode
 * @param {object} input.mandate
 * @param {function|null} input.port  async ({step, seats, firingMode, mandate}) => decision
 * @returns {Promise<{action:string, intent?:string}>}
 */
export async function resolveCheckpoint({ step, firingMode, mandate, port }) {
  if (typeof port !== "function") return { action: "proceed" };
  let decision;
  try {
    decision = await port({
      step: { id: step.id, type: step.type, seats: step.seats || (step.seat ? [step.seat] : []) },
      firingMode,
      mandate: { intent: mandate?.intent?.raw, revision: mandate?.intent?.revision },
    });
  } catch {
    return { action: "proceed" }; // a failing checkpoint UI must not block the run
  }
  const action = decision?.action;
  if (action === "redirect" && typeof decision.intent === "string" && decision.intent.length > 0) {
    return { action: "redirect", intent: decision.intent };
  }
  if (action === "skip" || action === "abort" || action === "proceed") return { action };
  return { action: "proceed" };
}

export default { stepFiringMode, needsCheckpoint, resolveCheckpoint };
