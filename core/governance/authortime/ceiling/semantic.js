// illuci/core/governance/authortime/ceiling/semantic.js
//
// Ceiling: the message-blind semantic change-class gate.
//
// The floor atoms (version-gate, append-only, header, source hygiene) check that a change is
// mechanically LEGAL. The ceiling judges what KIND of change it is - its semantic weight -
// so governance can demand a heavier or lighter ratification path. This atom assigns one of
// seven change classes purely from the file's own evidence: its path, its prior content, its
// proposed content, and the invariant-implementer manifest. It is MESSAGE-BLIND on purpose:
// the commit message / PR title / batch note is an UNTRUSTED self-report (an agent can label
// a doctrine rewrite "minor formatting"), so the classifier never reads it. The diff is the
// only witness it trusts.
//
// THE SEVEN CLASSES (ascending governance weight)
//   COSMETIC   whitespace / comment / formatting only - content is equal once those are
//              stripped. Cheapest; no interface or behavior moved.
//   PATCH      an in-place modification with no interface removal - behavior changed, the
//              contract (the set of exported symbols) did not shrink.
//   KOHAI      sub-minor structural scaffolding: repository automation, governance tooling,
//              or config surfaces that are real but not runtime/API feature growth.
//   MINOR      purely additive - a brand-new file (no prior content), or a new exported
//              symbol added with nothing removed. Grows the surface, breaks nothing.
//   CONTRACT   an exported symbol was removed or its signature changed - a consumer-visible
//              interface break. Heavier: downstream spokes can break.
//   DOCTRINE   the change touches an explicitly registered invariant implementer: the path is
//              listed in the manifest. The heaviest class; a change here is governance-grade
//              regardless of how small the diff looks.
//   UNRESOLVED signals conflict or are insufficient to decide. Per the halt-don't-default
//              AMENDMENT this is returned for operator routing - the classifier NEVER silently
//              falls through to PATCH (or any other class) on uncertainty.
//
// PRECEDENCE
//   DOCTRINE is structural and dominant: if the path is an invariant implementer, the class is
//   DOCTRINE no matter what the diff looks like. Local downstream mirrors, including this repo's
//   constitutional/ context copy, are not doctrine by location unless the manifest promotes them.
//   Below doctrine, the content signals are evaluated; when two content signals point at
//   incompatible classes, or when no signal is confident enough, the verdict is UNRESOLVED rather
//   than a guess.
//
// STYLE
//   Pure function, JSDoc, no Date.now()/Math.random() (fully deterministic given inputs),
//   message-blind. Returns { class, confidence, evidence }.

/** Downstream constitutional context mirror prefix. This is not doctrine by location in illuci. */
const CONSTITUTIONAL_PREFIX = "constitutional/";

/** Source-file extensions whose interface (exported symbols) we can scan. */
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;

/** Markdown extensions where a leading '#' is HEADING syntax, never a comment. */
const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** Binary document twins generated from governed markdown source. */
const DOCX_EXT = /\.docx$/i;

/** Root governance/project markdown docs whose substantive changes are release documentation. */
const ROOT_MARKDOWN_DOCS = new Set([
  "AGENTS.md",
  "ARCHITECTURE.md",
  "BATCH_LOG.md",
  "CLAUDE.md",
  "COMPONENTS.md",
  "CONTEXT.md",
  "CORE.md",
  "DECISION_REGISTRY.md",
  "DOCTRINE.md",
  "FINDINGS.md",
  "GOVERNANCE.md",
  "HIVEMIND.md",
  "MEMORY.md",
  "ILLUCI.md",
  "README.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
]);

/** Source-owned design archive markdown docs whose substantive changes are release documentation. */
const DESIGN_MARKDOWN_PREFIX = "design/";

/** Repository-owned dependency depot artifacts hydrate installs but do not grow runtime/API surface. */
const DEPENDENCY_DEPOT_PREFIX = "vendor/npm-cache/";

/** Skill registry metadata is source-owned catalog data, not opaque loose JSON. */
const SKILL_REGISTRY_METADATA_PREFIX = "core/skills/registry-data/";

/** Repository metadata/config surfaces that are meaningful, but not source contracts themselves. */
const REPO_METADATA_PATHS = new Set([
  ".dockerignore",
  ".gitignore",
  ".gitlab-ci.yml",
  ".npmignore",
  ".npmrc",
  "Dockerfile",
  "compose.yml",
  "package-lock.json",
  "package.json",
  "VERSION",
  "core/governance/authortime/invariant-manifest.json",
  "core/governance/authortime/surface-retirements.json",
  "core/governance/compiler/output/governance.gir.json",
]);

/** Repository metadata/config filenames that retain that meaning under scoped directories. */
const REPO_METADATA_BASENAMES = new Set(["Dockerfile"]);

/** Prefixes for repository automation/config surfaces that should classify without operator halts. */
const REPO_METADATA_PREFIXES = [
  ".github/",
  "scripts/",
  "core/governance/authortime/hooks/",
];

/** Governance/automation source lanes that mature the system without growing runtime/API surface. */
const GOVERNANCE_AUTOMATION_PREFIXES = [
  ".github/scripts/",
  ".github/workflows/",
  "core/governance/authortime/",
  "core/governance/classifiers/",
  "core/governance/gitops/",
  "scripts/",
];

/** Governance policy classifier lanes whose in-place logic changes are maturity movement. */
const GOVERNANCE_POLICY_PREFIXES = [
  "core/governance/authortime/ceiling/",
];

const GOVERNANCE_POLICY_PATHS = new Set([
  "core/governance/version-replay.js",
]);

/** Exact governance-instrumentation exports that are test seams, not public API growth. */
const GOVERNANCE_INSTRUMENTATION_EXPORTS = new Map([
  ["core/topologies/runner.js", new Set(["buildCognitiveSeatFrame"])],
]);

/** Normalize line endings so a CRLF<->LF delta is never mistaken for a content change. */
function normalizeLE(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

/** Normalize a path to posix separators and strip a leading "./". */
function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Strip comments and ALL non-semantic whitespace so two contents that differ ONLY in
 * formatting (reindentation, brace style, added comments, CRLF<->LF) compare equal.
 * Deliberately language-agnostic:
 *   - line comments:   // ... and (for non-markdown) # ...
 *   - block comments:  /* ... *\/
 *   - whitespace BETWEEN two identifier/number chars collapses to a single space (it is
 *     semantic - it separates two tokens); all OTHER whitespace (around punctuation, braces,
 *     operators) is removed entirely. So `a(){return 1;}` and `a() { return 1; }` equalize,
 *     while `return x` and `returnx` do NOT (the space there is load-bearing).
 *
 * The `#`-strip is gated on file type. In shell/py/source a leading `#` is a comment; in
 * MARKDOWN a `#` is HEADING syntax - load-bearing prose structure, NOT a comment. Stripping it
 * for .md would equalize `# Old Title` and `# New Title`, mislabeling a substantive heading
 * rewrite as COSMETIC and routing a governance-grade doc edit away from the operator. So when
 * the path is markdown, the `#`-strip is skipped and a heading change correctly survives to be
 * weighed (and, for a non-source file, surfaced as UNRESOLVED -> operator). isMarkdown=true
 * suppresses the `#`-as-comment rule.
 *
 * This is a heuristic for the COSMETIC signal only; it never decides a heavier class.
 */
function stripFormatting(content, isMarkdown = false) {
  let s = normalizeLE(content);
  // Block comments first (may span lines), then line comments.
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // // line comments (avoid eating http://)
  if (!isMarkdown) {
    s = s.replace(/(^|\s)#[^\n]*/g, "$1"); // # line comments (shell/py) - NOT markdown headings
  }
  // Collapse any whitespace run that sits between two word chars to ONE space (token separator);
  // every other whitespace run (touching punctuation/brace/operator/edge) is removed.
  s = s.replace(/\s+/g, (run, offset, full) => {
    const before = full[offset - 1];
    const after = full[offset + run.length];
    const isWord = (c) => c != null && /[\w$]/.test(c);
    return isWord(before) && isWord(after) ? " " : "";
  });
  return s.trim();
}

/**
 * Extract the set of exported top-level symbol names from source content. Message-blind and
 * heuristic - it reads only the syntax that declares a consumer-visible export. Covers the
 * forms the GZDS substrate actually uses (see the sibling floor atoms):
 *   export function NAME       export const NAME       export class NAME
 *   export { A, B as C }       export default ...        (default tracked as the token "default")
 *   export let/var NAME
 * Returns a Set of names. A change to this set (a removal) is the CONTRACT signal.
 */
function exportedSymbols(content) {
  const src = normalizeLE(content);
  const names = new Set();
  // Strip block comments so commented-out exports don't count.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  const lines = code.split("\n");
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, ""); // drop trailing line comment
    let m;
    if ((m = /^\s*export\s+default\b/.exec(line))) names.add("default");
    if ((m = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line))) names.add(m[1]);
    if ((m = /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/.exec(line))) names.add(m[1]);
    if ((m = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line))) names.add(m[1]);
    // export { a, b as c, default as d }
    const braceM = /^\s*export\s*\{([^}]*)\}/.exec(line);
    if (braceM) {
      for (const part of braceM[1].split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const asM = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(seg);
        names.add(asM ? asM[1] : seg.replace(/\s+/g, ""));
      }
    }
  }
  return names;
}

/** Is `path` listed in the manifest of invariant-implementer paths? */
function inManifest(path, manifest) {
  if (!manifest) return false;
  const norm = normalizePath(path);
  const list = Array.isArray(manifest)
    ? manifest
    : Array.isArray(manifest.paths)
      ? manifest.paths
      : [];
  return list.some((entry) => normalizePath(entry) === norm);
}

/** Does this path describe a known documentation artifact rather than opaque prose data? */
function isKnownDocumentationPath(path) {
  const norm = normalizePath(path);
  return (
    DOCX_EXT.test(norm) ||
    ROOT_MARKDOWN_DOCS.has(norm) ||
    norm.endsWith("/README.md") ||
    (norm.startsWith(DESIGN_MARKDOWN_PREFIX) && MARKDOWN_EXT.test(norm))
  );
}

/** Does this path live in illuci's downstream constitutional context mirror? */
function isConstitutionalContextPath(path) {
  const norm = normalizePath(path);
  return norm === CONSTITUTIONAL_PREFIX.slice(0, -1) || norm.startsWith(CONSTITUTIONAL_PREFIX);
}

/** Does this path describe repository metadata/config rather than runtime source? */
function isRepositoryMetadataPath(path) {
  const norm = normalizePath(path);
  const basename = norm.split("/").pop();
  return (
    REPO_METADATA_PATHS.has(norm) ||
    REPO_METADATA_BASENAMES.has(basename) ||
    REPO_METADATA_PREFIXES.some((prefix) => norm.startsWith(prefix)) ||
    isSkillRegistryMetadataPath(norm)
  );
}

function isSkillRegistryMetadataPath(path) {
  const norm = normalizePath(path);
  return norm.startsWith(SKILL_REGISTRY_METADATA_PREFIX) && /\/skill\.json$/i.test(norm);
}

function isDependencyDepotPath(path) {
  const norm = normalizePath(path);
  if (!norm.startsWith(DEPENDENCY_DEPOT_PREFIX)) return false;
  return (
    norm === "vendor/npm-cache/README.md" ||
    /^vendor\/npm-cache\/packages\/[^/]+\.tgz(?:\.part\d+)?$/i.test(norm) ||
    /^vendor\/npm-cache\/_prebuilds\/[^/]+\.tar\.gz$/i.test(norm)
  );
}

function isRepositoryAutomationPath(path) {
  const norm = normalizePath(path);
  return REPO_METADATA_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function isGovernanceAutomationPath(path) {
  const norm = normalizePath(path);
  return GOVERNANCE_AUTOMATION_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function isGovernancePolicyPath(path) {
  const norm = normalizePath(path);
  return GOVERNANCE_POLICY_PATHS.has(norm) || GOVERNANCE_POLICY_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

function isTestSourcePath(path) {
  const norm = normalizePath(path);
  return /\.(test|spec)\.(mjs|cjs|js|jsx|ts|tsx)$/i.test(norm);
}

function isGovernanceInstrumentationExport(path, added = []) {
  const allowed = GOVERNANCE_INSTRUMENTATION_EXPORTS.get(normalizePath(path));
  return !!allowed && added.length > 0 && added.every((name) => allowed.has(name));
}

/**
 * Classify a single file change into its semantic change class, message-blind.
 *
 * @param {{path:string, oldContent?:string, newContent?:string, status?:string, changeStatus?:string, manifest?:(string[]|{paths:string[]}), retirement?:object}} input
 *   path        repo-relative path of the changed file (posix or windows separators ok)
 *   oldContent  prior committed content; empty/null = the file is new (additive)
 *   newContent  proposed content; empty/null = the file is deleted
 *   manifest    invariant-implementer manifest: an array of paths, or { paths: [...] }.
 *               A path in the manifest is a DOCTRINE path (it implements an invariant).
 * @returns {{class:('COSMETIC'|'PATCH'|'KOHAI'|'MINOR'|'CONTRACT'|'DOCTRINE'|'UNRESOLVED'), confidence:number, evidence:string}}
 */
export function classifyChange(input = {}) {
  const path = normalizePath(input.path);
  const oldN = normalizeLE(input.oldContent);
  const newN = normalizeLE(input.newContent);
  const changeStatus = typeof input.status === "string" ? input.status : typeof input.changeStatus === "string" ? input.changeStatus : "";
  const manifest = input.manifest;
  const retirement = input.retirement && typeof input.retirement === "object" ? input.retirement : null;

  // ---- Insufficient signal: no path to reason from. Halt, do not default. ----
  if (!path) {
    return {
      class: "UNRESOLVED",
      confidence: 1,
      evidence: "no path supplied - cannot determine the change class without a file path (route to operator)",
    };
  }

  // ---- DOCTRINE: dominant structural signal (explicit invariant implementer manifest). ----
  const isConstitutional = isConstitutionalContextPath(path);
  const isManifest = inManifest(path, manifest);
  if (isManifest) {
    const why = isConstitutional
      ? `path "${path}" is under constitutional/ and explicitly listed in the invariant-implementer manifest`
      : `path "${path}" is listed in the invariant-implementer manifest (it implements an invariant)`;
    return { class: "DOCTRINE", confidence: 1, evidence: `${why} - any change here is governance-grade` };
  }

  const isDeletion = changeStatus === "deleted" || (newN === "" && oldN !== "");
  const isNewFile = changeStatus === "added" || (oldN === "" && newN !== "");

  // ---- No content change at all: insufficient to weigh. Halt, do not default. ----
  if (!isDeletion && !isNewFile && newN === oldN) {
    return {
      class: "UNRESOLVED",
      confidence: 1,
      evidence: `content for "${path}" is unchanged (after line-ending normalization) - no diff to classify (route to operator)`,
    };
  }

  // ---- Deletion of an existing file: a contract-bearing removal, but the class depends on
  //      what was removed. A source file with exports = CONTRACT; otherwise insufficient. ----
  if (isDeletion) {
    if (retirement && retirement.status === "retired" && retirement.decision) {
      const replacement = retirement.replacement ? `; replacement: ${retirement.replacement}` : "";
      return {
        class: "MINOR",
        confidence: 0.9,
        evidence: `file "${path}" was deleted as an explicitly retired surface (${retirement.decision}${replacement}) - recorded namespace cleanup, not silent removal`,
      };
    }
    if (path.startsWith(".github/workflows/")) {
      return {
        class: "PATCH",
        confidence: 0.75,
        evidence: `repository automation workflow "${path}" was removed; workflow-shape tests and branch protection carry the mechanical guardrails`,
      };
    }
    if (SOURCE_EXT.test(path) && exportedSymbols(oldN).size > 0) {
      return {
        class: "CONTRACT",
        confidence: 0.9,
        evidence: `source file "${path}" was deleted, removing its exported interface - a consumer-visible contract removal`,
      };
    }
    return {
      class: "UNRESOLVED",
      confidence: 0.7,
      evidence: `file "${path}" was deleted; deletion impact cannot be classified message-blind from content alone (route to operator)`,
    };
  }

  // ---- PATCH: test companions prove behavior; they do not grow runtime/API surface alone. ----
  if (isNewFile && isTestSourcePath(path)) {
    return {
      class: "PATCH",
      confidence: 0.85,
      evidence: `new test companion "${path}" - coverage/verification surface, not runtime/API surface growth`,
    };
  }

  // ---- KOHAI: new repository automation/governance scaffolding is structural but sub-minor. ----
  if (isNewFile && (isRepositoryAutomationPath(path) || isGovernanceAutomationPath(path))) {
    return {
      class: "KOHAI",
      confidence: 0.85,
      evidence: `new repository automation/governance surface "${path}" - structural maturity above PATCH and below MINOR`,
    };
  }

  // ---- KOHAI: new repository metadata/config is structural setup, not public API growth. ----
  if (isNewFile && isRepositoryMetadataPath(path)) {
    return {
      class: "KOHAI",
      confidence: 0.85,
      evidence: `new repository metadata/config surface "${path}" - structural maturity above PATCH and below MINOR`,
    };
  }

  // ---- KOHAI: dependency depot artifacts harden deployment/install closure without API growth. ----
  if (isNewFile && isDependencyDepotPath(path)) {
    return {
      class: "KOHAI",
      confidence: 0.85,
      evidence: `new dependency depot artifact "${path}" - install/deployment closure above PATCH and below MINOR`,
    };
  }

  // ---- MINOR: a brand-new runtime/source file is purely additive (grows the surface). ----
  if (isNewFile) {
    return {
      class: "MINOR",
      confidence: 0.95,
      evidence: `new file "${path}" - additive only (no prior content, nothing removed)`,
    };
  }

  // ---- COSMETIC: content is equal once whitespace / comments / formatting are stripped. ----
  // For markdown, '#' is heading syntax (load-bearing), not a comment - so a heading rewrite is
  // NOT cosmetic and falls through to the non-source UNRESOLVED route (operator).
  const isMarkdown = MARKDOWN_EXT.test(path);
  if (stripFormatting(oldN, isMarkdown) === stripFormatting(newN, isMarkdown)) {
    return {
      class: "COSMETIC",
      confidence: 0.9,
      evidence: `"${path}" changed only in whitespace / comments / formatting (content equal after stripping those)`,
    };
  }

  // ---- Interface analysis (source files only): did the exported contract shrink or grow? ----
  if (SOURCE_EXT.test(path)) {
    const before = exportedSymbols(oldN);
    const after = exportedSymbols(newN);
    const removed = [...before].filter((n) => !after.has(n));
    const added = [...after].filter((n) => !before.has(n));

    if (removed.length > 0) {
      // A removed/renamed export is a consumer-visible contract break.
      return {
        class: "CONTRACT",
        confidence: 0.85,
        evidence: `exported symbol(s) removed from "${path}": ${removed.join(", ")} - a consumer-visible interface break`,
      };
    }
    if (added.length > 0) {
      if (isGovernanceAutomationPath(path) || isGovernanceInstrumentationExport(path, added)) {
        return {
          class: "KOHAI",
          confidence: 0.85,
          evidence: `new governance/automation exported symbol(s) added to "${path}" with nothing removed: ${added.join(", ")} - structural maturity, not runtime/API surface growth`,
        };
      }
      // New exported symbol(s), nothing removed -> additive surface growth.
      return {
        class: "MINOR",
        confidence: 0.85,
        evidence: `new exported symbol(s) added to "${path}" with nothing removed: ${added.join(", ")} - additive`,
      };
    }
    if (isGovernancePolicyPath(path)) {
      return {
        class: "KOHAI",
        confidence: 0.85,
        evidence: `governance version/classifier policy "${path}" changed in place with the exported interface preserved - structural maturity above PATCH and below MINOR`,
      };
    }
    // Same export set, real content change -> an in-place modification, no interface removal.
    return {
      class: "PATCH",
      confidence: 0.8,
      evidence: `in-place modification of "${path}" with no change to the exported interface (no symbol added or removed)`,
    };
  }

  // ---- Known documentation and repository metadata surfaces. These are not source exports,
  //      but they are not opaque either: floor checks, append-only rules, source hygiene,
  //      and package/version gates provide the mechanical guardrails. A substantive edit here
  //      is a PATCH-class release-documentation/config update unless the path is manifest-listed,
  //      which was handled above as DOCTRINE. Unknown non-source files still halt below.
  if (isConstitutional) {
    return {
      class: "PATCH",
      confidence: 0.75,
      evidence: `downstream constitutional context mirror "${path}" changed substantively; GZDS remains upstream authority unless this path is manifest-promoted`,
    };
  }

  if (isKnownDocumentationPath(path)) {
    return {
      class: "PATCH",
      confidence: 0.75,
      evidence: `documentation artifact "${path}" changed substantively; floor/append-only/source-hygiene gates carry the mechanical guardrails`,
    };
  }

  if (isDependencyDepotPath(path)) {
    return {
      class: "KOHAI",
      confidence: 0.8,
      evidence: `dependency depot artifact "${path}" changed substantively; install/deployment verification carries the mechanical guardrails`,
    };
  }

  if (isRepositoryMetadataPath(path)) {
    return {
      class: "PATCH",
      confidence: 0.75,
      evidence: `repository metadata/config surface "${path}" changed substantively; package/version/automation gates carry the mechanical guardrails`,
    };
  }

  // ---- Non-source file (unknown docs, config, data) with a real content change. We can tell it is
  //      NOT cosmetic (stripping formatting did not equalize it) and NOT additive (it had prior
  //      content). Whether an unknown prose/config edit is a PATCH or a heavier change is a semantic
  //      judgment we cannot make message-blind from a non-source diff. Halt, do not default. ----
  return {
    class: "UNRESOLVED",
    confidence: 0.6,
    evidence: `unknown non-source file "${path}" had a substantive (non-formatting) content change; its weight cannot be classified message-blind from a non-code diff (route to operator)`,
  };
}

export default { classifyChange };
