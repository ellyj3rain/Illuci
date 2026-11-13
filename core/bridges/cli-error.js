// core/bridges/cli-error.js
//
// [A46]/F-088: a subscription CLI can exit 0 while REPORTING failure inside its
// JSON payload — claude emits { is_error: true, result: "Not logged in · …" },
// grok emits { type: "error", message: "Internal error: …" }. The bridges'
// parse layers extracted those payloads' text fields (or fell through to raw
// stdout) and returned the ERROR PROSE as a model response, which then flowed
// through councils as content. One shared detector; each bridge keeps its own
// field extraction and throws on a detected report (the throw must sit OUTSIDE
// the JSON.parse catch — inside it, the throw is swallowed into the raw-text
// fallback, re-creating the bug).

/** Returns the CLI-reported error message, or null when the payload is a real answer. */
export function cliReportedError(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.is_error === true || parsed.type === "error") {
    return String(parsed.result || parsed.message || parsed.error || "unknown CLI-reported error");
  }
  return null;
}

export default { cliReportedError };
