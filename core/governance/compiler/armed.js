// illuci/core/governance/compiler/armed.js
//
// The single choke-point every COMPILED enforcer routes its block through. Armed by default:
// an enforcer's negative verdict blocks UNLESS GZDS_OVERRIDE carries a substantive reason
// (>= 6 chars), in which case the block is converted to an audited pass. There is deliberately
// no env var that silently disarms all enforcement; the only bypass is a per-invocation stated
// reason, and every use is appended to the override ledger BEFORE the pass is granted. Pure
// except for that single audit append (and the env read) - and clock-free: the timestamp is
// injected by the caller, never read from a clock here.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const OVERRIDE_ENV = "GZDS_OVERRIDE";
export const MIN_REASON = 6;

/** The append-only override ledger path, repo-root-relative resolved. */
export function overrideLedgerPath(repoRoot) {
  return join(repoRoot, "core", "governance", "compiler", "audit", "overrides.jsonl");
}

/**
 * Wrap a compiled enforcer's raw verdict with the override hatch.
 * @param {{ok:boolean, code:string, reason:string}} verdict  the enforcer's pure result
 * @param {{obligationId?:string, repoRoot?:string, stamp?:string}} [ctx]
 * @returns {{ok:boolean, code:string, reason:string, overridden?:boolean}}
 */
export function arm(verdict, ctx = {}) {
  if (verdict.ok) return verdict;
  const reason = process.env[OVERRIDE_ENV];
  if (reason == null || String(reason).trim().length < MIN_REASON) {
    return verdict; // no valid override -> the block stands
  }
  const repoRoot = ctx.repoRoot || process.cwd();
  const record = {
    obligation: ctx.obligationId || verdict.code || "unknown",
    blocked_reason: verdict.reason,
    override_reason: String(reason).trim(),
    stamp: ctx.stamp || null,
  };
  try {
    const p = overrideLedgerPath(repoRoot);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + "\n");
  } catch {
    return verdict;
  }
  return {
    ok: true,
    code: "overridden",
    reason: `[${record.obligation}] overridden: ${record.override_reason}`,
    overridden: true,
  };
}

export default { arm, overrideLedgerPath, OVERRIDE_ENV, MIN_REASON };
