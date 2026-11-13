// illuci/core/governance/authortime/ceiling/operator-pause.js
//
// Ceiling: the operator-mediated-pause adherence rule (constitutional/CONSTITUTION.md).
//
// The most common drift constitutional/CONSTITUTION.md names is "continuing past a decision point
// silently" - an agent locking a naming / structural decision, or listing options as already
// ratified, without the operator pause that material decisions are owed. The companion failure
// modes are "Making decisions and listing them as ratified" and "Naming conventions or product
// specifics without ratification." This atom surfaces a heuristic flag when GOVERNANCE-GRADE
// added text asserts a locked decision but carries no operator-ownership marker nearby.
//
// It is intrinsically a JUDGMENT (the doc itself calls operator-mediated execution a creative,
// skill-based act, not a procedure), so this is a WARN-TIER atom: it never blocks. It proposes;
// the operator disposes. It emits to the ceiling's operator-route channel (mirroring
// haltDontDefault's { route: "operator" } posture) so an ambiguous self-ratification surfaces to
// the operator rather than being waved through OR hard-blocked. The atom is the proposer, the
// operator is the gate.
//
// SCOPE - governance-grade text surfaces only. A self-ratification sentence in a scratch note or
// ordinary source code is not the failure this guards; the failure is locking a decision in an
// active hub/design surface or adding explanatory drift in specification prose / source comments
// without a marked exposition surface. So it fires when the path is:
//   - a hub doc (CORE / ARCHITECTURE / GOVERNANCE / DECISION_REGISTRY.md)
//   - a design markdown (matches /design\/.*\.md$/)
//   - a source file comment (code statements and strings remain outside this text classifier)
// Everything else returns ok:true (out of scope), including illuci's downstream constitutional/
// context mirror unless a later governed rule explicitly promotes a path into active doctrine.
//
// MESSAGE-BLIND, CONTENT-DIFF ONLY. It reads only the file's prior + proposed content, never the
// commit message / PR title (an untrusted self-report). It scans the ADDED lines (the
// LE-normalized set-difference newContent \ oldContent) - so re-stating an already-committed
// locked decision is not re-flagged; only NEWLY introduced lock-language is.
//
// STYLE: pure function, JSDoc, clock-free (no Date.now() / Math.random() - deterministic given
// inputs; any timestamp would be a param). Returns { ok, code, reason, signals? }.

import { classifyOntologyDrift } from "../../classifiers/ontology-drift-classifier.js";

/** Hub docs: the top-level governance surfaces where semantic promotion most dangerously lands. */
const HUB_DOCS = Object.freeze([
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CLAUDE.md",
  "COMPONENTS.md",
  "CONTEXT.md",
  "CORE.md",
  "DECISION_REGISTRY.md",
  "DOCTRINE.md",
  "GOVERNANCE.md",
  "HIVEMIND.md",
  "ILLUCI.md",
  "README.md",
  "ROADMAP.md",
  "SESSION_STATE.md",
]);

/** A design markdown anywhere under a design/ directory. */
const DESIGN_MD_RE = /design\/.*\.md$/;
/** Source files whose added comments can carry unmarked exposition drift. */
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i;

// A locked-decision verb: the text asserts a decision is settled.
const RATIFIED_RE = /\b(ratified|locked|finalized|decided|chosen)\b/i;
// A decision noun: WHAT was settled - the operator-owned material-decision surface.
const DECISION_RE = /\b(name|naming|convention|architecture|schema|default|option)\b/i;
// An operator-ownership / still-open marker: presence anywhere in the proposed content's
// context means the decision is being routed to the operator (proposed / pending / deliberation),
// not unilaterally locked.
const OPERATOR_RE = /\b(pending ratification|proposed|deliberation|awaiting|operator approval|operator ratification|operator-owned|route to operator)\b/i;

// Semantic-promotion markers. Operator speech is useful context; it becomes governance only
// when tied to an explicit ratification/evidence source.
const OPERATOR_SPEECH_RE = /\b(operator|user|conversation|chat|prompt|utterance|frustration|metaphor|exploratory claim|stance)\b/i;
const DOCTRINE_PROMOTION_RE = /\b(canonical|doctrine|governance|standard|policy|truth|architecture|must|shall|source of truth)\b/i;
const PROMOTION_AUTHORITY_RE = /\b(DR-\d+|decision record|ratified|operator-ratified|batch log|BATCH_LOG|DECISION_REGISTRY|verified|repo evidence|source evidence|implementation evidence)\b/i;

// Spec-prose posture markers. These are advisory only: scoped safety/compatibility boundaries
// can state exclusions; ordinary artifact definitions should state the canonical shape directly.
const NEGATIVE_QUALIFIER_RE = /\b(we|this|the batch|the system|illuci|a\d+(?:\.\d+)*)\s+(does not|will not|is not|doesn't|won't|should not|must not|never)\b|\b(instead of|rather than|not\b.+\bbut)\b/i;
const BOUNDARY_CONTEXT_RE = /\b(non[- ]?goals?|safety|compatibility|boundary|boundaries|deprecated|retired|reserved|secret|private|protected|prevent|guard|exclusion|excluded|avoid|must not be adopted)\b/i;

// Exposition discipline. Explanatory/rationale prose is valid when deliberately marked or
// recorded in a typed surface; otherwise it becomes specification bloat and should route to the
// operator as advisory drift.
const EXPOSITION_MARKER_RE = /\b(because|so that|in order to|therefore|this means|that means|the reason|why|explains?|teaches|illustrates|helps|lets|allows)\b/i;
const EXPOSITION_LABEL_RE = /^\s*(?:[*_]{0,2})?(rationale|context|non[- ]?goals?|examples?|decision|finding|batch(?: note)?|provenance|audit|origin|consequences)\s*[:|-]/i;
const EXPOSITION_HEADING_RE = /^#{1,6}\s+(rationale|context|non[- ]?goals?|examples?|decision|finding|batch(?: note)?|provenance|audit|origin|consequences)\b/i;
const EXPOSITION_REQUEST_RE = /\b(operator[- ]requested|requested by the operator|operator asked|operator-directed|operator direction|operator-ratified|DR-\d+|decision record|batch log|finding)\b/i;
const EXPOSITION_RECORD_FILES = new Set(["BATCH_LOG.md", "DECISION_REGISTRY.md", "FINDINGS.md"]);
const EXPOSITION_RECORD_PREFIX_RE = /^(provenance|design\/handoffs|design\/audits|core\/governance\/compiler\/audit)\//;
const COMMENT_LINE_RE = /^\s*(?:\/\/|#|\/\*+|\*\/?|\*)\s?(.*)$/;
const COMMENT_TAG_RE = /^\s*@(?:param|returns?|throws|typedef|type|template|see|deprecated|private|internal)\b/i;

// Retired ontology and integration terms stay available for explicit retirement/provenance
// notes; fresh canonical prose should not reintroduce them as live concepts.
const RETIRED_TERM_RE = /\.neocli\b|\bneocli\b|\brunArrangement\b|@gzds\/illuci|gz-development-system\/illuci/i;
const STALE_ILLUCI_PATH_RE = /\bILLUCI[\\/]/;
const RETIRED_CONTEXT_RE = /\b(EON|deprecated|retired|legacy|historical|migration|provenance|cleanup|replace|replacement|removed|superseded|readable)\b/i;
const DESIGN_PATH_RE = /^design\/.*\.md$/;
const STATUS_HEADER_RE = /^\|\s*Status\s*\|[^|]*\|/mi;

/** Normalize line endings so a CRLF<->LF delta is never a false positive. */
function normalizeLE(s) {
  return String(s == null ? "" : s).replace(/\r\n/g, "\n");
}

/** Normalize a path to posix separators and strip a leading "./". */
function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The basename of a posix path. */
function baseName(posix) {
  const i = posix.lastIndexOf("/");
  return i === -1 ? posix : posix.slice(i + 1);
}

/**
 * Is `path` a governance-grade text surface this atom evaluates?
 * @param {string} posixPath  already-normalized posix path
 * @returns {boolean}
 */
function inScope(posixPath) {
  if (!posixPath) return false;
  if (HUB_DOCS.includes(baseName(posixPath))) return true;
  if (DESIGN_MD_RE.test(posixPath)) return true;
  if (SOURCE_EXT.test(posixPath)) return true;
  return false;
}

function isGovernanceTextPath(posixPath) {
  if (!posixPath) return false;
  if (HUB_DOCS.includes(baseName(posixPath))) return true;
  if (DESIGN_MD_RE.test(posixPath)) return true;
  return false;
}

function isSourcePath(posixPath) {
  return SOURCE_EXT.test(posixPath);
}

/**
 * The set of lines ADDED in newContent relative to oldContent (LE-normalized set-difference:
 * lines present in newContent that were not present anywhere in oldContent). This intentionally
 * uses set membership, not positional diff, so that re-stating a line that already existed in the
 * prior content (re-ordering, moving a paragraph) is NOT counted as added - only genuinely new
 * text is scanned. Each entry keeps the 1-based line number within newContent for citation.
 * @param {string} oldN  LE-normalized prior content
 * @param {string} newN  LE-normalized proposed content
 * @returns {Array<{line:number, text:string}>}
 */
function addedLines(oldN, newN) {
  const oldSet = new Set(oldN.split("\n"));
  const out = [];
  const lines = newN.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!oldSet.has(text)) out.push({ line: i + 1, text });
  }
  return out;
}

/**
 * Return the closest heading line above `line`.
 * @param {string[]} lines
 * @param {number} line 1-based line number
 * @returns {string}
 */
function nearestHeading(lines, line) {
  for (let i = Math.max(0, line - 2); i >= 0; i--) {
    if (/^#{1,6}\s+/.test(lines[i])) return lines[i];
  }
  return "";
}

/**
 * Local context for line-level advisory rules.
 * @param {string[]} lines
 * @param {number} line 1-based line number
 * @returns {string}
 */
function localContext(lines, line) {
  const i = line - 1;
  return [
    nearestHeading(lines, line),
    lines[Math.max(0, i - 1)] || "",
    lines[i] || "",
    lines[Math.min(lines.length - 1, i + 1)] || "",
  ].join("\n");
}

function isExpositionRecordPath(posix) {
  return EXPOSITION_RECORD_FILES.has(baseName(posix)) || EXPOSITION_RECORD_PREFIX_RE.test(posix);
}

function markedExpositionContext(posix, ctx, text) {
  if (isExpositionRecordPath(posix)) return true;
  if (EXPOSITION_HEADING_RE.test(ctx)) return true;
  if (EXPOSITION_LABEL_RE.test(ctx) || EXPOSITION_LABEL_RE.test(text)) return true;
  if (EXPOSITION_REQUEST_RE.test(ctx)) return true;
  return false;
}

function commentPayload(line) {
  const m = COMMENT_LINE_RE.exec(line);
  if (!m) return null;
  const text = (m[1] || "").trim();
  if (!text) return null;
  if (COMMENT_TAG_RE.test(text)) return null;
  if (/^(eslint|istanbul|c8|ts-ignore|ts-expect-error)\b/i.test(text)) return null;
  return text;
}

function buildSignals(added, lines) {
  const out = [];
  for (const a of added) {
    const ctx = localContext(lines, a.line);
    if (OPERATOR_SPEECH_RE.test(a.text) && DOCTRINE_PROMOTION_RE.test(a.text) && !PROMOTION_AUTHORITY_RE.test(ctx)) {
      out.push({ line: a.line, text: a.text, code: "unratified-operator-promotion" });
      continue;
    }
    if (NEGATIVE_QUALIFIER_RE.test(a.text) && !BOUNDARY_CONTEXT_RE.test(ctx)) {
      out.push({ line: a.line, text: a.text, code: "negative-qualifier-clutter" });
      continue;
    }
    if ((RETIRED_TERM_RE.test(a.text) || STALE_ILLUCI_PATH_RE.test(a.text)) && !RETIRED_CONTEXT_RE.test(ctx)) {
      out.push({ line: a.line, text: a.text, code: "retired-term-reuse" });
    }
  }
  return out;
}

function buildExpositionSignals(posix, added, lines) {
  if (isExpositionRecordPath(posix)) return [];
  const source = isSourcePath(posix);
  const out = [];
  for (const a of added) {
    const ctx = localContext(lines, a.line);
    const text = source ? commentPayload(a.text) : a.text.trim();
    if (!text) continue;
    if (source && !COMMENT_LINE_RE.test(a.text)) continue;
    if (!EXPOSITION_MARKER_RE.test(text)) continue;
    if (markedExpositionContext(posix, ctx, text)) continue;
    if (BOUNDARY_CONTEXT_RE.test(ctx)) continue;
    out.push({ line: a.line, text: a.text, code: "unmarked-exposition" });
  }
  return out;
}

function buildDesignStatusSignals(posix, oldN, newN) {
  if (!DESIGN_PATH_RE.test(posix)) return [];
  if (oldN.trim()) return [];
  if (STATUS_HEADER_RE.test(newN)) return [];
  return [{
    line: 1,
    text: "design markdown added without a Status header",
    code: "design-archive-status-missing",
  }];
}

function buildOntologySignals(posix, oldN, newN) {
  const verdict = classifyOntologyDrift({ path: posix, oldContent: oldN, newContent: newN });
  if (verdict.allowed) return [];
  return verdict.signals.map((signal) => ({
    line: signal.data?.line || 1,
    text: signal.data?.text || signal.evidence,
    code: signal.code,
    term: signal.data?.term || null,
    canonical: signal.data?.canonical || null,
    next: signal.next || verdict.next,
  }));
}

/**
 * Heuristic operator-mediated-pause check for one governance-grade text surface.
 *
 * Out of scope -> ok:true (the signal stays high). In scope, it scans the ADDED lines for
 * self-ratification language: a same-line co-occurrence of a locked-decision verb (RATIFIED_RE)
 * and a decision noun (DECISION_RE), WHILE the proposed content carries no operator-ownership
 * marker (OPERATOR_RE) anywhere - i.e. the decision is asserted settled with no pause routed to
 * the operator. Each qualifying line becomes a signal. Any signal -> ok:false (WARN-tier: this
 * routes to the operator, it never blocks the commit).
 *
 * @param {string} path        repo-relative path of the changed file (posix or windows ok)
 * @param {string} oldContent  prior committed content (empty/null = new file)
 * @param {string} newContent  proposed content
 * @returns {{ok:boolean, code:string, reason:string, signals?:Array<{line:number,text:string,code?:string}>}}
 *   ok:true  -> out-of-scope | ok
 *   ok:false -> unratified-lock-language  (with the qualifying signal lines; routes to operator)
 */
export function checkOperatorPause(path, oldContent, newContent) {
  const posix = normalizePath(path);
  if (!inScope(posix)) {
    return { ok: true, code: "out-of-scope", reason: `"${posix}" is not a governance-grade text surface; operator-pause check does not apply` };
  }

  const oldN = normalizeLE(oldContent);
  const newN = normalizeLE(newContent);

  const lines = newN.split("\n");
  const added = addedLines(oldN, newN);
  const textScope = isGovernanceTextPath(posix);
  const lockSignals = textScope
    ? added
        .filter((a) => RATIFIED_RE.test(a.text) && DECISION_RE.test(a.text) && !OPERATOR_RE.test(localContext(lines, a.line)))
        .map((a) => ({ ...a, code: "unratified-lock-language" }))
    : [];
  const postureSignals = textScope ? buildSignals(added, lines) : [];
  const designStatusSignals = textScope ? buildDesignStatusSignals(posix, oldN, newN) : [];
  const expositionSignals = buildExpositionSignals(posix, added, lines);
  const ontologySignals = buildOntologySignals(posix, oldN, newN);
  const signals = [...lockSignals, ...postureSignals, ...designStatusSignals, ...expositionSignals, ...ontologySignals];

  if (signals.length > 0) {
    const codes = [...new Set(signals.map((sig) => sig.code))];
    return {
      ok: false,
      code: codes.length === 1 ? codes[0] : "operator-pause-advisory",
      signals,
      reason: `added governance-grade text needs operator review (${signals.length} line(s)): ${codes.join(", ")}`,
    };
  }

  return { ok: true, code: "ok", reason: "no unilateral-lock language detected" };
}

export default { checkOperatorPause };
