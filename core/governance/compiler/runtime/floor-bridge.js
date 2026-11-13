// illuci/core/governance/compiler/runtime/floor-bridge.js
//
// The commit-time activation: gather the facts the floor can see (the staged content) and run
// the APPLICABLE compiled hard enforcers over them. "Applicable" = the context supplies every
// fact the enforcer's predicate references; an enforcer whose facts were not gathered stays
// inert. So at floor time only the obligations whose facts exist at commit (the secret-value
// scan) fire - the dispatch-scoped ones (repo-authority, scope) never block a commit, because
// their facts (dispatched_branch, scope_record) are not part of a commit context.
//
// SCAN_SKIP: the secret scan must not flag its own machinery - test fixtures legitimately
// contain example keys, helpers.js defines the patterns, and compiled/ carries obligation text.
// Those paths are excluded from the gathered content so the floor never false-positives on them.

import { execFileSync } from "node:child_process";
import { loadCompiled } from "./load-compiled.js";
import { extractFacts } from "./predicate.js";

const SCAN_SKIP = [
  /\.test\.(js|mjs|cjs)$/,                          // test fixtures carry example secrets by design
  /governance\/compiler\/runtime\/helpers\.js$/,   // the secret-pattern definitions themselves
  /governance\/compiled\//,                        // generated enforcers (obligation text, not secrets)
];

function gitDiff(repoRoot, opts) {
  try {
    if (opts.base) {
      const mb = execFileSync("git", ["-C", repoRoot, "merge-base", opts.base, "HEAD"], { encoding: "utf8" }).trim();
      if (!mb) return "";
      return execFileSync("git", ["-C", repoRoot, "diff", `${mb}...HEAD`], { encoding: "utf8" });
    }
    if (opts.staged === false) return execFileSync("git", ["-C", repoRoot, "diff", "HEAD"], { encoding: "utf8" });
    return execFileSync("git", ["-C", repoRoot, "diff", "--cached"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** Gather the commit-time facts: the added content the change introduces, minus allowlisted paths. */
export function gatherFloorFacts(repoRoot, opts = {}) {
  const diff = gitDiff(repoRoot, opts);
  const sections = diff.split(/^diff --git /m).slice(1);
  let added = "";
  for (const sec of sections) {
    const m = sec.match(/^a\/(\S+) b\//);
    const file = m ? m[1] : "";
    if (file && SCAN_SKIP.some((re) => re.test(file))) continue;
    added += "\n" + sec
      .split(/\r?\n/)
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
  }
  return { written_content: added, staged_diff: added };
}

/** An enforcer is applicable iff the context supplies every fact its predicate references. */
export function applicable(enforcer, ctx) {
  return extractFacts(enforcer.PREDICATE || "").every((f) => f in ctx);
}

/**
 * Run the applicable compiled hard enforcers (floor + gate) over the gathered commit facts.
 * @param {string} repoRoot
 * @param {{staged?:boolean, base?:string, facts?:object}} [opts]  opts.facts overrides the gather (tests)
 * @returns {Promise<{blocking:Array<{atom,file,reason}>}>}
 */
export async function runCompiledFloor(repoRoot, opts = {}) {
  const ctx = { ...(opts.facts || gatherFloorFacts(repoRoot, opts)), repoRoot };
  const { floor, gate } = await loadCompiled();
  const blocking = [];
  for (const m of [...floor, ...gate]) {
    if (typeof m.check !== "function" || !applicable(m, ctx)) continue;
    const v = m.check(ctx);
    if (!v.ok) blocking.push({ atom: "compiled:" + m.OBLIGATION_ID, file: "STAGED", reason: v.reason });
  }
  return { blocking };
}

export default { gatherFloorFacts, applicable, runCompiledFloor };
