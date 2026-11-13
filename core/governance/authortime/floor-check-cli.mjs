#!/usr/bin/env node
// CLI entry for the GZDS author-time FLOOR. The git pre-commit hook (and CI) invoke this.
// Exit 0 = clean (warnings may still print); exit 1 = a BLOCK-tier floor violation.
//
//   node floor-check-cli.mjs [repoRoot] [--working] [--base <ref>]
//     repoRoot       defaults to cwd
//     --working      check the working tree instead of the staged index (local working-tree mode)
//     --base <ref>   diff the merge-base of <ref> and HEAD against HEAD (CI / PR mode). This is
//                    what CI MUST use: a PR checkout commits its changes AT HEAD, so the staged
//                    and --working modes (both diff against HEAD) see nothing and the gate is a
//                    no-op. --base origin/main inspects the PR's actual changes. Overrides
//                    --working. If <ref> / its merge-base cannot resolve, the changeset is empty.
//
// The per-project audit posture is read from <repoRoot>/.illuci/floor-policy.json (block |
// warn | off per atom), merged over the operator default.
//
// OVERRIDE (the GZDS-Override escape hatch, override.js): the floor is fail-closed, but a
// single-operator system needs a deliberate, RECORDED way to proceed past a block (a true
// emergency, a known-and-accepted exception, a case the floor can't yet model). When
// GZDS_OVERRIDE carries a non-trivial reason and there ARE blocking violations, this CLI
// does NOT exit 1: it appends an audit record (the blocking list + the override reason) and
// exits 0 - the audited bypass. The bypass is loud (it prints) and forensic (audit.js JSONL),
// never silent. Every decision the gate makes - passed, blocked, or overridden - is appended
// to <repoRoot>/.illuci/governance/floor-audit.jsonl so the trail answers "what did the gate
// see, and was it waived" after the fact.

import { gatherChangeSet, runFloorChecks, loadPolicy } from "./floor-check.js";
import { checkOverride } from "./override.js";
import { buildAuditRecord, appendAudit, AUDIT_RELPATH } from "./audit.js";

const args = process.argv.slice(2);
// --base may be passed either as "--base <ref>" (two tokens) or "--base=<ref>" (one token).
const baseIdx = args.indexOf("--base");
const baseEq = args.find((a) => a.startsWith("--base="));
const base = baseEq
  ? baseEq.slice("--base=".length)
  : baseIdx !== -1 && args[baseIdx + 1] && !args[baseIdx + 1].startsWith("--")
    ? args[baseIdx + 1]
    : null;
// The positional repoRoot is the first non-flag arg that is NOT the value consumed by --base.
const baseValueIdx = baseEq ? -1 : baseIdx !== -1 ? baseIdx + 1 : -1;
const repoRoot =
  args.find((a, i) => !a.startsWith("--") && i !== baseValueIdx) || process.cwd();
const staged = !args.includes("--working");

// base-ref mode (CI / PR) takes precedence over --working/staged when --base is supplied.
const gatherOpts = base ? { base } : { staged };

// Timestamp is sourced from the env (GZDS_AUDIT_TS) when supplied so a caller / test can pin
// it; otherwise the wall clock at commit time. buildAuditRecord itself is pure (ts is a param)
// - the clock read lives only here, at the CLI I/O boundary, never in a committed pure module.
const ts = (process.env.GZDS_AUDIT_TS && String(process.env.GZDS_AUDIT_TS)) || new Date().toISOString();

const policy = loadPolicy(repoRoot);
const result = runFloorChecks(gatherChangeSet(repoRoot, gatherOpts), policy);

// Compiled-Bill pass: the live activation of the governance compiler. Run the APPLICABLE
// compiled hard enforcers (the obligations whose facts exist at commit time - the secret-value
// scan) over the staged content and merge their blocks into the floor result. Inapplicable
// enforcers (dispatch-scoped: repo-authority, scope) stay inert, so this never blocks a commit
// for a missing dispatch fact. Each compiled enforcer self-honors GZDS_OVERRIDE. Fail-safe: a
// fault in the compiler pass is reported and skipped, never breaking the existing floor.
try {
  const { runCompiledFloor, gatherFloorFacts } = await import("../compiler/runtime/floor-bridge.js");

  // Std-12 repo-authority activation at floor time. Derive the repo-authority predicate fragment
  // and MERGE it into the commit-diff facts (never replace them), so the four compiled pre-edit
  // std-12 atoms + single-canonical-root become applicable over a real repo context. A bare
  // commit carries NO dispatched lineage, so dispatched_lineage/dispatched_branch/intended_worktree
  // are absent -> root/branch/worktree-verify stay inert (correct: a bare commit has no dispatched
  // lineage to verify against). Only no-shadow-repo and single-canonical-root (which need only the
  // always-emitted canonical_root/canonical_roots) go live. Fail-open: any fault here degrades to
  // the commit-diff facts alone, exactly as before this activation, and never breaks the floor.
  let facts;
  try {
    const [{ deriveRepoAuthorityContext }, { gatherRepoContextFacts }] = await Promise.all([
      import("../gitops/repo-authority-gate.js"),
      import("../gitops/repo-context-probe.js"),
    ]);
    const repoAuthorityCtx = deriveRepoAuthorityContext(
      // No dispatched lineage is available at commit time; do not fabricate one.
      gatherRepoContextFacts({ cwd: repoRoot, dispatchedLineage: null }),
    );
    facts = { ...gatherFloorFacts(repoRoot, gatherOpts), ...repoAuthorityCtx };
  } catch (repoErr) {
    process.stderr.write(`  [compiled-bill] repo-authority facts skipped: ${repoErr && repoErr.message}\n`);
  }

  const compiled = await runCompiledFloor(repoRoot, { ...gatherOpts, ...(facts ? { facts } : {}) });
  if (compiled.blocking.length) {
    result.blocking.push(...compiled.blocking);
    result.ok = result.blocking.length === 0;
  }
} catch (err) {
  process.stderr.write(`  [compiled-bill] pass skipped: ${err && err.message}\n`);
}

const override = checkOverride(process.env);

for (const w of result.warnings) {
  process.stderr.write(`  [warn: ${w.atom}] ${w.file}${w.line ? `:${w.line}` : ""} - ${w.reason}\n`);
}

// Record the decision in the append-only audit trail. Returns whether the record actually
// landed. For a PASS or a BLOCK the trail is best-effort (a write fault is warned, not fatal -
// the gate's verdict already stands). But for an OVERRIDE the audit write is a PRECONDITION of
// the bypass, NOT a side effect: an unaudited override is precisely the silent bypass the gate
// exists to prevent, so the caller must fail CLOSED if this returns false on an override.
function audit() {
  try {
    const record = buildAuditRecord({
      ts,
      action: base ? "ci-base-ref-check" : staged ? "commit" : "working-tree-check",
      blocking: result.blocking,
      warnings: result.warnings,
      override,
    });
    appendAudit(repoRoot, record);
    return true;
  } catch (err) {
    process.stderr.write(`  [audit] could not write ${AUDIT_RELPATH}: ${err && err.message}\n`);
    return false;
  }
}

// ---- Clean: no blocking violations. ----
if (result.ok) {
  audit();
  const tail = result.warnings.length ? ` (${result.warnings.length} warning(s))` : "";
  process.stdout.write(`GZDS floor: OK${tail}\n`);
  process.exit(0);
}

// ---- Blocking violations present, but a deliberate, reasoned override is set: audited bypass. ----
if (override.overridden) {
  const audited = audit();
  // The audit write is a PRECONDITION of the override, never a side effect. If the forensic
  // record could not land, the bypass would be silent and untrailed - exactly what the gate
  // exists to prevent (sibling enforce.js HIGH-2: "an UNAUDITED bypass is worse than a
  // denial"). Fail CLOSED: the operator keeps the block, with no un-recorded escape.
  if (!audited) {
    process.stderr.write(
      `GZDS floor: BLOCKED (override REFUSED - its audit record could not be written to ${AUDIT_RELPATH})\n`
    );
    process.stderr.write(`  an override that cannot be audited is a silent bypass; failing closed.\n`);
    for (const v of result.blocking) {
      process.stderr.write(`  [${v.atom}] ${v.file}${v.line ? `:${v.line}` : ""} - ${v.reason}\n`);
    }
    process.exit(1);
  }
  process.stderr.write(
    `GZDS floor: OVERRIDDEN (${result.blocking.length} violation(s) WAIVED via GZDS_OVERRIDE)\n`
  );
  process.stderr.write(`  reason: ${override.reason}\n`);
  for (const v of result.blocking) {
    process.stderr.write(`  [${v.atom}] ${v.file}${v.line ? `:${v.line}` : ""} - ${v.reason}\n`);
  }
  process.stderr.write(`  audited -> ${AUDIT_RELPATH}\n`);
  process.exit(0);
}

// ---- Blocking violations, no override: the floor stops the commit. ----
audit();
process.stderr.write(`GZDS floor: BLOCKED (${result.blocking.length} violation(s))\n`);
for (const v of result.blocking) {
  process.stderr.write(`  [${v.atom}] ${v.file}${v.line ? `:${v.line}` : ""} - ${v.reason}\n`);
}
process.stderr.write(
  `  to override deliberately: set GZDS_OVERRIDE="<reason >=6 chars>" (the bypass is audited)\n`
);
process.exit(1);
