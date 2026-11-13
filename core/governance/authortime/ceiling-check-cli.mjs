#!/usr/bin/env node
// Advisory CLI for the GZDS author-time CEILING. This is the WARN-TIER judgment layer.
//
//   node ceiling-check-cli.mjs [repoRoot] [--working] [--base <ref>] [--version-scope <json>]
//     repoRoot   defaults to cwd
//     --working  read the working tree instead of the staged index
//     --base     read the committed PR diff from merge-base...HEAD (CI / PR mode)
//     --version-scope  {"kind":"increment"|"completed-feature","evidence":"owning record"}
//
// CRITICAL: the ceiling is ADVISORY. This CLI NEVER exits non-zero and NEVER blocks a commit.
// It prints the proposed change-tier (the batch's effective semantic class + the odometer
// action the author-time gate should expect) and any HALTS that route to the operator (an
// UNRESOLVED class, a missing-evidence change, an un-DR'd cross-spoke edge). The deterministic
// FLOOR (floor-check-cli.mjs) is the pass/fail gate that is safe to run unattended on every
// commit; the ceiling is attended judgment - it is deliberately NOT a git-hook block tier. It
// exists to surface tier decisions to the operator, not to stop them.

import { buildGraph } from "./ceiling/graph.js";
import { loadManifest } from "./manifest.js";
import { gatherCeilingChangeSet, runCeiling } from "./ceiling-check.js";
import { failClosedOnEvidence } from "./ceiling/elevation.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const baseEq = args.find((a) => a.startsWith("--base="));
const base = baseEq
  ? baseEq.slice("--base=".length)
  : baseIdx !== -1 && args[baseIdx + 1] && !args[baseIdx + 1].startsWith("--")
    ? args[baseIdx + 1]
    : null;
const baseValueIdx = baseEq ? -1 : baseIdx !== -1 ? baseIdx + 1 : -1;
const scopeOptions = args.filter((a) => a === "--version-scope" || a.startsWith("--version-scope="));
const scopeIdx = args.indexOf("--version-scope");
const scopeEq = args.find((a) => a.startsWith("--version-scope="));
const scopeValueIdx = scopeEq ? -1 : scopeIdx !== -1 ? scopeIdx + 1 : -1;
const repoRoot = args.find((a, i) => !a.startsWith("--") && i !== baseValueIdx && i !== scopeValueIdx) || process.cwd();
const staged = !args.includes("--working");
let versionScope;
if (scopeOptions.length) {
  try {
    if (scopeOptions.length !== 1) throw new Error("provide one JSON scope argument");
    const raw = scopeEq ? scopeEq.slice("--version-scope=".length) : args[scopeValueIdx];
    if (!raw || raw.startsWith("--")) throw new Error("JSON scope argument is missing");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => key !== "kind" && key !== "evidence") ||
        !["increment", "completed-feature"].includes(value.kind) || failClosedOnEvidence(value).block) {
      throw new Error("expected kind increment/completed-feature and non-empty string/array evidence");
    }
    versionScope = value;
  } catch (error) {
    process.stdout.write(`[warn: version-scope-input] Invalid --version-scope: ${error.message}; scope was not applied.\n`);
  }
}

// Flatten the invariant-implementer manifest into the path list the semantic atom consumes
// (a path in the manifest is a DOCTRINE path). loadManifest returns { invariants: { id: { files } } }.
function manifestPaths(repoRoot) {
  const mani = loadManifest(repoRoot);
  const paths = [];
  for (const entry of Object.values(mani.invariants || {})) {
    for (const f of (entry && entry.files) || []) paths.push(f);
  }
  return paths;
}

function loadRetirements(repoRoot) {
  const file = join(repoRoot, "core", "governance", "authortime", "surface-retirements.json");
  if (!existsSync(file)) return { surfaces: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { surfaces: [] };
  } catch {
    return { surfaces: [] };
  }
}

const graph = buildGraph(repoRoot);
const manifest = manifestPaths(repoRoot);
const retirements = loadRetirements(repoRoot);
const changeSet = gatherCeilingChangeSet(repoRoot, base ? { base } : { staged });
if (versionScope) changeSet.versionScope = versionScope;
const result = runCeiling(changeSet, { graph, manifest, retirements });

process.stdout.write(`GZDS ceiling (advisory): proposed class = ${result.proposedClass}, version action = ${result.versionAction}\n`);

for (const e of result.evidence) {
  if (e.edge) {
    process.stdout.write(`  [edge ${e.edge.from}->${e.edge.to}] ${e.effectiveClass} - ${e.why}\n`);
  } else {
    const reach = e.semanticClass !== e.effectiveClass ? ` (reach: ${e.semanticClass}->${e.effectiveClass} @ ${e.band})` : "";
    process.stdout.write(`  [${e.file}] ${e.effectiveClass}${reach} - ${e.why}\n`);
  }
}

if (result.warnings.length) {
  for (const w of result.warnings) {
    process.stdout.write(`  [warn: ${w.kind}] ${w.reason}\n`);
  }
}

if (result.halts.length) {
  process.stdout.write(`\nHALTS routed to operator (${result.halts.length}) - the ceiling does not decide these:\n`);
  for (const h of result.halts) {
    process.stdout.write(`  [${h.code}] ${h.file || "(batch)"} -> ${h.route} - ${h.reason}\n`);
  }
}

if (result.versionAction === "scope-assessment-required") {
  process.stdout.write(`\nThis batch reaches the GATED LANE (CONTRACT/DOCTRINE): the major/epoch bump is operator-gated (constitutional/02), not self-serve.\n`);
}

// Advisory: never block. Always exit 0.
process.exit(0);
