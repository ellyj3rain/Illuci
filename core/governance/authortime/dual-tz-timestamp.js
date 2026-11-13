// illuci/core/governance/authortime/dual-tz-timestamp.js
//
// FLOOR atom: dual-TZ timestamp format discipline. Every formal artifact's header Timestamp
// field uses the inline dual-TZ form (UTC + PST/PDT) - e.g. "2026-06-22 10:17 UTC / 03:17 PDT"
// (CLAUDE.md Timekeeping; the timekeeper skill standard; the constitutional doc header rows).
// A header that carries a single-zone or otherwise malformed timestamp is the catchable
// failure. This COMPLEMENTS header.js, which only checks header PRESENCE - it never validates
// the Timestamp field's CONTENTS. This atom does exactly that, and only that.
//
// Preservation + validity model (false-positive-free on legacy headers): the atom validates
// FORMAT, never the clock - any timestamp is data, there is no Date.now() / "now" comparison
// here, so the module is fully deterministic. It only fires on a Timestamp field that changed
// THIS commit: if the prior content already carried the same value verbatim, the verdict is
// downgraded to unchanged-legacy (a pre-existing malformed timestamp is not this change's
// fault, and forcing a rewrite of untouched history would be a false positive).
//
// Pure + hook-agnostic: the runner supplies oldContent + newContent (HEAD vs staged/working).

// The header Timestamp ROW, scanned over the first non-empty lines of a doc. Captures the
// field value between the second and third pipes of "| Timestamp | <value> |".
const TS_ROW = /^\|\s*Timestamp\s*\|\s*(.+?)\s*\|/m;

// The inline dual-TZ form: "YYYY-MM-DD HH:MM UTC / HH:MM PST|PDT".
// Matches "2026-06-22 10:17 UTC / 03:17 PDT". Anchored - the WHOLE value must be the form.
const INLINE_DUAL_TZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \/ \d{2}:\d{2} (PST|PDT)$/;

/**
 * Extract the header Timestamp field value from content, scanning only the first 12 non-empty
 * lines (the header table region) so a Timestamp mention in the body is never mistaken for the
 * header field. Returns the captured value (trimmed) or null when no Timestamp row is present.
 * @param {string} content
 * @returns {string|null}
 */
export function extractHeaderTimestamp(content) {
  const head = String(content == null ? "" : content)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 12)
    .join("\n");
  const m = TS_ROW.exec(head);
  return m ? m[1].trim() : null;
}

/**
 * Validate the header Timestamp field's FORMAT against the inline dual-TZ standard. Clock-free
 * and deterministic - any timestamp is a param; never compared to "now".
 *
 * @param {string} oldContent  prior committed content (empty/null = new file)
 * @param {string} newContent  proposed content
 * @returns {{ok:boolean, code:string, reason:string, value?:string}}
 *   ok:true  -> no-timestamp-field | valid | unchanged-legacy
 *   ok:false -> malformed-timestamp (with the offending value)
 */
export function checkDualTzTimestamp(oldContent, newContent) {
  const value = extractHeaderTimestamp(newContent);

  // Inert unless a header Timestamp field actually exists in the proposed content.
  if (value === null) {
    return { ok: true, code: "no-timestamp-field", reason: "no header Timestamp field to validate" };
  }

  // Well-formed -> pass.
  if (INLINE_DUAL_TZ.test(value)) {
    return { ok: true, code: "valid", value, reason: "dual-TZ timestamp well-formed" };
  }

  // Malformed - but stay false-positive-free on legacy headers: if the prior content already
  // carried this exact value, the malformed timestamp pre-dates this change. Don't punish an
  // edit elsewhere in the doc for a timestamp it never touched.
  if (extractHeaderTimestamp(oldContent) === value) {
    return { ok: true, code: "unchanged-legacy", value, reason: "pre-existing timestamp not modified this change" };
  }

  return {
    ok: false,
    code: "malformed-timestamp",
    value,
    reason: `header Timestamp "${value}" is not the inline dual-TZ form 'YYYY-MM-DD HH:MM UTC / HH:MM PST|PDT'`,
  };
}

export default { checkDualTzTimestamp, extractHeaderTimestamp };
