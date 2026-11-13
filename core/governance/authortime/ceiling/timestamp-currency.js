// illuci/core/governance/authortime/ceiling/timestamp-currency.js
//
// Ceiling: the header Timestamp CURRENCY judgment - the advisory complement to the
// dual-tz-timestamp FLOOR atom.
//
// The floor (dual-tz-timestamp.js) answers a mechanical, blocking question: "is the header
// Timestamp field WELL-FORMED (the inline dual-TZ shape)?". This ceiling answers the softer,
// advisory question: "a formal artifact's BODY changed substantively - did its header
// Timestamp move with it, or is the header now lying about when the doc last changed?". A
// stale header is not a hard violation (the operator default is that the ceiling never blocks
// - constitutional/CONSTITUTION.md, operator-mediated execution), so this is surfaced as a finding for the
// operator, never a gate.
//
// MESSAGE-BLIND + CLOCK-FREE on purpose. Like the rest of the ceiling, it trusts only the
// diff, never the commit message. And it NEVER reads "now": it judges currency by comparing
// the NEW timestamp value against the OLD one (did it advance at all), not by checking the
// timestamp against the wall clock. So the module is fully deterministic given its inputs -
// no Date.now() / Math.random().
//
// STYLE: pure function, JSDoc, returns { stale, code, reason, ... }. The aggregator decides
// the advisory weight (warn-tier).

import { extractHeaderTimestamp } from "../dual-tz-timestamp.js";

/** Normalize line endings so a CRLF<->LF delta never reads as a body change. */
function normalizeLE(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

/** Normalize a path to repo-relative posix form (strip leading "./", backslashes -> "/"). */
function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The doc BODY = everything after the leading GZS header table. We compare bodies so a
 * Timestamp-only edit is not itself counted as the "substantive change" that should have moved
 * the timestamp (that would be circular). We strip only the CONTIGUOUS leading run of header
 * rows - markdown table lines (starting with "|") and the blank lines among/after them - so a
 * doc body of any length survives intact (a fixed line-count slice would eat real body text).
 * Returns the body text with line endings normalized.
 */
function bodyAfterHeader(content) {
  const lines = normalizeLE(content).split("\n");
  let i = 0;
  // Skip the contiguous leading header block: table rows ("| ... |" / "|---|") and the blank
  // lines interleaved with or trailing them. Stop at the first non-blank, non-table line.
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("|")) continue;
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/**
 * Judge header-timestamp currency for one changed file. Advisory (never blocks).
 *
 * The finding fires only when ALL of these hold (otherwise there is nothing to advise):
 *   - the file is a markdown artifact (.md / .markdown) - only those carry the GZS header,
 *   - both prior and proposed content carry a header Timestamp field,
 *   - the doc BODY actually changed (a substantive edit, not a header-only / no-op edit),
 *   - and the Timestamp value did NOT change (the header still claims the old change time).
 *
 * @param {{path:string, oldContent?:string, newContent?:string}} input
 * @returns {{stale:boolean, code:string, reason:string, oldTimestamp?:(string|null), newTimestamp?:(string|null)}}
 *   stale:false codes: not-markdown | new-file | no-timestamp-field | body-unchanged | timestamp-advanced
 *   stale:true  code:  timestamp-stale
 */
export function checkTimestampCurrency(input = {}) {
  const path = normalizePath(input.path);
  const oldContent = input.oldContent;
  const newContent = input.newContent;

  if (!/\.(md|markdown)$/i.test(path)) {
    return { stale: false, code: "not-markdown", reason: `"${path}" is not a markdown artifact - no GZS header timestamp to weigh` };
  }

  const oldN = normalizeLE(oldContent);
  if (oldN === "") {
    return { stale: false, code: "new-file", reason: `"${path}" is new - its timestamp is original, not stale` };
  }

  const oldTs = extractHeaderTimestamp(oldContent);
  const newTs = extractHeaderTimestamp(newContent);
  if (oldTs === null || newTs === null) {
    return { stale: false, code: "no-timestamp-field", reason: `"${path}" has no header Timestamp on both sides - currency does not apply` };
  }

  if (bodyAfterHeader(oldContent) === bodyAfterHeader(newContent)) {
    return { stale: false, code: "body-unchanged", reason: `"${path}" body is unchanged - the timestamp need not move`, oldTimestamp: oldTs, newTimestamp: newTs };
  }

  if (newTs !== oldTs) {
    return { stale: false, code: "timestamp-advanced", reason: `"${path}" body changed and its header Timestamp was updated (${oldTs} -> ${newTs})`, oldTimestamp: oldTs, newTimestamp: newTs };
  }

  return {
    stale: true,
    code: "timestamp-stale",
    oldTimestamp: oldTs,
    newTimestamp: newTs,
    reason: `"${path}" body changed but its header Timestamp "${newTs}" was not updated - the header may be stale (advisory; refresh via the timekeeper standard)`,
  };
}

export default { checkTimestampCurrency };
