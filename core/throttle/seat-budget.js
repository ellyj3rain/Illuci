// The seat/member budget cascade — v1 (DR-189, the WO-2 arbiter ruling).
//
// F-089: token budgets were flat — one company ceiling, no company→member→seat
// allocation. This adds the ruled v1 slice: optional MEMBER (topology) caps,
// optional per-SEAT floors + caps, and a derived per-dispatch cap that is the
// MINIMUM of the whole chain. Weights and work-conserving spillover are v2 (the
// ruling deferred them until there are real starvation repros under armed caps).
//
// Ruling anchors:
//   - Seat is the budget identity; a DRL reseat inherits the seat's remaining.
//   - Floors are NON-borrowable admission-control reservations honored before any
//     dispatch: reserve at topology start; if it can't be honored, fail closed.
//   - The "dispatch" level is not a fourth pool — it is min(remaining, cap) down
//     the seat→member→company chain.
//   - Observation telemetry (per-seat / per-member spent) ships regardless of
//     whether any cap/floor is configured, with ZERO control effect.
//
// DEFAULT POSTURE = OFF. With no budget stanza, the seat ledger tracks spend for
// OBSERVATION only and every cap is Infinity — byte-identical control behavior.

const posInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);

export class SeatBudgetConfigError extends Error {
  constructor(message) {
    super(`seat-budget: ${message}`);
    this.name = "SeatBudgetConfigError";
    this.code = "SEAT_BUDGET_CONFIG_INVALID";
  }
}

/**
 * Normalize the operator-facing `budget` control (run-control envelope) into a
 * validated internal shape. Fails closed on malformed input (never a silent
 * downgrade — DR-129). Returns null when no cascade is configured (off).
 *
 * Accepted shape:
 *   { member?: { cap?: N },
 *     seats?: { <seatId>: { floor?: N, cap?: N } },
 *     reseatingMin?: N }
 */
export function normalizeBudgetControl(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SeatBudgetConfigError("budget must be an object");
  }
  const out = { memberCap: null, seats: {}, reseatingMin: null };
  let any = false;

  if (raw.member != null) {
    if (typeof raw.member !== "object" || Array.isArray(raw.member)) {
      throw new SeatBudgetConfigError("budget.member must be an object");
    }
    if (raw.member.cap != null) {
      const cap = posInt(raw.member.cap);
      if (cap == null) throw new SeatBudgetConfigError(`budget.member.cap must be a positive integer (got ${JSON.stringify(raw.member.cap)})`);
      out.memberCap = cap;
      any = true;
    }
  }

  if (raw.seats != null) {
    if (typeof raw.seats !== "object" || Array.isArray(raw.seats)) {
      throw new SeatBudgetConfigError("budget.seats must be an object keyed by seat id");
    }
    for (const [seatId, entry] of Object.entries(raw.seats)) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SeatBudgetConfigError(`budget.seats.${seatId} must be an object`);
      }
      const seat = {};
      if (entry.floor != null) {
        const floor = posInt(entry.floor);
        if (floor == null) throw new SeatBudgetConfigError(`budget.seats.${seatId}.floor must be a positive integer`);
        seat.floor = floor;
      }
      if (entry.cap != null) {
        const cap = posInt(entry.cap);
        if (cap == null) throw new SeatBudgetConfigError(`budget.seats.${seatId}.cap must be a positive integer`);
        seat.cap = cap;
      }
      if (seat.floor != null && seat.cap != null && seat.floor > seat.cap) {
        throw new SeatBudgetConfigError(`budget.seats.${seatId}: floor ${seat.floor} exceeds cap ${seat.cap}`);
      }
      if (seat.floor != null || seat.cap != null) {
        out.seats[seatId] = seat;
        any = true;
      }
    }
  }

  if (raw.reseatingMin != null) {
    const rm = posInt(raw.reseatingMin);
    if (rm == null) throw new SeatBudgetConfigError("budget.reseatingMin must be a positive integer");
    out.reseatingMin = rm;
    any = true;
  }

  return any ? out : null;
}

/**
 * The seat/member ledger for ONE topology run. Tracks per-seat spend (always,
 * for observation) and, when a cascade is configured, enforces member + seat
 * caps and reserves non-borrowable seat floors.
 *
 * @param {object|null} control  normalized budget control (normalizeBudgetControl output)
 * @param {object} opts
 * @param {() => number} [opts.companyRemaining]  tokens remaining under the company ceiling (Infinity when unbounded)
 */
export function createSeatBudget(control = null, { companyRemaining = () => Infinity } = {}) {
  const cfg = control || { memberCap: null, seats: {}, reseatingMin: null };
  const seatSpent = new Map();   // seatId -> tokens charged
  let memberSpent = 0;
  const enforced = !!control && (cfg.memberCap != null || Object.keys(cfg.seats).length > 0);

  // Floors are reserved from the member pool at construction (admission control).
  // A floor is a claim on the member cap that peers cannot borrow. When the member
  // cap can't cover the sum of floors, the run fails closed (never silently).
  const floorSum = Object.values(cfg.seats).reduce((s, x) => s + (x.floor || 0), 0);
  if (cfg.memberCap != null && floorSum > cfg.memberCap) {
    throw new SeatBudgetConfigError(
      `sum of seat floors (${floorSum}) exceeds member cap (${cfg.memberCap}) — reservation cannot be honored`,
    );
  }

  const seatCfg = (seatId) => cfg.seats[seatId] || {};
  const spentOf = (seatId) => seatSpent.get(seatId) || 0;

  // Member remaining = memberCap - memberSpent (Infinity when uncapped).
  const memberRemaining = () => (cfg.memberCap == null ? Infinity : Math.max(0, cfg.memberCap - memberSpent));

  // A seat's own remaining, respecting its cap AND the floors reserved by OTHER
  // seats out of the shared member pool (a seat can spend its own floor + its
  // share of the unreserved member pool, bounded by its cap).
  const seatRemaining = (seatId) => {
    const { cap, floor = 0 } = seatCfg(seatId);
    const capRemain = cap == null ? Infinity : Math.max(0, cap - spentOf(seatId));
    // The member pool this seat may draw beyond its own floor = memberRemaining
    // minus the floors still reserved for OTHER seats (their floor not yet spent).
    let othersReserved = 0;
    for (const [id, c] of Object.entries(cfg.seats)) {
      if (id === seatId || !c.floor) continue;
      othersReserved += Math.max(0, c.floor - spentOf(id));
    }
    const ownFloorRemain = Math.max(0, floor - spentOf(seatId));
    const memberDrawable = memberRemaining() === Infinity
      ? Infinity
      : Math.max(0, memberRemaining() - othersReserved) + ownFloorRemain;
    return Math.min(capRemain, memberDrawable);
  };

  return {
    get enforced() { return enforced; },
    get reseatingMin() { return cfg.reseatingMin; },

    /**
     * The derived per-dispatch cap for a seat: min(configured, seatRemaining,
     * memberRemaining, companyRemaining). Infinity when nothing bounds it.
     * `configured` is the seat's own numPredict-derived cap (or Infinity).
     */
    effectiveDispatchCap(seatId, configured = Infinity) {
      return Math.min(
        Number.isFinite(configured) ? configured : Infinity,
        seatRemaining(seatId),
        memberRemaining(),
        companyRemaining(),
      );
    },

    /** Would a reseat of this seat be blocked by reseatingMin? (DRL consult.) */
    reseatBlocked(seatId) {
      if (cfg.reseatingMin == null) return false;
      return seatRemaining(seatId) < cfg.reseatingMin;
    },

    /** Charge actual tokens to a seat after a dispatch (observation + enforcement). */
    charge(seatId, tokens = 0) {
      const t = Math.max(0, tokens | 0);
      seatSpent.set(seatId, spentOf(seatId) + t);
      memberSpent += t;
    },

    /** Is a seat out of budget? (seat cap or member cap exhausted for it.) */
    seatExhausted(seatId) {
      if (!enforced) return false;
      return seatRemaining(seatId) <= 0;
    },

    /** Is the member (topology) pool exhausted? */
    memberExhausted() {
      return cfg.memberCap != null && memberRemaining() <= 0;
    },

    seatSpent: (seatId) => spentOf(seatId),
    memberSpent: () => memberSpent,

    /** Observation snapshot for the trace budget payload (always emitted). */
    snapshot() {
      const seats = {};
      for (const seatId of new Set([...seatSpent.keys(), ...Object.keys(cfg.seats)])) {
        seats[seatId] = {
          spent: spentOf(seatId),
          floor: seatCfg(seatId).floor ?? null,
          cap: seatCfg(seatId).cap ?? null,
          remaining: enforced ? finiteOrNull(seatRemaining(seatId)) : null,
        };
      }
      return {
        enforced,
        memberCap: cfg.memberCap,
        memberSpent,
        memberRemaining: cfg.memberCap == null ? null : memberRemaining(),
        reseatingMin: cfg.reseatingMin,
        seats,
      };
    },
  };
}

function finiteOrNull(n) {
  return Number.isFinite(n) ? n : null;
}

export default { normalizeBudgetControl, createSeatBudget, SeatBudgetConfigError };
