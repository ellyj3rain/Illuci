#!/usr/bin/env node
// ADR-01 confound-guard lint (DR-161).
//
// The persona kernel is domain-agnostic: axes are basis vectors and the DOMAIN
// owns every name and template. This lint fails if a facet code, a psychometric
// framework name, or a 1920s-domain term leaks into any `kernel/<crate>/src/**.rs`.
// It scans ONLY crate src trees (not this file, not tests fixtures elsewhere).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // kernel/

// Distinctive leak vectors only (no ultra-common words like "order"/"trust").
const PATTERNS = [
  { re: /\b[OCEAN][1-6]-[A-Za-z]/, what: "facet code (e.g. C6-Deliberation)" },
  { re: /\bNEO-PI\b/i, what: "NEO-PI framework name" },
  { re: /\bPID-5\b/i, what: "PID-5 framework name" },
  { re: /\bSD3\b/, what: "SD3 framework name" },
  { re: /\bSchwartz\b/i, what: "Schwartz values name" },
  { re: /\bEnneagram\b/i, what: "Enneagram name" },
  { re: /\bmachiavellian/i, what: "dark-triad name" },
  { re: /\bnarcissism\b/i, what: "dark-triad name" },
  { re: /\bpsychopathy\b/i, what: "dark-triad name" },
  { re: /\b19[0-2]\d\b/, what: "1920s-era literal" },
  { re: /\b(speakeasy|prohibition|saloon|tenement|Godot)\b/i, what: "1920s-domain term" },
];

function rustFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...rustFiles(p));
    else if (e.endsWith(".rs")) out.push(p);
  }
  return out;
}

function crateSrcDirs() {
  return readdirSync(ROOT)
    .map((d) => join(ROOT, d, "src"))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

let violations = 0;
for (const srcDir of crateSrcDirs()) {
  for (const f of rustFiles(srcDir)) {
    const text = readFileSync(f, "utf8");
    for (const { re, what } of PATTERNS) {
      const m = text.match(re);
      if (m) {
        console.error(`[confound-guard] ${relative(ROOT, f)}: forbidden ${what} — matched "${m[0]}"`);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n[confound-guard] FAIL — ${violations} violation(s). The kernel must stay domain-agnostic (ADR-01).`);
  process.exit(1);
}
console.log("[confound-guard] OK — no facet/framework/1920s literal in kernel/*/src (ADR-01).");
