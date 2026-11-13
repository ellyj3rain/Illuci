// illuci/core/governance/compiler/runtime/helpers.js
//
// Domain helpers the predicate evaluator calls for the function-form operands in declared
// predicates (e.g. matches_secret_pattern(written_content)). Each helper takes (ctx, argString).
// The high-value real one is the secret-pattern scanner - a genuine regex sweep over a content
// fact, not a stub. The rest resolve a named fact from ctx (the runtime gathers the git/session
// facts), so an un-provided fact is undefined and a hard comparison fails closed where it must.

// Secret VALUE patterns (not credential-file paths - that is the existing hard-deny's job).
// Conservative, high-signal patterns: a hit is a real leak, not a false alarm on prose.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                                            // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, // private key block
  /gh[pousr]_[A-Za-z0-9]{36,}/,                                  // GitHub token
  /xox[baprs]-[A-Za-z0-9-]{10,}/,                                // Slack token
  /sk-[A-Za-z0-9]{20,}/,                                         // OpenAI-style secret key
  /AIza[0-9A-Za-z_\-]{35}/,                                      // Google API key
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/, // JWT
];

export const HELPERS = {
  // Real: scan a content fact for secret VALUES. The arg names the ctx field holding content.
  matches_secret_pattern(ctx, arg) {
    const field = String(arg || "written_content").trim();
    const content = ctx[field] != null ? String(ctx[field]) : "";
    return SECRET_PATTERNS.some((re) => re.test(content));
  },
  // count(X): the runtime provides ctx[X] as an array or number; count is its length or value.
  count(ctx, arg) {
    const v = ctx[String(arg || "").trim()];
    if (Array.isArray(v)) return v.length;
    if (typeof v === "number") return v;
    return v == null ? 0 : 1;
  },
  // exists_nested_git(root): the runtime provides the boolean fact; default false.
  exists_nested_git(ctx) {
    return ctx.exists_nested_git === true;
  },
  // canonical_root(lineage): the runtime provides ctx.canonical_root (the resolved root).
  canonical_root(ctx) {
    return ctx.canonical_root;
  },
};

export default { HELPERS, SECRET_PATTERNS };
