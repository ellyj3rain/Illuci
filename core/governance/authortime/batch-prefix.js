// illuci/core/governance/authortime/batch-prefix.js
//
// FLOOR atom: batch-prefix commit discipline. Every commit subject opens with a batch
// identifier ([A1], [A128], sub-batch [B2.3], harden [A20.1.0]) or the [HOTFIX] marker.
// This is the commit-scope half of batch-and-version discipline (GOVERNANCE.md Commit
// Standards, Commit standards) - the single most-violated convention when
// an agent commits ungoverned, because nothing about the content diff carries the commit
// MESSAGE, so the other floor atoms (version-gate, append-only, header) never see it. This
// atom adds the missing message-scope guard: the runner now gathers an optional `message`
// slot (the raw subject line) and hands it here.
//
// Pure + hook-agnostic: the runner supplies the subject string it read from the commit
// message source (the git pre-commit hook reads .git/COMMIT_EDITMSG / the -m argument; CI in
// base-ref mode reads the tip commit's subject). No git, no I/O here - unit-testable and
// reusable across every trigger surface.
//
// FLOOR scope: "does the subject open with a recognized scope prefix." The prefix grammar is
// the ONLY authority; the message body is never trusted for anything else. Judging whether
// the CHOSEN batch is the correct one (does [A128] match the batch this changeset belongs
// to) is not a floor concern - the floor blocks an absent/malformed prefix; correctness of
// the prefix VALUE is a ceiling concern.

// Batch prefix grammar: [A#] or [B#], with up to three dot-separated sub-levels for
// sub-batches / hardens ([A20.1.0], [B2.3]). Anchored at the start of the subject.
export const BATCH_RE = /^\[(A|B)\d+(?:\.\d+){0,3}\]/;
// The hotfix escape hatch: an out-of-band fix carries [HOTFIX] instead of a batch id.
export const HOTFIX_RE = /^\[HOTFIX\]/;

/**
 * @param {string|null} message  the raw commit-message SUBJECT line (first non-empty line;
 *                                the caller trims). null/empty = the surface supplied none.
 * @returns {{ok:boolean, code:string, reason:string, batch?:string}}
 *   ok:true  -> no-message (inert) | batch (carries [A#]/[B#], `batch` = the matched token) | hotfix
 *   ok:false -> missing-batch-prefix
 */
export function checkBatchPrefix(message) {
  if (message == null) {
    return { ok: true, code: "no-message", reason: "no commit message to check" };
  }
  const subject = String(message).trim();
  if (subject === "") {
    return { ok: true, code: "no-message", reason: "no commit message to check" };
  }

  const m = BATCH_RE.exec(subject);
  if (m) {
    const token = m[0];
    return { ok: true, code: "batch", batch: token, reason: `commit carries batch prefix ${token}` };
  }
  if (HOTFIX_RE.test(subject)) {
    return { ok: true, code: "hotfix", reason: "commit carries [HOTFIX] prefix" };
  }
  return {
    ok: false,
    code: "missing-batch-prefix",
    reason: `commit subject must open with a batch prefix [A#]/[B#] or [HOTFIX]; got: "${subject.slice(0, 48)}"`,
  };
}

export default { checkBatchPrefix, BATCH_RE, HOTFIX_RE };
