//! persona-kernel-napi — the Tier-1 node addon (ADR-07; DR-170 Phase B1).
//!
//! Exactly two work functions cross the FFI, once per dispatch, no shared
//! state (ADR-07 Tier 1): `seedFromPreset` and `renderDirective`. Plus
//! `kernelInfo` (a JSON string) so the JS loader can sanity-check the ABI.
//!
//! MARSHALLING (the ADR-02 carry-forward, RESOLVED here / DR-175):
//!   - Bulk data crosses as LITTLE-ENDIAN BYTE BLOBS only.
//!   - Seed blob   = N_AXES x i64 LE (8 bytes each) ++ N_CATEGORICAL x u8
//!                 = 68*8 + 3 = 547 bytes.
//!   - Activation blob = N_AXES records x 12 bytes LE each:
//!       [0..8)  q_value  i64 LE
//!       [8]     axis     u8
//!       [9]     band7    u8
//!       [10]    directive_band i8
//!       [11]    reserved (0)
//!   - BigInt is RETIRED at this boundary: no scalar i64 crosses alone; the
//!     only f64s are the [0,1] input axis values, quantized ONCE by the
//!     kernel (`Seed::from_f64_axes`, round-half-to-even).
//!
//! ERROR TYPING (the ADR-07 Phase-2 gate, RESOLVED here / DR-175): every
//! rejection is a JS `Error` whose message is `CODE: detail` with CODE from
//! the CLOSED vocabulary below; the JS loader parses the prefix onto
//! `error.code` so call sites can switch on it. napi's panic->Error
//! conversion remains the backstop for defects (no code prefix).
//!
//!   KERNEL_BAD_AXES_LEN         wrong number of axis values
//!   KERNEL_BAD_CATEGORICAL_LEN  wrong number of categorical codes
//!   KERNEL_AXIS_NOT_FINITE      an axis value is NaN or infinite
//!   KERNEL_AXIS_RANGE           an axis value is outside [0,1]
//!   KERNEL_BAD_SEED_BLOB        seed blob has the wrong byte length
//!   KERNEL_BAD_SIGNAL           a grade signal is non-finite or outside [0,1]
//!   KERNEL_BAD_DIRECTIONS       a grade direction entry is not +1 or -1
//!
//! CONFOUND GUARD (ADR-01): this crate names axes only as basis indices; the
//! domain owns every projection and template string.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use persona_kernel::{activate, fixed, grade, Seed, N_AXES, N_CATEGORICAL};

/// LE seed blob length: 68 x i64 + 3 x u8.
const SEED_BLOB_LEN: usize = N_AXES * 8 + N_CATEGORICAL;
/// One packed activation record (see module docs).
const ACT_RECORD_LEN: usize = 12;

fn kernel_err(code: &str, detail: String) -> Error {
    Error::from_reason(format!("{code}: {detail}"))
}

/// ABI self-description for the JS loader (JSON string).
#[napi]
pub fn kernel_info() -> String {
    format!(
        "{{\"abi\":\"persona-kernel-napi/1\",\"crateVersion\":\"{}\",\"nAxes\":{},\"nCategorical\":{},\"seedBlobLen\":{},\"activationRecordLen\":{}}}",
        env!("CARGO_PKG_VERSION"),
        N_AXES,
        N_CATEGORICAL,
        SEED_BLOB_LEN,
        ACT_RECORD_LEN,
    )
}

/// Quantize [0,1] axis values + categorical codes into the canonical LE seed
/// blob. The kernel owns the one float->Q32.32 conversion (round-half-to-even,
/// ADR-02); the boundary validates fail-closed.
#[napi]
pub fn seed_from_preset(values: Float64Array, categorical: Uint8Array) -> Result<Buffer> {
    if values.len() != N_AXES {
        return Err(kernel_err(
            "KERNEL_BAD_AXES_LEN",
            format!("expected {} axis values, got {}", N_AXES, values.len()),
        ));
    }
    if categorical.len() != N_CATEGORICAL {
        return Err(kernel_err(
            "KERNEL_BAD_CATEGORICAL_LEN",
            format!("expected {} categorical codes, got {}", N_CATEGORICAL, categorical.len()),
        ));
    }
    let mut vals = [0f64; N_AXES];
    for i in 0..N_AXES {
        let v = values[i];
        if !v.is_finite() {
            return Err(kernel_err("KERNEL_AXIS_NOT_FINITE", format!("axis_{i} is not finite")));
        }
        if !(0.0..=1.0).contains(&v) {
            return Err(kernel_err("KERNEL_AXIS_RANGE", format!("axis_{i} = {v} outside [0,1]")));
        }
        vals[i] = v;
    }
    let mut cats = [0u8; N_CATEGORICAL];
    cats.copy_from_slice(&categorical[..N_CATEGORICAL]);

    let seed = Seed::from_f64_axes(&vals, cats);
    let mut out = Vec::with_capacity(SEED_BLOB_LEN);
    for i in 0..N_AXES {
        out.extend_from_slice(&seed.axes[i].to_le_bytes());
    }
    out.extend_from_slice(&seed.categorical);
    Ok(out.into())
}

/// Grade a run's measured signals into per-entry Q32.32 deltas (DR-176 v1
/// policy — stability-gated consolidation; constants live in the kernel's
/// `grader` module). Entries are anonymous directions (+1 / -1); the DOMAIN
/// owns which facet each entry belongs to (ADR-01). The stability float is
/// quantized ONCE at the boundary (round-half-to-even), mirroring the seed
/// path. Returns one i64 LE per entry (8 bytes each).
#[napi]
pub fn grade_signals(stability: f64, run_count: u32, directions: Int8Array) -> Result<Buffer> {
    if !stability.is_finite() || !(0.0..=1.0).contains(&stability) {
        return Err(kernel_err(
            "KERNEL_BAD_SIGNAL",
            format!("stability must be finite in [0,1], got {stability}"),
        ));
    }
    for (i, &d) in directions.iter().enumerate() {
        if d != 1 && d != -1 {
            return Err(kernel_err(
                "KERNEL_BAD_DIRECTIONS",
                format!("direction[{i}] must be +1 or -1, got {d}"),
            ));
        }
    }
    let stability_q = fixed::from_f64(stability);
    let deltas = grade(stability_q, run_count, &directions);
    let mut out = Vec::with_capacity(deltas.len() * 8);
    for d in &deltas {
        out.extend_from_slice(&d.to_le_bytes());
    }
    Ok(out.into())
}

/// Decode a seed blob and emit the packed ADR-04 activation vector
/// (one 12-byte LE record per axis; layout in the module docs).
#[napi]
pub fn render_directive(seed_blob: Buffer) -> Result<Buffer> {
    let bytes: &[u8] = &seed_blob;
    if bytes.len() != SEED_BLOB_LEN {
        return Err(kernel_err(
            "KERNEL_BAD_SEED_BLOB",
            format!("expected {SEED_BLOB_LEN} bytes, got {}", bytes.len()),
        ));
    }
    let mut seed = Seed::zeroed();
    for i in 0..N_AXES {
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[i * 8..i * 8 + 8]);
        seed.axes[i] = i64::from_le_bytes(b);
    }
    seed.categorical.copy_from_slice(&bytes[N_AXES * 8..]);

    let acts = activate(&seed);
    let mut out = Vec::with_capacity(acts.len() * ACT_RECORD_LEN);
    for a in &acts {
        out.extend_from_slice(&a.q_value.to_le_bytes());
        out.push(a.axis);
        out.push(a.band7);
        out.push(a.directive_band as u8);
        out.push(0);
    }
    Ok(out.into())
}
