// illuci/core/governance/authortime/floor-check.js
//
// The FLOOR aggregator + git changeset reader. The pure `runFloorChecks` runs every floor
// atom over a gathered changeset and collects violations; the impure `gatherChangeSet`
// reads the prior (HEAD) and proposed (staged index, or working tree) content the atoms
// need. The git pre-commit hook and CI call this today (a future PreToolUse adapter would call
// it too); keeping `runFloorChecks` pure keeps the decision logic unit-testable with no git.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkVersionTransition } from "./version-gate.js";
import { checkAppendOnly, APPEND_ONLY_LEDGERS } from "./append-only.js";
import { checkHeaderPreserved } from "./header.js";
import { checkBatchPrefix } from "./batch-prefix.js";
import { checkAttribution } from "./cast-trailer.js";
import { checkCrossSpokeImports } from "./cross-spoke-dr-citation.js";
import { checkDocPackPreserved } from "./doc-pack.js";
import { assessOperatorPause, ATOM as OPERATOR_PAUSE_ATOM, DEFAULT_POLICY as OPERATOR_PAUSE_DEFAULT_POLICY } from "./operator-pause.js";

// Default audit-trail policy. Each atom is "block" | "warn" | "off". Consumers determine
// their OWN audit posture by dropping a .illuci/floor-policy.json override (per-project) -
// illuci's substrate stance is "you decide how strict your trail is." Operator default: the
// two high-value atoms (odometer, append-only) BLOCK; the doc-pack header is valued
// (block). Ordinary documentation is Markdown; companion generation is not a floor atom.
export const DEFAULT_FLOOR_POLICY = Object.freeze({
  "version-gate": "block",
  "append-only": "block",
  "header": "block",
  "batch-prefix": "block",
  "cast-trailer": "warn",
  "cross-spoke-dr-citation": "block",
  "doc-pack": "block",
  [OPERATOR_PAUSE_ATOM]: OPERATOR_PAUSE_DEFAULT_POLICY,
});

/**
 * PURE aggregator. Runs the floor atoms over a gathered changeset and classifies each
 * violation by the policy ("block" gates the commit, "warn" is advisory, "off" is ignored).
 * An unknown atom defaults to "block" (fail-closed). Returns blocking + warnings separately.
 * @param {object} changeSet  { version?:{prior,proposed}, ledgers?:[{file,prior,proposed}], message?:string, rootFiles?:{prior:string[], after:string[]} }
 * @param {object} [policy]   { atom: "block"|"warn"|"off" }, merged over DEFAULT_FLOOR_POLICY
 * @returns {{ok:boolean, blocking:Array, warnings:Array}}
 */
export function runFloorChecks(changeSet, policy) {
  const cs = changeSet || {};
  const pol = { ...DEFAULT_FLOOR_POLICY, ...(policy || {}) };
  const raw = [];

  // Message-scope atom: the commit subject must open with a batch prefix / [HOTFIX]. Inert
  // when the surface supplies no message (cs.message null/absent) - the content-diff atoms
  // never see the message, so this is the only atom that reads it.
  if (cs.message != null) {
    const b = checkBatchPrefix(cs.message);
    if (!b.ok) raw.push({ atom: "batch-prefix", file: "COMMIT_MSG", code: b.code, reason: b.reason });
    // Attribution discipline (Bill of Standards, Standard 15): Git authorship stays with
    // the human operator; model-named Co-Authored-By trailers are provenance mistakes.
    // Warn-tier attribution. Message-scope, so it lives beside batch-prefix.
    const at = checkAttribution(cs.message);
    if (!at.ok) raw.push({ atom: "cast-trailer", file: "COMMIT_MSG", code: at.code, reason: at.reason });
  }

  if (cs.version && cs.version.proposed != null) {
    const v = checkVersionTransition(cs.version.prior, cs.version.proposed);
    if (!v.ok) raw.push({ atom: "version-gate", file: "VERSION", code: v.code, reason: v.reason });
  }
  for (const led of cs.ledgers || []) {
    const a = checkAppendOnly(led.prior, led.proposed);
    if (!a.ok) raw.push({ atom: "append-only", file: led.file, code: a.code, line: a.line ?? null, reason: a.reason });
  }
  for (const dp of cs.docPack || []) {
    const h = checkHeaderPreserved(dp.prior, dp.proposed);
    if (!h.ok) raw.push({ atom: "header", file: dp.file, code: h.code, reason: h.reason });
  }
  for (const op of cs.operatorPause || cs.docPack || []) {
    const p = assessOperatorPause(op.file, op.prior, op.proposed);
    if (!p.ok) raw.push({ atom: OPERATOR_PAUSE_ATOM, file: op.file, code: p.code, route: p.route, reason: p.reason, signals: p.signals });
  }
  // Source-scope atom: each changed source file's cross-spoke imports must cite a DR (DR-045).
  // The atom is supplied each file's proposed content; opts.spokeOf defaults inside the atom.
  for (const sf of cs.sources || []) {
    const x = checkCrossSpokeImports(sf.file, sf.proposed, { spokeOf: sf.spokeOf });
    if (!x.ok) raw.push({ atom: "cross-spoke-dr-citation", file: sf.file, code: x.code, reason: x.reason, violations: x.violations });
  }
  // Root-scope atom: a GZS-managed root must keep the canonical 9 + VERSION whole. The
  // preservation variant scopes the block to members THIS change removed (false-positive-free
  // on a pre-existing partial pack). Inert when the surface supplies no rootFiles listing.
  if (cs.rootFiles && Array.isArray(cs.rootFiles.after)) {
    const d = checkDocPackPreserved(cs.rootFiles.prior, cs.rootFiles.after);
    if (!d.ok) raw.push({ atom: "doc-pack", file: "VERSION", code: d.code, reason: d.reason, removed: d.removed });
  }

  const blocking = [];
  const warnings = [];
  for (const v of raw) {
    const mode = pol[v.atom] || "block";
    if (mode === "off") continue;
    (mode === "warn" ? warnings : blocking).push(v);
  }
  return { ok: blocking.length === 0, blocking, warnings };
}

function gitShow(repoRoot, spec) {
  try {
    return execFileSync("git", ["-C", repoRoot, "show", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // absent at that ref / not tracked
  }
}

function readWorkingTree(repoRoot, file) {
  const p = join(repoRoot, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Resolve the merge-base of HEAD and a base ref (e.g. origin/main). null if it can't. */
function mergeBase(repoRoot, baseRef) {
  try {
    return execFileSync("git", ["-C", repoRoot, "merge-base", baseRef, "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function gitNames(repoRoot, gitArgs) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...gitArgs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Tracked top-level (root-only, no recursion) entry names at a ref - the doc-pack listing. */
function gitRootEntries(repoRoot, ref) {
  return gitNames(repoRoot, ["ls-tree", "--name-only", ref]);
}

/** Live top-level entry names in the working-tree root - the after-state doc-pack listing. */
function readRootEntries(repoRoot) {
  try {
    return readdirSync(repoRoot);
  } catch {
    return [];
  }
}


function listChanged(repoRoot, { staged, baseSpec }) {
  // base-ref mode: diff the merge-base against HEAD so the PR's COMMITTED changes are seen
  // (a PR checkout lands its changes at HEAD; `git diff HEAD` would be empty). The merge-base
  // diff already includes added files, so no untracked pass is needed.
  if (baseSpec) return gitNames(repoRoot, ["diff", `${baseSpec}...HEAD`, "--name-only"]);
  // staged mode: `diff --cached` already lists newly-staged (added) files.
  if (staged) return gitNames(repoRoot, ["diff", "--cached", "--name-only"]);
  // working-tree mode: `git diff HEAD` lists tracked modifications but NEVER untracked files.
  // A brand-new ledger / doc-pack file added but not yet staged would be invisible to the
  // header + root-doc atoms. Union the tracked-vs-HEAD diff with the untracked working files
  // (--others, honoring .gitignore via --exclude-standard) so a new doc is also weighed.
  const tracked = gitNames(repoRoot, ["diff", "HEAD", "--name-only"]);
  const untracked = gitNames(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])];
}

/**
 * IMPURE. Gather the prior and proposed content for VERSION + the append-only ledgers + the
 * changed doc-pack/.md files, for the floor atoms to weigh. Three modes:
 *   - staged (default)  : proposed = the staged index, prior = HEAD. Pre-commit-hook semantics.
 *   - working (staged:false) : proposed = the working tree, prior = HEAD. Local working-tree check.
 *   - base-ref (base:"origin/main") : proposed = HEAD (the PR tip), prior = the merge-base of
 *     base and HEAD. THIS is the mode CI must use: on a GitHub Actions PR checkout the PR's
 *     changes are already COMMITTED at HEAD, so diffing against HEAD (the working/staged modes)
 *     sees nothing and the gate is a no-op. base-ref diffs the merge-base...HEAD instead, so an
 *     illegal bump or a ledger history-edit IN THE PR is actually inspected. If the base ref or
 *     its merge-base cannot be resolved, this returns an empty changeset (fail-safe: no false
 *     verdict from a half-resolved diff).
 * @param {string} repoRoot
 * @param {{staged?:boolean, base?:string}} [opts]
 * @returns {{version:({prior,proposed}|null), ledgers:Array, docPack:Array, operatorPause:Array, sources:Array, rootFiles:{prior:string[], after:string[]}}}
 */
export function gatherChangeSet(repoRoot = process.cwd(), opts = {}) {
  const staged = opts.staged !== false;
  const baseRef = opts.base ? String(opts.base) : null;
  // In base-ref mode, resolve the merge-base once; both content reads and the name diff use it.
  const baseSpec = baseRef ? mergeBase(repoRoot, baseRef) : null;
  if (baseRef && !baseSpec) {
    // Asked for base-ref mode but the base/merge-base could not be resolved. Do NOT silently
    // fall back to a HEAD diff (that is the no-op the base-ref mode exists to fix); return an
    // empty changeset so the caller sees "nothing to check" rather than a false-clean verdict.
    return { version: null, ledgers: [], docPack: [], operatorPause: [], sources: [], rootFiles: { prior: [], after: [] } };
  }

  // proposed = HEAD (PR tip) in base-ref mode; staged index or working tree otherwise.
  // prior = the merge-base in base-ref mode; HEAD otherwise.
  const proposedOf = (file) =>
    baseSpec ? gitShow(repoRoot, `HEAD:${file}`) : staged ? gitShow(repoRoot, `:${file}`) : readWorkingTree(repoRoot, file);
  const priorOf = (file) => gitShow(repoRoot, `${baseSpec ? baseSpec : "HEAD"}:${file}`);
  const firstLine = (s) => (s == null ? null : s.split(/\r?\n/)[0].trim() || null);

  const versionProposedRaw = proposedOf("VERSION");
  const version = versionProposedRaw == null
    ? null
    : { prior: firstLine(priorOf("VERSION")), proposed: firstLine(versionProposedRaw) };

  const ledgers = [];
  for (const file of APPEND_ONLY_LEDGERS) {
    const proposed = proposedOf(file);
    if (proposed == null) continue;
    ledgers.push({ file, prior: priorOf(file) || "", proposed });
  }

  // Header preservation runs over every changed .md. The header atom only fires when prior
  // content actually had a doc-pack header, so runtime markdown remains inert.
  const changed = listChanged(repoRoot, { staged, baseSpec });
  const changedMd = changed.filter((f) => f.toLowerCase().endsWith(".md"));
  const docPack = changedMd.map((f) => ({ file: f, prior: priorOf(f) || "", proposed: proposedOf(f) || "" }));

  // cross-spoke-dr-citation runs over the changed SOURCE files (only the proposed content is
  // needed - the rule is content-only, no prior). spokeOf is left unset so the atom uses its
  // own DEFAULT_SPOKES (the GZDS four-spoke map); a consumer with a different topology can pass
  // its own map by post-processing the changeset before runFloorChecks.
  const changedSrc = changed.filter((f) => /\.(tsx?|jsx?|mjs|cjs)$/i.test(f));
  const sources = changedSrc.map((f) => ({ file: f, proposed: proposedOf(f) || "" }));
  const operatorPause = [
    ...docPack,
    ...changedSrc.map((f) => ({ file: f, prior: priorOf(f) || "", proposed: proposedOf(f) || "" })),
  ];

  // doc-pack: the root-directory listing BEFORE and AFTER the change. The atom (preservation
  // variant) needs the top-level filenames at the governance root in both states to detect a
  // dropped pack member. `git ls-tree <ref>` gives the tracked root entries at a ref; the
  // after-state listing in working/staged mode reads the live root dir (so a just-deleted but
  // not-yet-committed file is correctly absent). In base-ref mode both come from a tree at a ref.
  const priorRootRef = baseSpec ? baseSpec : "HEAD";
  const priorRootFiles = gitRootEntries(repoRoot, priorRootRef);
  const afterRootFiles = baseSpec ? gitRootEntries(repoRoot, "HEAD") : readRootEntries(repoRoot);
  const rootFiles = { prior: priorRootFiles, after: afterRootFiles };

  return { version, ledgers, docPack, operatorPause, sources, rootFiles };
}

/**
 * Load the per-project audit-trail policy from <repoRoot>/.illuci/floor-policy.json, merged
 * over the default. Absent or malformed -> the operator default (fail-safe). The file is a
 * flat { atom: "block"|"warn"|"off" } map, or { "atoms": {...} }.
 */
export function loadPolicy(repoRoot = process.cwd()) {
  const p = join(repoRoot, ".illuci", "floor-policy.json");
  if (!existsSync(p)) return { ...DEFAULT_FLOOR_POLICY };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const override = raw && raw.atoms && typeof raw.atoms === "object" ? raw.atoms : raw;
    return { ...DEFAULT_FLOOR_POLICY, ...(override && typeof override === "object" ? override : {}) };
  } catch {
    return { ...DEFAULT_FLOOR_POLICY };
  }
}

export default { runFloorChecks, gatherChangeSet, loadPolicy, DEFAULT_FLOOR_POLICY };
