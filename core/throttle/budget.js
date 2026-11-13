/**
 * illuci — Token Budget Enforcement
 *
 * Per-run token budgets. Hard ceiling, not suggestion.
 * When budget is exhausted mid-topology, the runner can:
 *   a) Skip optional phases (seats with min: 0)
 *   b) Halt with a budget-exceeded gate
 *
 * Tracks cumulative spend per topology run.
 */

/**
 * Create a budget tracker for a topology run.
 *
 * @param {number|null} limit — max tokens for the run, null = unlimited
 * @returns {object} Budget tracker with check/spend/status methods
 */
export function createBudget(limit = null) {
  let spent = 0;

  return {
    /** Total budget */
    limit,

    /** Has a budget been set? */
    get enforced() { return limit !== null && limit > 0; },

    /** Tokens consumed so far */
    get spent() { return spent; },

    /** Tokens remaining */
    get remaining() { return limit !== null ? Math.max(0, limit - spent) : Infinity; },

    /** Is the budget exhausted? */
    get exhausted() { return limit !== null && spent >= limit; },

    /**
     * Check if a phase can proceed given estimated cost.
     * @param {number} estimatedTokens — expected token usage
     * @returns {{ allowed: boolean, reason?: string }}
     */
    check(estimatedTokens = 0) {
      if (!this.enforced) return { allowed: true };
      if (this.exhausted) return { allowed: false, reason: "budget-exhausted" };
      if (estimatedTokens > this.remaining) {
        return { allowed: false, reason: "budget-insufficient", remaining: this.remaining, estimated: estimatedTokens };
      }
      return { allowed: true };
    },

    /**
     * Record tokens spent by a phase.
     * @param {number} tokens
     */
    spend(tokens) {
      spent += tokens;
    },

    /** Status summary */
    status() {
      return {
        limit,
        spent,
        remaining: this.remaining,
        exhausted: this.exhausted,
        utilization: limit ? (spent / limit * 100).toFixed(1) + "%" : "unlimited",
      };
    },
  };
}

export default { createBudget };
