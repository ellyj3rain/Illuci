// illuci/core/governance/authortime/header.js
//
// FLOOR atom: formal artifacts keep their GZS document header. Preservation-model - the
// deterministic, false-positive-free form: if a file HAD the header, a change must not strip
// or corrupt it. The additive requirement ("a NEW formal artifact must add a header") is a
// fuzzy judgment (what counts as a formal artifact) and belongs to the ceiling, not this
// floor atom. Pure + hook-agnostic.

const ROW = (name) => new RegExp(`^\\|\\s*${name}\\s*\\|`, "m");

/**
 * Does the content open with the GZS document header table? Checks the first non-empty
 * lines for the Document / Version / Repository rows (the load-bearing header rows).
 */
export function hasGzsHeader(content) {
  const head = String(content == null ? "" : content)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 12)
    .join("\n");
  return ROW("Document").test(head) && ROW("Version").test(head) && ROW("Repository").test(head);
}

/**
 * Preservation check: if the prior content had a GZS header, the proposed content must too.
 * @returns {{ok:boolean, code:string, reason:string}}
 */
export function checkHeaderPreserved(oldContent, newContent) {
  // A deletion (or emptied file) is not a header strip - the proposed content is simply gone, not
  // a surviving artifact that lost its header. Whether a canonical-pack member may be removed at
  // all is the doc-pack atom's concern (checkDocPackPreserved), not this one. Without this guard
  // an intentional removal of a headered formal artifact reads as a header strip and false-blocks.
  if (newContent == null || String(newContent).trim() === "") {
    return { ok: true, code: "deleted", reason: "file removed or emptied - not a header strip (removal is the doc-pack atom's concern)" };
  }
  if (hasGzsHeader(oldContent) && !hasGzsHeader(newContent)) {
    return {
      ok: false,
      code: "header-stripped",
      reason: "the GZS document header (| Document | / | Version | / | Repository |) was removed or corrupted - formal artifacts keep their header",
    };
  }
  return { ok: true, code: "ok", reason: "header preserved" };
}

export default { hasGzsHeader, checkHeaderPreserved };
