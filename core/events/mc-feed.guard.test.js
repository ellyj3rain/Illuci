/**
 * Phase 7 — the NON-DEPENDENCY lint guard.
 *
 * GZDS's wanted MC relationship is a META-DEPENDENCY (a value gradient), never a
 * RUNTIME dependency. The runtime path — dispatch (model invocation), agent (the
 * agentic loop), orchestrate (company/spawn composition) — must run identically
 * whether or not Marshmallow Commons exists. This guard makes that structural:
 *
 *   No source file under dispatch/, agent/, or orchestrate/ may import the MC feed
 *   (events/mc-feed.js) or any module named like an MC integration.
 *
 * The feed is one-way and OPTIONAL: an MC integration point calls attachMcFeed();
 * the runtime path never reaches for it. If this test ever fails, someone wired the
 * runtime to MC and broke the non-dependency invariant — fix the import, not this
 * test.
 *
 * Hermetic: reads source files, no model, no network. node:test (vitest files can't
 * run under `node --test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = join(__dirname, ".."); // illuci/core

// The runtime-path directories that must never depend on MC.
const GUARDED_DIRS = ["dispatch", "agent", "orchestrate"];

// Import specifiers that signal an MC dependency. Matched against the module string
// in `import ... from "<spec>"`, side-effect `import "<spec>"`, dynamic `import("<spec>")`,
// and CommonJS `require("<spec>")`. Kept deliberately broad: the feed lives at
// events/mc-feed.js, but ANY mc-feed / mc-sink / marshmallow integration reach from the
// runtime path is a violation.
//
// The forbidden NAME (mc-feed | mc-sink | mc-client | marshmallow) is caught whether it is:
//   - the file basename, any extension:  ../events/mc-feed.js  /  ./mc-feed.mjs  /  ../mc-feed.cjs
//   - extensionless:                      ../events/mc-feed     /  ../marshmallow
//   - a BARREL directory (index re-export): ../mc-feed/index.js  /  ../marshmallow/index.mjs
//   - carrying a query/hash suffix (bundler evasion): ../events/mc-feed.js?raw  /  ../mc-feed#x
// while NOT tripping on look-alikes where the name is only a path PREFIX that continues
// (../mc-feed-helpers/util.js) or merely contains the letters (emitter.js, model-registry.js).
const FORBIDDEN_NAME = "(?:mc-feed|mc-sink|mc-client|marshmallow)";
const EXT = "(?:\\.[mc]?js)?";              // optional .js / .mjs / .cjs
const SUFFIX = "(?:[?#].*)?";               // optional ?query / #hash (bundler suffix evasion)
const FORBIDDEN_SPEC = new RegExp(
  // either the forbidden name as the final path segment (+ optional ext + optional suffix),
  `(?:^|/)${FORBIDDEN_NAME}${EXT}${SUFFIX}$` +
  // …or a forbidden DIRECTORY whose import resolves to its index barrel.
  `|(?:^|/)${FORBIDDEN_NAME}/index${EXT}${SUFFIX}$`,
  "i",
);

/** Recursively collect .js source files under a dir, skipping test fixtures. */
function collectSources(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir absent — nothing to guard, not a failure
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...collectSources(full));
    } else if (name.endsWith(".js") || name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the module specifiers a file imports, via static `import ... from "x"`,
 * side-effect `import "x"`, dynamic `import("x")`, and CommonJS `require("x")`. Regex-
 * based (the codebase is ESM and consistently quoted); good enough for a dependency
 * guard and dependency-free. require() is included so a runtime-path file cannot evade
 * the guard by reaching for MC through CommonJS interop instead of an ESM import.
 */
function importSpecifiers(src) {
  const specs = [];
  // static + side-effect imports:  import ... from 'x'   /   import 'x'
  const staticRe = /\bimport\b[^'"`]*?from\s*['"`]([^'"`]+)['"`]|\bimport\s*['"`]([^'"`]+)['"`]/g;
  // dynamic imports:  import('x')
  const dynRe = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  // CommonJS:  require('x')  (interop evasion path)
  const reqRe = /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let m;
  while ((m = staticRe.exec(src))) specs.push(m[1] || m[2]);
  while ((m = dynRe.exec(src))) specs.push(m[1]);
  while ((m = reqRe.exec(src))) specs.push(m[1]);
  return specs;
}

test("non-dependency guard: no runtime-path file imports the MC feed", () => {
  const violations = [];
  for (const dirName of GUARDED_DIRS) {
    const dir = join(CORE_DIR, dirName);
    for (const file of collectSources(dir)) {
      const src = readFileSync(file, "utf-8");
      for (const spec of importSpecifiers(src)) {
        if (FORBIDDEN_SPEC.test(spec)) {
          violations.push(`${relative(CORE_DIR, file)} imports "${spec}"`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    "runtime path (dispatch/agent/orchestrate) must not depend on MC:\n  " + violations.join("\n  ")
  );
});

test("guard self-check: the regex catches the real feed specifiers, ignores look-alikes", () => {
  // The actual ways the feed could be imported — all must be caught.
  for (const spec of [
    "../events/mc-feed.js",
    "../events/mc-feed",
    "../../core/events/mc-feed.js",
    "./mc-sink.js",
    "../mc-client",
    "../marshmallow",
    // ── evasion paths the broadened regex must also catch ──
    "../events/mc-feed.mjs",            // .mjs extension
    "../events/mc-feed.cjs",            // .cjs extension
    "../mc-feed/index.js",              // barrel directory (index re-export)
    "../mc-feed/index.mjs",             // barrel directory, .mjs
    "../marshmallow/index.js",          // barrel directory by the marshmallow name
    "../events/mc-feed.js?raw",         // query-suffix (bundler) evasion
    "../events/mc-feed.js#frag",        // hash-suffix evasion
    "../mc-feed?inline",                // extensionless + query
  ]) {
    assert.ok(FORBIDDEN_SPEC.test(spec), `should flag ${spec}`);
  }
  // Innocuous specifiers that merely contain the letters must NOT trip it.
  for (const spec of [
    "../events/emitter.js",
    "../awareness/store.js",
    "node:fs",
    "../bridges/model-registry.js",
    "../mc-feed-helpers/util.js", // not the feed module itself (path continues)
    "../mc-feed-helpers/index.js", // a DIFFERENT dir whose name merely starts with mc-feed
    "./formatter.js",
    "../marshmallow-commons-docs.md", // name continues past the forbidden token
  ]) {
    assert.equal(FORBIDDEN_SPEC.test(spec), false, `should NOT flag ${spec}`);
  }
});

test("guard self-check: importSpecifiers extracts require() / .mjs dynamic-import specifiers (evasion coverage)", () => {
  const src = [
    `import { x } from "../events/emitter.js";`,            // innocuous static
    `const mc = require("../events/mc-feed.js");`,           // CommonJS require evasion
    `await import("../mc-feed/index.mjs");`,                 // dynamic import of a barrel .mjs
    `import "../marshmallow";`,                              // side-effect import
  ].join("\n");
  const specs = importSpecifiers(src);
  assert.ok(specs.includes("../events/mc-feed.js"), "require() specifier extracted");
  assert.ok(specs.includes("../mc-feed/index.mjs"), "dynamic .mjs barrel extracted");
  assert.ok(specs.includes("../marshmallow"), "side-effect import extracted");
  // And all three forbidden ones trip the regex (the innocuous emitter does not).
  const flagged = specs.filter((s) => FORBIDDEN_SPEC.test(s)).sort();
  assert.deepEqual(flagged, ["../events/mc-feed.js", "../marshmallow", "../mc-feed/index.mjs"]);
});

test("guard sanity: it actually scanned runtime-path source (non-empty corpus)", () => {
  let total = 0;
  for (const dirName of GUARDED_DIRS) {
    total += collectSources(join(CORE_DIR, dirName)).length;
  }
  // If this is zero the guard is vacuously green — fail loudly so a moved/renamed
  // runtime dir can't silently disable the non-dependency check.
  assert.ok(total > 0, "expected to scan at least one runtime-path source file");
});
