#!/usr/bin/env node
// illuci/core/governance/compiler/compile-cli.mjs
//
// Run the governance compiler and print the report. Resolves the repo root from this script's
// own location so it works regardless of the caller's cwd. Exit codes: 0 ok, 1 parse error,
// 2 failing promise-gap or GIR validation failure.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { compile } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", ".."); // compiler -> governance -> core -> illuci -> root
const force = process.argv.includes("--force");
const res = compile({ repoRoot, force, batch: process.env.GZDS_CURRENT_BATCH || null });

if (res.phase === "parse") {
  console.error("governance-compile: PARSE FAILED");
  for (const e of res.errors) console.error("  - " + e);
  process.exit(1);
}

const stats = (res.gir && res.gir.stats) || {};
if (res.cached) {
  console.log("governance-compile: cached (source unchanged) - " + (stats.total_obligations || 0) + " obligations");
} else {
  console.log(
    "governance-compile: " + stats.total_obligations + " obligations -> " + stats.emitted + " enforcers " +
    "(hard " + stats.hard + ", carried " + stats.carried + ", soft " + stats.soft + ", human " + stats.human + ")"
  );
}
if (res.gaps && res.gaps.length) {
  console.log("promise-gaps: " + res.gaps.length + " (" + (stats.failing_gaps || 0) + " failing)");
  for (const g of res.gaps) {
    console.log("  [" + g.class + "] " + (g.source_key || "") + " " + (g.obligation || g.label || "") + " - " + g.reason);
  }
}
if (!res.ok) {
  console.error("governance-compile: FAILED (" + (res.failing ? "promise-gap" : "validation") + ")");
  process.exit(2);
}
console.log("governance-compile: OK");
