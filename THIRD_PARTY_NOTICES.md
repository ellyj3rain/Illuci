# Third-party software

Illuci's original selected source is distributed under GPL-3.0-only. The dependencies below retain their own licenses. Installing or redistributing them does not change those terms. The lockfile identifies the selected dependency versions; each installed package contains its applicable notices. No dependency source, private authentication state or prebuilt provider executable is copied into this source tree.

| Direct dependency | Locked version | Declared package license | Use |
|---|---|---|---|
| @openai/codex-sdk | 0.144.1 | Apache-2.0 | dependencies |
| better-sqlite3 | 12.11.1 | MIT | dependencies |
| ink | 6.8.0 | MIT | dependencies |
| ink-spinner | 5.0.0 | MIT | dependencies |
| ink-text-input | 6.0.0 | MIT | dependencies |
| openai | 6.45.0 | Apache-2.0 | dependencies |
| react | 19.2.7 | MIT | dependencies |
| zod | 4.4.3 | MIT | dependencies |
| @duckdb/node-api | 1.5.4-r.1 | MIT | optionalDependencies |
| sqlite-vec | 0.1.9 | MIT OR Apache | optionalDependencies |
| @types/node | 26.0.1 | MIT | devDependencies |
| typescript | 6.0.3 | Apache-2.0 | devDependencies |
| vitest | 3.2.6 | MIT | devDependencies |

The optional Rust persona component uses the separately declared crates in its Cargo manifests and lockfile, including the N-API bindings where selected. Preserve their upstream notices when distributing a built artifact. Provider executables and services remain separate installations under their own terms.

## Scientific names and synthetic presets

The disposition catalog retains external taxonomy names and citations, including NEO-PI-R, SD3, PID-5 and Schwartz values. Those names identify their research sources; they are not Illuci product branding. The retained source consists of domain/facet labels, software descriptions and synthetic agent configurations. It contains no questionnaire administration, licensed norm table or real-person assessment dataset. Software weights and prompt behavior are not validated clinical measurements. Underlying instruments and publications retain their own rights; Illuci's software license does not license them.

## Public signature verification key

`core/governance/signing/github-web-flow.asc` preserves GitHub's public web-flow signing key. It contains public verification material only. The key's external identity and armored bytes are retained unchanged; GitHub maintains the public service key at [its web-flow key endpoint](https://github.com/web-flow.gpg).
