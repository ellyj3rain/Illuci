// illuci/core/governance/authortime/ceiling/batch-coherence.js
//
// Ceiling: batch-prefix COHERENCE (the right-but-valid vs wrong-but-valid judgment).
//
// The floor atom (authortime/batch-prefix.js) blocks a commit whose subject carries NO
// recognized scope prefix - an absent or malformed [A#]/[B#]/[HOTFIX]. That is the "is it
// present and well-formed" question. This ceiling answers the next one: a prefix that is
// well-formed can still be the WRONG batch id - [A126] on a commit that belongs to the
// [A128] batch the ledger is currently open at. The floor would wave that through (it is a
// legal token); the ceiling flags the incoherence.
//
// Like every ceiling rule this is advisory, not a hard gate (the operator default is warn):
// the open-batch id is DERIVED from the ledger (the caller reads the highest [A#]/[B#] entry
// in BATCH_LOG.md and passes it in), and that derivation can lag a legitimately-new batch
// the same commit introduces. So a mismatch is surfaced for operator attention, never used to
// block. [HOTFIX] is coherent by definition - it is the explicit out-of-band escape and is
// never matched against the open batch.
//
// STYLE: pure function, the { ok, code, reason } shape, JSDoc, message-blind on everything
// EXCEPT the subject's own prefix token (which the floor already validated), no
// Date.now()/Math.random() - deterministic given inputs.

import { BATCH_RE, HOTFIX_RE } from "../batch-prefix.js";

/** Pull the leading batch token off a subject, or null if it carries none / a hotfix. */
function batchTokenOf(subject) {
  const s = String(subject == null ? "" : subject).trim();
  const m = BATCH_RE.exec(s);
  return m ? m[0] : null;
}

/** Normalize a batch token to its bare canonical form for comparison ("[A128]" -> "A128"). */
function canonical(token) {
  return String(token == null ? "" : token).trim().replace(/^\[/, "").replace(/\]$/, "").toUpperCase();
}

/**
 * Judge whether a (floor-validated) commit subject's batch prefix is COHERENT with the batch
 * the ledger is currently open at.
 *
 * @param {string|null} subject   the commit-message subject line (the floor already confirmed
 *                                  it opens with a recognized prefix; null/empty = nothing to judge)
 * @param {string|null} openBatch the batch id the ledger is open at, derived by the caller from
 *                                  BATCH_LOG.md (e.g. "[A128]" or "A128"); null = no ledger anchor
 * @returns {{ok:boolean, code:string, reason:string, prefix?:string, expected?:string}}
 *   ok:true  -> no-subject | hotfix (escape hatch) | no-anchor (no ledger to compare) | coherent
 *   ok:false -> batch-mismatch (advisory: surfaced as a ceiling WARNING, never a block)
 */
export function checkBatchCoherence(subject, openBatch) {
  const s = String(subject == null ? "" : subject).trim();
  if (s === "") {
    return { ok: true, code: "no-subject", reason: "no subject to judge" };
  }
  if (HOTFIX_RE.test(s)) {
    return { ok: true, code: "hotfix", reason: "[HOTFIX] is an out-of-band escape; not matched against the open batch" };
  }

  const token = batchTokenOf(s);
  if (token == null) {
    // The floor is the authority on a missing/malformed prefix; the ceiling does not double-block.
    return { ok: true, code: "no-prefix", reason: "subject carries no batch prefix (a floor concern, not a ceiling one)" };
  }

  const anchor = openBatch == null ? "" : String(openBatch).trim();
  if (anchor === "") {
    return { ok: true, code: "no-anchor", prefix: token, reason: "no open-batch anchor supplied; coherence not judged" };
  }

  if (canonical(token) === canonical(anchor)) {
    return { ok: true, code: "coherent", prefix: token, reason: `commit prefix ${token} matches the open batch` };
  }

  const expected = anchor.startsWith("[") ? anchor : `[${anchor}]`;
  return {
    ok: false,
    code: "batch-mismatch",
    prefix: token,
    expected,
    reason: `commit prefix ${token} does not match the open batch ${expected}; confirm this commit belongs to ${token} (it may legitimately open a new batch), or correct the prefix`,
  };
}

export default { checkBatchCoherence };
