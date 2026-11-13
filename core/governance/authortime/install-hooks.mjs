#!/usr/bin/env node
// illuci/core/governance/authortime/install-hooks.mjs
//
// SAFE installer for the GZDS author-time FLOOR git hook. It points git's core.hooksPath
// at this directory's `hooks/` dir so the pre-commit hook fires on every commit.
//
// TIER SCOPE — what this arms is the FLOOR, and the floor only.
//   The author-time governance has two tiers with opposite safety profiles:
//     - FLOOR: the deterministic atoms (version-gate, append-only, header, source hygiene).
//       Each is a pure pass/fail with no human in the loop, so it is SAFE TO RUN
//       UNATTENDED on every commit. The pre-commit hook this installer arms invokes the
//       floor CLI, which is floor-only by construction.
//     - CEILING / operator-gate / halt tier: the relational, consumption-graph-aware
//       governance. That tier is ATTENDED-ONLY — it surfaces a deliberation to the
//       operator — and is deliberately NOT wired into any git hook.
//
// SAFETY CONTRACT — DRY RUN IS THE DEFAULT.
//   Without an explicit `--arm` flag this script touches NOTHING: it prints exactly the
//   `git config` it WOULD run and exits 0. git config is changed ONLY when `--arm` is
//   passed. This makes accidental arming impossible — arming is an explicit, deliberate
//   operator act, never a side effect of running the script to inspect it.
//
// USAGE
//   node install-hooks.mjs                  # dry run (default): print plan, change nothing
//   node install-hooks.mjs --arm            # arm: set core.hooksPath to this hooks/ dir
//   node install-hooks.mjs --repo <path>    # target a specific repo root (default: cwd)
//
// No Date.now()/Math.random(): the planned command is a pure function of its inputs.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * PURE. Build the install plan from the parsed argv + the hooks directory. The plan is a
 * deterministic description of the single `git config` mutation arming would perform;
 * nothing here touches git or the filesystem.
 * @param {string[]} argv  process.argv.slice(2)
 * @param {string} hooksDir  absolute path to the hooks/ directory to be installed
 * @returns {{arm:boolean, repo:string, hooksDir:string, configArgs:string[], wouldRun:string}}
 */
export function buildPlan(argv, hooksDir) {
  const arm = argv.includes("--arm");
  const repoIdx = argv.indexOf("--repo");
  const repo = repoIdx !== -1 && argv[repoIdx + 1] ? argv[repoIdx + 1] : process.cwd();
  const configArgs = ["-C", repo, "config", "core.hooksPath", hooksDir];
  return {
    arm,
    repo,
    hooksDir,
    configArgs,
    wouldRun: `git ${configArgs.join(" ")}`,
  };
}

/**
 * Run the installer. DRY RUN unless plan.arm is true. The only mutating path is the
 * `git config` call guarded behind plan.arm; every other path is read-only / print-only.
 * @param {{arm:boolean, repo:string, hooksDir:string, configArgs:string[], wouldRun:string}} plan
 * @param {(s:string)=>void} [log]  output sink (defaults to process.stdout.write)
 * @returns {{ok:boolean, armed:boolean, wouldRun:string}}
 */
export function runInstaller(plan, log = (s) => process.stdout.write(s)) {
  if (!plan.arm) {
    log("GZDS hook installer — DRY RUN (default; nothing changed).\n");
    log(`  Would set the FLOOR pre-commit hook for repo: ${plan.repo}\n`);
    log(`  Would run: ${plan.wouldRun}\n`);
    log("  Re-run with --arm to apply. (Floor is safe unattended; the operator-gate/halt tier is not armed here.)\n");
    return { ok: true, armed: false, wouldRun: plan.wouldRun };
  }
  execFileSync("git", plan.configArgs, { encoding: "utf8" });
  log("GZDS hook installer — ARMED.\n");
  log(`  Set core.hooksPath -> ${plan.hooksDir} (repo: ${plan.repo}).\n`);
  return { ok: true, armed: true, wouldRun: plan.wouldRun };
}

// CLI entry. Only runs when executed directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const hooksDir = join(HERE, "hooks");
  const plan = buildPlan(process.argv.slice(2), hooksDir);
  const r = runInstaller(plan);
  process.exit(r.ok ? 0 : 1);
}

export default { buildPlan, runInstaller };
