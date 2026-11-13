// illuci/core/governance/authortime/ceiling-check.js
//
// The CEILING aggregator. Where floor-check.js answers "is this change mechanically LEGAL",
// ceiling-check describes change class and reach, then uses evidenced delivery scope for credit. It
// composes the three ceiling atoms over a gathered changeset:
//
//   ceiling/graph.js     -> bandOf(spoke): the relational standing (LEAF | INTERMEDIATE |
//                           HUB | SUBSTRATE) of WHERE a change lands.
//   ceiling/semantic.js  -> classifyChange(): the message-blind semantic class of WHAT the
//                           change is (COSMETIC..DOCTRINE | UNRESOLVED).
//   ceiling/elevation.js -> elevate() + the five amendments: combine class x band into an
//                           review class, preserve reach separately, check evidence presence,
//                           batch-level max, halt-don't-default, and un-DR'd-edge-is-doctrine.
//
// The output is ADVISORY. The ceiling never blocks a commit by construction - it proposes a
// tier and surfaces halts that route to the operator (operator-mediated execution,
// constitutional/02). The floor is the unattended pass/fail gate; the ceiling is the attended
// judgment layer. ceiling-check-cli.mjs prints this and ALWAYS exits 0.
//
// STYLE: pure aggregator (runCeiling takes the changeSet + a prebuilt graph + manifest as
// params - no I/O, no clock), JSDoc, no Date.now()/Math.random().

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bandOf, SPOKES, HUB_NODE } from "./ceiling/graph.js";
import { classifyChange } from "./ceiling/semantic.js";
import {
  elevate,
  versionAction,
  failClosedOnEvidence,
  maxClass,
  haltDontDefault,
  unDrEdgeIsDoctrine,
} from "./ceiling/elevation.js";
import { assessWarehouseIntakeCoordinates } from "../belt/warehouse-intake.js";

/** Normalize a path to repo-relative posix form (strip leading "./", backslashes -> "/"). */
function normalizePath(p) {
  return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Resolve a repo-relative posix path to its owning spoke node (or the hub node when the path
 * sits outside every spoke). Mirrors graph.js's own classifier (its SPOKES prefix map) so the
 * band lookup uses the same notion of which spoke a file belongs to.
 * @param {string} relPosix
 * @returns {string} a graph node name (a spoke, or HUB_NODE)
 */
function spokeOf(relPosix) {
  const rel = normalizePath(relPosix);
  for (const [spoke, prefixes] of Object.entries(SPOKES)) {
    for (const p of prefixes) {
      if (rel === p || rel.startsWith(p + "/")) return spoke;
    }
  }
  return HUB_NODE;
}

function retirementFor(path, retirements) {
  const rel = normalizePath(path);
  if (!retirements) return null;

  const matches = (entry) => {
    if (!entry) return false;
    const entryPath = normalizePath(entry.path);
    const prefix = normalizePath(entry.prefix);
    return (entryPath && entryPath === rel) || (prefix && (rel === prefix || rel.startsWith(prefix)));
  };

  if (Array.isArray(retirements)) {
    return retirements.find(matches) || null;
  }

  if (Array.isArray(retirements.surfaces)) {
    return retirements.surfaces.find(matches) || null;
  }

  if (retirements && typeof retirements === "object") {
    const direct = retirements[rel] || retirements[path];
    return direct && typeof direct === "object" ? direct : null;
  }

  return null;
}

/**
 * Aggregate the ceiling over a changeset. PURE - the graph is prebuilt by the caller (the
 * scan lives in graph.buildGraph, an I/O step done once outside this aggregator) and the
 * manifest is passed in, so runCeiling itself reads no disk and no clock.
 *
 * For each change it: classifies the semantic class (message-blind), resolves the owning
 * spoke's relational band, retains semantic class alongside the independently observed band, and runs the
 * amendments. UNRESOLVED / unknown classes raise a HALT (routed to the operator, never
 * defaulted). Missing-evidence changes raise a HALT too (fail-closed, Amendment 2). The
 * batch's proposedClass is the single highest effective class (Amendment 3); un-DR'd
 * cross-spoke edges are folded in as DOCTRINE findings (Amendment 5).
 *
 * @param {object} changeSet
 *   @param {Array<{path:string, oldContent?:string, newContent?:string, status?:string, evidence?:(string|Array)}>} [changeSet.changes]
 *          the per-file changes to weigh.
 *   @param {Array<{from?:string,to?:string,dr?:(string|null)}>} [changeSet.unDrEdges]
 *          cross-spoke edges the caller already determined lack a governing DR.
 *   @param {{kind:'correction'|'increment'|'completed-feature'|'completed-group', evidence:(string|Array), operatorSelection?:string}} [changeSet.versionScope]
 *          evidenced batch scope: unfinished feature increment or completed feature/module.
 * @param {object} opts
 *   @param {{nodes:string[],edges:Array}} opts.graph     a prebuilt consumption graph (graph.buildGraph).
 *   @param {(string[]|{paths:string[]})} [opts.manifest]  the invariant-implementer manifest (semantic.js DOCTRINE source).
 * @returns {{proposedClass:string, versionAction:string, evidence:Array, warnings:Array, halts:Array, changes:Array}}
 */
export function runCeiling(changeSet, opts = {}) {
  const cs = changeSet || {};
  const graph = opts.graph || { nodes: [], edges: [] };
  const manifest = opts.manifest;

  const changes = Array.isArray(cs.changes) ? cs.changes : [];
  const evidence = [];
  const warnings = [];
  const halts = [];
  const effectiveClasses = [];
  const perChange = [];

  for (const ch of changes) {
    const c = ch || {};
    const path = normalizePath(c.path);
    const spoke = spokeOf(path);
    const band = bandOf(spoke, graph);

    const intake = assessWarehouseIntakeCoordinates({
      path,
      oldContent: c.oldContent,
      newContent: c.newContent,
    });
    for (const finding of intake.findings || []) {
      halts.push({
        file: path,
        code: finding.code,
        route: finding.route || "operator",
        reason: finding.reason,
        intake: finding,
      });
    }

    const semantic = classifyChange({
      path,
      oldContent: c.oldContent,
      newContent: c.newContent,
      status: c.status,
      manifest,
      retirement: retirementFor(path, opts.retirements),
    });

    // Amendment 4 - halt, don't default. An UNRESOLVED / unknown class routes to the operator
    // and does NOT contribute a (defaulted-low) class to the batch max.
    const halt = haltDontDefault(semantic.class);
    if (halt.halt) {
      halts.push({ file: path, code: halt.code, route: halt.route, reason: halt.reason, semantic });
      perChange.push({ file: path, spoke, band, semanticClass: semantic.class, effectiveClass: null, halted: true });
      continue;
    }

    // Amendment 2 - fail-closed on evidence. The semantic atom always emits an evidence
    // string, so a resolved class is evidenced by construction; we still run the check so a
    // caller that strips evidence is caught. A no-evidence change halts (it is not scored).
    const ev = failClosedOnEvidence({ class: semantic.class, evidence: c.evidence ?? semantic.evidence });
    if (ev.block) {
      halts.push({ file: path, code: ev.code, route: "operator", reason: ev.reason, semantic });
      perChange.push({ file: path, spoke, band, semanticClass: semantic.class, effectiveClass: null, halted: true });
      continue;
    }

    // Amendment 1 - bounded reach. elevate class x band into the effective class.
    const effective = elevate(semantic.class, band);
    effectiveClasses.push(effective);
    evidence.push({ file: path, spoke, band, semanticClass: semantic.class, effectiveClass: effective, why: semantic.evidence });
    perChange.push({ file: path, spoke, band, semanticClass: semantic.class, effectiveClass: effective, halted: false });
  }

  // Amendment 5 - un-DR'd cross-spoke edges are DOCTRINE findings; fold them into the batch.
  const undr = unDrEdgeIsDoctrine(cs.unDrEdges);
  if (!undr.ok) {
    for (const f of undr.findings) {
      effectiveClasses.push(f.class); // DOCTRINE - pulls the batch up via maxClass
      warnings.push({ kind: "un-dr-edge", edge: f.edge, code: f.code, reason: f.reason });
      evidence.push({ edge: f.edge, semanticClass: f.class, effectiveClass: f.class, why: f.reason });
    }
  }

  // Amendment 3 - the batch is scored at its single highest effective class.
  const proposedClass = maxClass(effectiveClasses);
  const action = versionAction(proposedClass, cs.versionScope);
  if (action === "scope-assessment-required") {
    warnings.push({
      kind: "version-scope",
      code: "scope-assessment-required",
      reason: "API/code growth requires an evidenced scope assessment: increment of an unfinished feature (kohai), or completed feature/module (minor).",
    });
  }

  return {
    proposedClass,
    versionAction: action,
    evidence,
    warnings,
    halts,
    changes: perChange,
  };
}

/* ----------------------------------------------------------------------------------------- *
 * IMPURE changeset gathering. The pure runCeiling above is the testable core; the gatherer
 * below reads git so the advisory CLI can feed real diffs in. It mirrors floor-check.js's
 * gatherChangeSet (same staged-index-vs-working-tree semantics) but emits the per-file
 * {path, oldContent, newContent, status} shape the semantic atom needs.
 * ----------------------------------------------------------------------------------------- */

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

function gitNames(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve the merge-base of HEAD and a base ref (e.g. origin/main). null if it can't. */
function mergeBase(repoRoot, baseRef) {
  try {
    return execFileSync("git", ["-C", repoRoot, "merge-base", baseRef, "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function listChanged(repoRoot, { staged, baseSpec }) {
  // base-ref mode: classify the committed PR diff. On CI, the checked-out PR is already
  // at HEAD, so staged/working modes would be empty.
  if (baseSpec) return gitNames(repoRoot, ["diff", `${baseSpec}...HEAD`, "--name-only"]);
  // staged mode: `diff --cached` already lists newly-staged (added) files.
  if (staged) return gitNames(repoRoot, ["diff", "--cached", "--name-only"]);
  // working-tree mode: `git diff HEAD` lists tracked modifications but NEVER untracked files.
  // A brand-new file is exactly the MINOR/DOCTRINE case the ceiling most wants to see, so union
  // the tracked-vs-HEAD diff with the untracked working files (--others, honoring .gitignore via
  // --exclude-standard) - matching floor-check.js's listChanged.
  const tracked = gitNames(repoRoot, ["diff", "HEAD", "--name-only"]);
  const untracked = gitNames(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])];
}

/**
 * IMPURE. Gather the per-file changeset (path + prior + proposed content) for the ceiling.
 * Default proposed source = the staged index (pre-commit semantics); {staged:false} reads the
 * working tree; {base:"origin/main"} reads the committed PR diff from merge-base...HEAD.
 * Returns the { changes:[...] } shape runCeiling consumes. Un-DR'd edges are NOT derived here
 * (that needs a DR-contract source not yet built - see graph.js's forward note); a caller can
 * attach changeSet.unDrEdges separately.
 *
 * @param {string} [repoRoot=process.cwd()]
 * @param {{staged?:boolean, base?:string}} [opts]
 * @returns {{changes:Array<{path:string, oldContent:string, newContent:string, status:string}>, unDrEdges:Array}}
 */
export function gatherCeilingChangeSet(repoRoot = process.cwd(), opts = {}) {
  const staged = opts.staged !== false;
  const baseRef = opts.base ? String(opts.base) : null;
  const baseSpec = baseRef ? mergeBase(repoRoot, baseRef) : null;
  if (baseRef && !baseSpec) {
    return { changes: [], unDrEdges: [] };
  }

  const priorOf = (file) => gitShow(repoRoot, `${baseSpec ? baseSpec : "HEAD"}:${file}`);
  const proposedOf = (file) =>
    baseSpec ? gitShow(repoRoot, `HEAD:${file}`) : staged ? gitShow(repoRoot, `:${file}`) : readWorkingTree(repoRoot, file);

  const changed = listChanged(repoRoot, { staged, baseSpec });
  const changes = changed.map((file) => {
    const prior = priorOf(file);
    const proposed = proposedOf(file);
    return {
      path: file,
      oldContent: prior ?? "",
      newContent: proposed ?? "",
      status: prior === null ? "added" : proposed === null ? "deleted" : "modified",
    };
  });

  return { changes, unDrEdges: [] };
}

export default { runCeiling, gatherCeilingChangeSet };
