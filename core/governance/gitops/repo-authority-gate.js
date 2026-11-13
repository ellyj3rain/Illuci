// illuci/core/governance/gitops/repo-authority-gate.js
//
// The Std 12 repo-authority gate — the source-owned enforcement surface for the
// worktree/filesystem context atom. It composes the probe (facts) and the pure
// classifier (verdict), routes the block through the single armed.js choke-point
// (GZDS_OVERRIDE honored, audited), and exports the predicateCtx that makes the
// AUTO-GENERATED compiled std-12 atoms applicable (they are inert until their
// facts are supplied — see runtime/floor-bridge.js applicable()).
//
// Divergence-only contract (ratified 2026-06-30): the classifier now emits a
// block signal ONLY on a real split-brain (root/branch/worktree mismatch or a
// shadow repo). Everything else — dirty, detached, behind, no-lineage, non-git,
// remote-mismatch — is advisory and never blocks. So the gate's block decision
// collapses to "the verdict carries a block-severity signal"; there is no
// trigger-scoped state exemption to apply anymore. The `trigger` param is kept
// as informational context (echoed into the reason/return) but no longer changes
// whether the gate blocks.

import { arm } from "../compiler/armed.js";
import { gatherRepoContextFacts } from "./repo-context-probe.js";
import { classifyWorktreeContext } from "./worktree-context-classifier.js";

export const REPO_AUTHORITY_OBLIGATION = "std-12.repo-authority";

/**
 * Derive the runtime fact fragment the compiled std-12 atoms need to become
 * applicable (every fact its predicate references must be `in ctx`). Merge this
 * into a floor-bridge / dispatch-bridge context to un-starve those atoms.
 *
 * @param {object} facts a illuci.gitops.repo-context-facts/1 object
 * @returns {object} predicate context fragment
 */
export function deriveRepoAuthorityContext(facts = {}) {
  const actual = facts.actual && typeof facts.actual === "object" ? facts.actual : {};
  const dispatched = facts.dispatched && typeof facts.dispatched === "object" ? facts.dispatched : null;
  const ctx = {};

  if (actual.isGitRepo) {
    ctx.working_root = actual.repoRoot;
    ctx.worktree_path = actual.worktreePath;
    ctx.active_branch = actual.currentBranch; // null when detached -> branch-verify fails, as intended
    ctx.canonical_roots = [actual.repoRoot];
    ctx.canonical_root = actual.repoRoot; // default; the dispatched root overrides below
    ctx.exists_nested_git = Array.isArray(actual.shadowRepos) ? actual.shadowRepos.length > 0 : false;
  }
  if (dispatched) {
    ctx.dispatched_lineage = dispatched;
    if (dispatched.canonicalRoot != null) ctx.canonical_root = dispatched.canonicalRoot;
    if (dispatched.branch != null) ctx.dispatched_branch = dispatched.branch;
    // intended_worktree is only supplied when the lineage constrains a worktree; otherwise the
    // worktree-verify atom stays inert instead of failing on a null intended path.
    if (dispatched.worktreePath != null) ctx.intended_worktree = dispatched.worktreePath;
  }
  return ctx;
}

/**
 * Run the repo-authority gate: probe -> classify -> arm. Under the
 * divergence-only contract the block decision is simply "the verdict carries a
 * block-severity signal" (a real split-brain). Synchronous and side-effect-free
 * except the single audited override append inside arm() when GZDS_OVERRIDE
 * converts a block to a pass.
 *
 * @param {{cwd?:string, dispatchedLineage?:object|null, trigger?:"session-init"|"pre-dispatch"|"pre-edit", stamp?:string|null}} [input]
 * @returns {{ok:boolean, allowed:boolean, code:string, reason:string, overridden?:boolean, trigger:string, decision:string, blockingSignals:Array, verdict:object, predicateCtx:object, facts:object}}
 */
export function checkRepoAuthority(input = {}) {
  const trigger = input.trigger || "pre-dispatch";
  const facts = gatherRepoContextFacts({ cwd: input.cwd, dispatchedLineage: input.dispatchedLineage });
  const verdict = classifyWorktreeContext(facts);
  const predicateCtx = deriveRepoAuthorityContext(facts);
  const blocking = (verdict.signals || []).filter((s) => s.severity === "block");

  const raw = blocking.length === 0
    ? { ok: true, code: "satisfied", reason: `[${REPO_AUTHORITY_OBLIGATION}] context authorized (${trigger})` }
    : {
        ok: false,
        code: "violation",
        reason: `[${REPO_AUTHORITY_OBLIGATION}] split-brain: ${blocking.map((s) => s.code).join(", ")} (${trigger})`,
      };

  const armed = arm(raw, {
    obligationId: REPO_AUTHORITY_OBLIGATION,
    repoRoot: facts.actual.repoRoot || input.cwd || process.cwd(),
    stamp: input.stamp || null,
  });

  return {
    ...armed,
    allowed: armed.ok,
    trigger,
    decision: verdict.decision,
    blockingSignals: blocking.map((s) => ({ code: s.code, severity: s.severity, dimension: s.dimension })),
    verdict,
    predicateCtx,
    facts,
  };
}

export default { checkRepoAuthority, deriveRepoAuthorityContext, REPO_AUTHORITY_OBLIGATION };
