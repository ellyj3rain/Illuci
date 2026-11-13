//! Activation vector (ADR-04).
//!
//! The kernel emits, per continuous axis, a domain-agnostic `Activation`. The
//! DOMAIN maps `axis -> name` (`SEED_PROJECTION_V1`) and `directive_band ->
//! template string`; this crate emits only indices, a fixed-point value, and
//! band classifications — no prose, no names (ADR-01).
//!
//! This is the kernel half of the template-hybrid rendering the ADR-04 worked
//! example specifies: for a seed axis at 0.82 the kernel emits
//! `{ axis, q_value: 3_521_873_183, band7: 5, directive_band: +1 }`, and the
//! domain renders the matching high template.

use crate::fixed;
use crate::seed::{Seed, N_AXES};

/// One axis's activation. Purely numeric/index data — the domain interprets it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activation {
    /// The axis index (0..N_AXES).
    pub axis: u8,
    /// The raw Q32.32 seed value for this axis.
    pub q_value: i64,
    /// 7-band quantization (legible identifier).
    pub band7: u8,
    /// Directive band: +1 high / 0 mid / -1 low (drives the domain template).
    pub directive_band: i8,
}

/// Emit the activation vector for a seed: one `Activation` per continuous axis.
pub fn activate(seed: &Seed) -> Vec<Activation> {
    let mut out = Vec::with_capacity(N_AXES);
    for i in 0..N_AXES {
        let q = seed.axes[i];
        out.push(Activation {
            axis: i as u8,
            q_value: q,
            band7: fixed::band7(q),
            directive_band: fixed::directive_band(q),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activate_reproduces_worked_example_traces() {
        // The three ADR-04 traces, addressed by axis index only (no facet name
        // in the kernel — the domain owns that mapping).
        let mut vals = [0.5f64; N_AXES];
        vals[11] = 0.82; // -> +1, band7 5
        vals[7] = 0.18; //  -> -1, band7 1
        vals[3] = 0.50; //  ->  0, band7 3 (explicit mid)
        let acts = activate(&Seed::from_f64_axes(&vals, [0, 0, 0]));

        assert_eq!(
            acts[11],
            Activation { axis: 11, q_value: 3_521_873_183, band7: 5, directive_band: 1 }
        );
        assert_eq!(
            acts[7],
            Activation { axis: 7, q_value: 773_094_113, band7: 1, directive_band: -1 }
        );
        assert_eq!(
            acts[3],
            Activation { axis: 3, q_value: 2_147_483_648, band7: 3, directive_band: 0 }
        );
    }

    #[test]
    fn activation_count_is_one_per_axis() {
        let acts = activate(&Seed::zeroed());
        assert_eq!(acts.len(), N_AXES);
        assert_eq!(acts[0].axis, 0);
        assert_eq!(acts[N_AXES - 1].axis as usize, N_AXES - 1);
    }
}
