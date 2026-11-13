//! grader — the v1 deterministic mutation policy (DR-170 Phase B2, DR-176).
//!
//! The MUTATION half of the ratified measurement/mutation seam: JS measures
//! (the grader-input record's lenses) and projects axis bookkeeping; this
//! module owns the math that turns those signals into banded Q32.32 deltas.
//! Pure, integer, deterministic — same inputs, same bytes.
//!
//! v1 policy (a SEED policy — the weighting evolves with the learning layer,
//! every constant lives here):
//!   - GATES (fail-quiet: ungated runs produce ZERO deltas, never noise):
//!       run_count  >= GRADE_MIN_RUNS        (no learning from a single run)
//!       stability  >= GRADE_MIN_STABILITY_Q (no learning from churn)
//!   - STEP: each graded entry moves GRADE_STEP_Q toward its expressed pole
//!     (+1 -> +step, -1 -> -step) — CONSOLIDATION of the expressed
//!     configuration, not resolution of its tensions (the domain ratified
//!     internal tension as productive; the grader deepens grooves, it does
//!     not erase character).
//!   - SIZING: GRADE_STEP_Q = ONE/32 (exactly dyadic: exact in Q32.32 AND in
//!     an f64 ledger value). One band7 step = ONE/7, so ~4.6 consistently
//!     graded runs cross a band — calibrated accumulation, answering the
//!     band-absorption finding (small deltas are invisible in banded
//!     identity until they ACCRUE; the policy makes accrual the mechanism).
//!
//! CONFOUND GUARD (ADR-01): entries are anonymous (direction only). The
//! domain owns which facet each entry belongs to; nothing named crosses in.

use crate::fixed::ONE;

/// Minimum runs observed before any delta is emitted.
pub const GRADE_MIN_RUNS: u32 = 2;

/// Minimum stability (Q32.32) to grade: exactly 0.75.
pub const GRADE_MIN_STABILITY_Q: i64 = (3 * ONE) / 4;

/// The consolidation step (Q32.32): exactly 1/32.
pub const GRADE_STEP_Q: i64 = ONE / 32;

/// Grade a run's signals into per-entry Q32.32 deltas.
///
/// `stability_q` — the measured stability score, Q32.32 in [0, ONE].
/// `run_count`   — seat-scoped runs observed so far.
/// `directions`  — one entry per graded facet: +1 (expressed high) or
///                 -1 (expressed low). The caller validates the domain;
///                 any other value contributes a ZERO delta (defense in
///                 depth — the boundary rejects it first).
///
/// Returns one Q32.32 delta per entry, in order.
pub fn grade(stability_q: i64, run_count: u32, directions: &[i8]) -> Vec<i64> {
    let gated = run_count >= GRADE_MIN_RUNS && stability_q >= GRADE_MIN_STABILITY_Q;
    directions
        .iter()
        .map(|&d| {
            if !gated {
                0
            } else {
                match d {
                    1 => GRADE_STEP_Q,
                    -1 => -GRADE_STEP_Q,
                    _ => 0,
                }
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixed;

    #[test]
    fn constants_are_exact_dyadics() {
        assert_eq!(GRADE_STEP_Q, 134_217_728); // 2^32 / 32
        assert_eq!(GRADE_MIN_STABILITY_Q, 3_221_225_472); // 0.75 * 2^32
        assert_eq!(fixed::to_f64(GRADE_STEP_Q), 0.03125); // exact in f64 too
    }

    #[test]
    fn gated_run_emits_signed_steps() {
        let out = grade(GRADE_MIN_STABILITY_Q, 3, &[1, -1, 1]);
        assert_eq!(out, vec![GRADE_STEP_Q, -GRADE_STEP_Q, GRADE_STEP_Q]);
    }

    #[test]
    fn below_stability_gate_is_all_zero() {
        let out = grade(GRADE_MIN_STABILITY_Q - 1, 10, &[1, -1]);
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn single_run_is_all_zero() {
        let out = grade(ONE, 1, &[1, -1]);
        assert_eq!(out, vec![0, 0]);
    }

    #[test]
    fn invalid_direction_contributes_zero_even_when_gated() {
        let out = grade(ONE, 5, &[1, 0, 2, -1]);
        assert_eq!(out, vec![GRADE_STEP_Q, 0, 0, -GRADE_STEP_Q]);
    }

    #[test]
    fn deterministic_byte_for_byte() {
        let a = grade(GRADE_MIN_STABILITY_Q, 2, &[1, -1, 1, -1]);
        let b = grade(GRADE_MIN_STABILITY_Q, 2, &[1, -1, 1, -1]);
        assert_eq!(a, b);
    }

    #[test]
    fn accumulation_crosses_a_band_in_five_steps() {
        // band7 width = ONE/7; ceil((ONE/7) / (ONE/32)) = ceil(32/7) = 5.
        let band_width = ONE / 7;
        let steps = (band_width + GRADE_STEP_Q - 1) / GRADE_STEP_Q;
        assert_eq!(steps, 5);
    }
}
