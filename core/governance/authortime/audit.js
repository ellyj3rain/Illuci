// illuci/core/governance/authortime/audit.js
//
// The author-time floor AUDIT trail. Every floor-gate decision - pass, block, or override -
// is recorded as one JSON line in an append-only JSONL ledger at
// <repoRoot>/.illuci/governance/floor-audit.jsonl. This is the forensic record that answers
// "what did the gate see, and was it waived" after the fact: blocking violations that were
// stopped, warnings that were noted, and (critically) overrides where the operator chose to
// proceed despite a block and the reason they gave (see override.js).
//
// buildAuditRecord is PURE (clock-free: ts is a param) so the record shape is unit-testable.
// appendAudit is the only impure surface - it serializes one record to a single JSONL line
// and appends it, mkdir -p'ing the .illuci/governance dirs on first write. JSONL (one object
// per line) is chosen so the trail is append-only by construction: a new decision is a new
// line, never a rewrite of prior content.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const AUDIT_RELPATH = join(".illuci", "governance", "floor-audit.jsonl");

/**
 * Build the plain audit record for one floor-gate decision. PURE - no clock, no I/O; the
 * timestamp is supplied by the caller so the record is deterministic and testable.
 *
 * @param {object}  args
 * @param {string}  args.ts                    ISO-ish timestamp string (caller-supplied)
 * @param {string}  args.action                what the gate did, e.g. "commit" | "pre-tool-use"
 * @param {Array}   [args.blocking=[]]         the blocking violations (floor-check shape)
 * @param {Array}   [args.warnings=[]]         the advisory warnings (floor-check shape)
 * @param {{overridden:boolean,reason:string|null}} [args.override]  override decision (override.js)
 * @returns {{ts:string, action:string, blocking:Array, warnings:Array,
 *            override:{overridden:boolean, reason:(string|null)}, outcome:string}}
 *   outcome: "blocked"    -> blocking present, not overridden (the commit was stopped)
 *            "overridden" -> blocking present, deliberately waived
 *            "passed"      -> no blocking violations
 */
export function buildAuditRecord({ ts, action, blocking, warnings, override } = {}) {
  const blockingArr = Array.isArray(blocking) ? blocking : [];
  const warningsArr = Array.isArray(warnings) ? warnings : [];
  const ov =
    override && typeof override === "object"
      ? { overridden: Boolean(override.overridden), reason: override.reason ?? null }
      : { overridden: false, reason: null };

  let outcome;
  if (blockingArr.length === 0) {
    outcome = "passed";
  } else if (ov.overridden) {
    outcome = "overridden";
  } else {
    outcome = "blocked";
  }

  return {
    ts: ts == null ? null : String(ts),
    action: action == null ? null : String(action),
    blocking: blockingArr,
    warnings: warningsArr,
    override: ov,
    outcome,
  };
}

/**
 * IMPURE. Append one audit record as a single JSONL line to
 * <repoRoot>/.illuci/governance/floor-audit.jsonl, creating the directory tree on first write.
 * The record is serialized with JSON.stringify (single line) followed by a trailing newline
 * so each decision is exactly one parseable line.
 *
 * @param {string} repoRoot  the repository root the .illuci trail lives under
 * @param {object} record    typically the output of buildAuditRecord
 * @returns {{ok:true, path:string}}
 */
export function appendAudit(repoRoot, record) {
  const path = join(repoRoot, AUDIT_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  return { ok: true, path };
}

export default { buildAuditRecord, appendAudit, AUDIT_RELPATH };
