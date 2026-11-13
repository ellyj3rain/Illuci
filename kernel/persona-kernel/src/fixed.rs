//! Q32.32 signed fixed-point (ADR-02).
//!
//! The determinism guarantee: dot products accumulate in `i128`, noise adds
//! saturate, f64->fixed conversion rounds half-to-even. Runtime math is pure
//! integer, so results are bitwise-identical across architectures. Only
//! construction-time ingest (`from_f64`) touches floats.

/// Fractional bits in the Q32.32 layout.
pub const FRAC_BITS: u32 = 32;

/// The fixed-point representation of 1.0 (2^32).
pub const ONE: i64 = 1 << FRAC_BITS;

/// Low activation threshold: round(0.30 * 2^32). Below-or-equal => band -1.
pub const LOW: i64 = 1_288_490_189;

/// High activation threshold: round(0.70 * 2^32). Above-or-equal => band +1.
pub const HIGH: i64 = 3_006_477_107;

/// Convert an f64 (expected in a sane bounded range, e.g. [0,1] for a seed axis)
/// to Q32.32 with round-half-to-even. Construction-time only.
pub fn from_f64(x: f64) -> i64 {
    round_half_even(x * (ONE as f64))
}

/// Convert Q32.32 back to f64 (diagnostics / tests only).
pub fn to_f64(q: i64) -> f64 {
    (q as f64) / (ONE as f64)
}

/// Round half to even (banker's rounding) — deterministic tie handling (ADR-02).
fn round_half_even(x: f64) -> i64 {
    let f = x.floor();
    let diff = x - f;
    let r = if diff > 0.5 {
        f + 1.0
    } else if diff < 0.5 {
        f
    } else {
        // exact tie -> round to even
        if (f as i64) % 2 == 0 { f } else { f + 1.0 }
    };
    r as i64
}

/// Fixed-point multiply: (a*b) >> 32, via i128 to avoid overflow.
pub fn mul(a: i64, b: i64) -> i64 {
    (((a as i128) * (b as i128)) >> FRAC_BITS) as i64
}

/// Saturating add (ADR-02 noise addition never wraps).
pub fn sat_add(a: i64, b: i64) -> i64 {
    a.saturating_add(b)
}

/// Dot product of two equal-length fixed-point vectors, accumulated in i128 and
/// shifted back to Q32.32. The i128 accumulation is the cross-arch determinism
/// guarantee (ADR-02).
pub fn dot(a: &[i64], b: &[i64]) -> i64 {
    assert_eq!(a.len(), b.len(), "dot: length mismatch");
    let mut acc: i128 = 0;
    for i in 0..a.len() {
        acc += (a[i] as i128) * (b[i] as i128);
    }
    (acc >> FRAC_BITS) as i64
}

/// Directive band (ADR-04): +1 high (>= HIGH), -1 low (<= LOW), 0 mid.
pub fn directive_band(q: i64) -> i8 {
    if q >= HIGH {
        1
    } else if q <= LOW {
        -1
    } else {
        0
    }
}

/// 7-band quantization (the operator's legible identifier, no false precision):
/// floor(q * 7 / 2^32), clamped to 0..=6.
pub fn band7(q: i64) -> u8 {
    if q <= 0 {
        return 0;
    }
    let b = (((q as i128) * 7) >> FRAC_BITS) as i64;
    if b > 6 { 6 } else { b as u8 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_match_round_of_ratios() {
        // The pinned consts equal the rounded ratios (ADR-04 worked example).
        assert_eq!(LOW, from_f64(0.30));
        assert_eq!(HIGH, from_f64(0.70));
    }

    #[test]
    fn from_f64_worked_example_values() {
        assert_eq!(from_f64(0.82), 3_521_873_183);
        assert_eq!(from_f64(0.50), 2_147_483_648);
        assert_eq!(from_f64(0.18), 773_094_113);
    }

    #[test]
    fn mul_and_one_are_consistent() {
        // x * 1.0 == x
        let x = from_f64(0.42);
        assert_eq!(mul(x, ONE), x);
    }

    #[test]
    fn dot_is_exact_for_simple_case() {
        // [1.0, 0.5] . [0.5, 1.0] = 0.5 + 0.5 = 1.0
        let a = [ONE, from_f64(0.5)];
        let b = [from_f64(0.5), ONE];
        assert_eq!(dot(&a, &b), ONE);
    }

    #[test]
    fn bands_match_worked_example() {
        assert_eq!(directive_band(from_f64(0.82)), 1);
        assert_eq!(directive_band(from_f64(0.50)), 0);
        assert_eq!(directive_band(from_f64(0.18)), -1);
        assert_eq!(band7(from_f64(0.82)), 5);
        assert_eq!(band7(from_f64(0.50)), 3);
        assert_eq!(band7(from_f64(0.18)), 1);
    }

    #[test]
    fn band7_endpoints_clamp() {
        assert_eq!(band7(0), 0);
        assert_eq!(band7(ONE), 6); // 1.0 -> top band
    }
}
