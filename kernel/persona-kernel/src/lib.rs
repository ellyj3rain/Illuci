//! persona-kernel — the domain-agnostic fixed-point persona kernel.
//!
//! DR-161 / `design/persona-kernel-absorption-adrs.md`. Rust fixed-point is the
//! canonical persona math; illuci's JS disposition surfaces bind to this crate.
//!
//! CONFOUND GUARD (ADR-01): this crate contains NO domain or facet-vocabulary
//! string literal. Axes are pure basis vectors (`axis_0..axis_67`); the DOMAIN
//! owns the axis->name projection (`SEED_PROJECTION_V1`) and every template
//! string. The `categorical` fields are opaque domain-defined codes. A source
//! lint (`kernel/lint-confound-guard.mjs`) enforces this.
//!
//! Phase-1 scaffold ([A71]): the determinism core (ADR-02) + seed (ADR-03) +
//! activation (ADR-04). The gateway/grader/ledger and the napi Tier-1 binding
//! land in later ratified phases.

pub mod fixed;
pub mod prng;
pub mod seed;
pub mod activation;
pub mod grader;

pub use activation::{activate, Activation};
pub use grader::{grade, GRADE_MIN_RUNS, GRADE_MIN_STABILITY_Q, GRADE_STEP_Q};
pub use seed::{Seed, N_AXES, N_CATEGORICAL};
