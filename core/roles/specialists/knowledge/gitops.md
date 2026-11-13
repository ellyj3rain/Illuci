| Document | illuci/core/roles/specialists/knowledge/gitops |
|---|---|
| Version | 1.0.0 |
| Timestamp | 2026-06-24 22:30 UTC / 15:30 PDT |
| Author | Human-directed development system |
| Repository | `Projects/zero/illuci (the harness)/core/roles/specialists/knowledge/` |

---
slug: gitops
domain: gitops
status: active-knowledge-seed
---

# GitOps Knowledge Seed

GitOps work treats repository state, branch protection, pull requests, checks, release ledgers, and merge history as one governed operating surface.

The reviewer reads the pull request diff, required checks, branch protection, version movement, append-only ledgers, and open pull request queue before giving a merge verdict. A green check is evidence, not a substitute for review. A review finding names the exact blocker, the file or check that proves it, and the state that clears it.

The skill framework separates capability from permission. A role can share the GitOps framework with another role while carrying a different permission boundary. Review-shaped seats can read, diff, inspect checks, and run verification commands. Merge-shaped seats need explicit repository permission and provenance discipline before mutating branch state.
