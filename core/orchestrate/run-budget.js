// Phase F — the Run-wide governor. ONE concurrency/token budget per Run (a company
// session) that the worker pool AND the spawn gate both decrement, so a concurrent
// company plus its spawned children cannot over-commit the Run's resources. Today the
// pool caps members (company.js) and the TopologyTree caps children (spawn.js)
// INDEPENDENTLY — 8 members each spawning 16 children is 8+128 in flight, bounded
// only pairwise. The RunBudget is the single ceiling both paths reserve from.
//
// SYNCHRONOUS BY DESIGN: a single JS event loop cannot preempt mid-statement, so
// reserve/charge are plain counter ops with no lock (the same single-threaded fact
// that made the awareness/throttle same-loop "races" a non-issue; true cross-thread
// safety is batch 2's worker-isolation concern, not this).
//
// DEFAULT POSTURE = UNLIMITED: with neither maxConcurrent nor tokenCeiling set, every
// method is a no-op and a run is byte-identical to the pre-governor engine.

export function createRunBudget({ maxConcurrent = null, tokenCeiling = null } = {}) {
  const limit = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : null;
  const ceiling = Number.isFinite(tokenCeiling) && tokenCeiling > 0 ? tokenCeiling : null;
  let active = 0;        // currently-reserved concurrency slots (members + spawned children)
  let tokensSpent = 0;
  let halted = false;    // true once the token ceiling is hit; sticky for the rest of the Run

  return {
    /** Reserve one concurrency slot before starting a member or spawning a child.
     *  Returns {ok:false,reason} when the Run is at its ceiling (caller backs off /
     *  the spawn gate fails closed). A no-op grant when unlimited. */
    reserveSlot() {
      if (limit == null) return { ok: true };
      if (active >= limit) return { ok: false, reason: `run concurrency limit ${limit} reached (${active} active)` };
      active += 1;
      return { ok: true };
    },
    /** Release a slot when the member/child settles. Idempotent-safe (never goes < 0). */
    releaseSlot() { if (limit != null && active > 0) active -= 1; },

    /** Check whether a dispatch of ~estimate tokens fits under the Run ceiling, BEFORE
     *  the call. Once halted, every check denies (the member halts, never crashes). */
    check(estimateTokens = 0) {
      if (halted) return { allowed: false, reason: `run token budget exhausted (${tokensSpent}/${ceiling})` };
      if (ceiling == null) return { allowed: true, reason: "" };
      if (tokensSpent + Math.max(0, estimateTokens | 0) > ceiling) {
        halted = true;
        return { allowed: false, reason: `run token ceiling ${ceiling} would be exceeded` };
      }
      return { allowed: true, reason: "" };
    },
    /** Record actual tokens spent after a dispatch; trips the sticky halt at the ceiling. */
    charge(tokens = 0) {
      if (ceiling == null) return;
      tokensSpent += Math.max(0, tokens | 0);
      if (tokensSpent >= ceiling) halted = true;
    },

    isHalted() { return halted; },
    snapshot() { return { maxConcurrent: limit, active, tokenCeiling: ceiling, tokensSpent, halted }; },
  };
}

export default { createRunBudget };
