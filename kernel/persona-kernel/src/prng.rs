//! splitmix64 PRNG (ADR-02).
//!
//! State is a single u64, exported/imported as an 8-byte little-endian blob so
//! generator continuity survives the FFI boundary (ADR-02/ADR-07 marshalling).
//! The state is NEVER re-seeded from a float.

/// A splitmix64 generator.
#[derive(Clone, Copy, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    /// Seed the generator from a u64.
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Advance and return the next 64-bit output.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Export the generator state as an 8-byte little-endian blob.
    pub fn export_state(&self) -> [u8; 8] {
        self.state.to_le_bytes()
    }

    /// Reconstruct a generator from an exported state blob.
    pub fn import_state(blob: [u8; 8]) -> Self {
        Self {
            state: u64::from_le_bytes(blob),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = SplitMix64::new(0xC0FF_EE12_3456_789A);
        let mut b = SplitMix64::new(0xC0FF_EE12_3456_789A);
        for _ in 0..64 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn export_import_round_trip_resumes_stream() {
        let mut a = SplitMix64::new(42);
        for _ in 0..5 {
            a.next_u64();
        }
        // Snapshot mid-stream, keep drawing on `a`, and prove a restored copy
        // reproduces the same continuation byte-for-byte.
        let blob = a.export_state();
        let mut restored = SplitMix64::import_state(blob);
        for _ in 0..16 {
            assert_eq!(a.next_u64(), restored.next_u64());
        }
    }

    #[test]
    fn distinct_seeds_diverge() {
        let mut a = SplitMix64::new(1);
        let mut b = SplitMix64::new(2);
        assert_ne!(a.next_u64(), b.next_u64());
    }
}
