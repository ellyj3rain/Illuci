// illuci/core/governance/authortime/append-only.js
//
// FLOOR atom (the highest-value one): the append-only ledgers - BATCH_LOG, DECISION_REGISTRY,
// FINDINGS - may only ever GROW. Corrections are NEW appended entries that supersede prior
// ones; existing content is never edited or deleted (the append-only-supersession pattern).
// This is the guard against the forked-ledger / history-rewrite class - an agent editing a
// historical DR / batch / finding line, which is exactly the kind of silent ledger damage
// the reconciliation work this session exists to prevent.
//
// SCOPE: the entry BODY only. The GZS document header (the leading | Document | ... | Repository |
// table, including the Version / Timestamp rows) legitimately updates as the ledger grows and is
// governed by the header + version-gate atoms - it is not append-only history. Comparing the full
// file would false-flag a header bump as a history edit, so the header table is stripped from both
// sides before the strict-prefix check; the body invariant is unchanged.
//
// Pure + hook-agnostic: the hook reads the prior content (HEAD:<file>) and the proposed content
// (staged / working tree) and calls checkAppendOnly. Line-ending-normalized so a CRLF<->LF
// difference is never a false positive. The body invariant is a strict prefix: the prior body
// must survive verbatim at the head of the new body; only additions follow.

export const APPEND_ONLY_LEDGERS = ["BATCH_LOG.md", "DECISION_REGISTRY.md", "FINDINGS.md"];

function normalizeLE(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

/**
 * Return the content below the GZS document header table. The header ends at the | Repository |
 * row; if there is no such row in the leading block the content has no header and is returned whole.
 */
function stripGzsHeader(content) {
  const lines = content.split("\n");
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    if (/^\|\s*Repository\s*\|/.test(lines[i])) {
      return lines.slice(i + 1).join("\n");
    }
  }
  return content;
}

/**
 * @param {string} oldContent  prior committed content (empty/null = new ledger)
 * @param {string} newContent  proposed content
 * @returns {{ok:boolean, code:string, reason:string, line?:(number|null), added?:number}}
 *   ok:true  -> new-file | unchanged | appended
 *   ok:false -> append-only-violation (with the first offending line when locatable)
 */
export function checkAppendOnly(oldContent, newContent) {
  const oldFull = normalizeLE(oldContent);
  const newFull = normalizeLE(newContent);

  if (oldFull === "") {
    return { ok: true, code: "new-file", reason: "no prior content (new ledger)" };
  }

  // Scope the invariant to the body; the header table is governed elsewhere and may update.
  const headerOffset = oldFull.split("\n").length - stripGzsHeader(oldFull).split("\n").length;
  const oldN = stripGzsHeader(oldFull);
  const newN = stripGzsHeader(newFull);

  if (newN === oldN) {
    return { ok: true, code: "unchanged", reason: "ledger body unchanged" };
  }
  if (newN.startsWith(oldN)) {
    const added = newN.slice(oldN.length).split("\n").filter((l) => l.trim().length > 0).length;
    return { ok: true, code: "appended", added, reason: `append-only: prior body preserved, ${added} line(s) appended` };
  }

  // Label-only re-index exception (DR-119, the [A20.3]-style VERSION-preserving relabel).
  // A re-index changes batch-LABEL tokens ([A<major>.<minor>...]) on prior lines but preserves
  // their CONTENT. Mask the label tokens on both sides: if the prior body then survives as a
  // prefix, the ONLY modifications were batch-label relabels — the honest-index correction the
  // ledger sanctions, not a history rewrite. Crucially this stays strict: any NON-label change to
  // a prior line leaves a residual diff, so the masked prefix check fails and the violation below
  // fires. The masking is comparison-only and never alters the ledger.
  const maskBatchLabels = (s) => s.replace(/\[A\d+(?:\.\d+)*\]/g, "[#reindex#]");
  if (maskBatchLabels(newN).startsWith(maskBatchLabels(oldN))) {
    return {
      ok: true,
      code: "re-indexed",
      reason: "append-only: prior body preserved modulo a batch-label re-index (VERSION-preserving relabel; DR-119) — only [A<n>] labels changed on prior lines, remainder appended",
    };
  }

  // Prior body was NOT preserved as a prefix - locate the first modified/removed line (file-relative).
  const oldLines = oldN.split("\n");
  const newLines = newN.split("\n");
  let line = null;
  for (let i = 0; i < oldLines.length; i++) {
    if (newLines[i] !== oldLines[i]) { line = i + 1 + headerOffset; break; }
  }
  return {
    ok: false,
    code: "append-only-violation",
    line,
    reason: line != null
      ? `append-only violation: prior content at line ${line} was modified or removed - these ledgers only ever grow (append a superseding entry instead of editing history)`
      : `append-only violation: prior content was modified or removed - these ledgers only ever grow`,
  };
}

export default { checkAppendOnly, APPEND_ONLY_LEDGERS };
