//! The persona seed (ADR-03).
//!
//! 68 continuous fixed-point axes (dotted into the gateway) + 3 opaque
//! domain-defined categorical codes that are render-only and NEVER dotted into
//! gateway math. The axes are pure basis vectors — the DOMAIN owns the
//! axis->name projection (`SEED_PROJECTION_V1`); this crate names nothing
//! (ADR-01).

use crate::fixed;

/// Number of continuous axes dotted into the gateway.
pub const N_AXES: usize = 68;

/// Number of opaque categorical codes (render-only, not dotted).
pub const N_CATEGORICAL: usize = 3;

/// An immutable-by-default persona seed. Continuous axes are Q32.32.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seed {
    /// Continuous basis-vector axes, Q32.32, gateway-dotted.
    pub axes: [i64; N_AXES],
    /// Opaque domain-defined categorical codes (render-only, not dotted).
    pub categorical: [u8; N_CATEGORICAL],
}

impl Seed {
    /// A zeroed seed.
    pub fn zeroed() -> Self {
        Self {
            axes: [0; N_AXES],
            categorical: [0; N_CATEGORICAL],
        }
    }

    /// Construct from f64 axis values in [0,1] plus categorical codes.
    /// Construction-time conversion only (ADR-02); runtime stays integer.
    pub fn from_f64_axes(vals: &[f64; N_AXES], categorical: [u8; N_CATEGORICAL]) -> Self {
        let mut axes = [0i64; N_AXES];
        for i in 0..N_AXES {
            axes[i] = fixed::from_f64(vals[i]);
        }
        Self { axes, categorical }
    }

    /// Read one continuous axis (Q32.32).
    pub fn axis(&self, i: usize) -> i64 {
        self.axes[i]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zeroed_is_all_zero() {
        let s = Seed::zeroed();
        assert!(s.axes.iter().all(|&v| v == 0));
        assert!(s.categorical.iter().all(|&v| v == 0));
    }

    #[test]
    fn from_f64_axes_converts_each_axis() {
        let mut vals = [0.0f64; N_AXES];
        vals[11] = 0.82;
        let s = Seed::from_f64_axes(&vals, [4, 5, 1]);
        assert_eq!(s.axis(11), fixed::from_f64(0.82));
        assert_eq!(s.categorical, [4, 5, 1]);
    }
}
