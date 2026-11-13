// illuci/core/governance/compiler/audit/logger.js
//
// Append-only compile ledger. Each compile run appends a record (batch, source_hash, stats,
// emitted file list). Clock-free: the stamp is injected by the caller. The override ledger is
// written by armed.js; this is the compile-run ledger, a governance ledger in its own right.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function compileLedgerPath(repoRoot) {
  return join(repoRoot, "core", "governance", "compiler", "audit", "compiles.jsonl");
}

export function logCompile(repoRoot, record) {
  try {
    const p = compileLedgerPath(repoRoot);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + "\n");
  } catch {
    // audit is best-effort; a failed append never breaks a compile.
  }
}

export default { logCompile, compileLedgerPath };
