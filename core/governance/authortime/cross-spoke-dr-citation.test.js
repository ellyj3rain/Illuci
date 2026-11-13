// node:test - the cross-spoke-dr-citation floor atom (the atomized hub-and-spoke import gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCrossSpokeImports, DEFAULT_SPOKES } from "./cross-spoke-dr-citation.js";

test("a hub (no-spoke) file is exempt", () => {
  const r = checkCrossSpokeImports("CORE.md", "import x from 'illuci/core/a.js'\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-spoke-source");
});

test("a non-source file inside a spoke is exempt", () => {
  const r = checkCrossSpokeImports("illuci/README.md", "import x from '../../claude/a.js'\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-spoke-source");
});

test("a same-spoke relative import passes (no cross-spoke edge)", () => {
  const r = checkCrossSpokeImports("illuci/core/governance/a.js", "import { b } from './b.js'\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("a same-spoke deeper relative import passes", () => {
  const r = checkCrossSpokeImports("illuci/core/governance/a.js", "import { b } from '../assess.js'\n");
  assert.equal(r.ok, true);
});

test("BLOCKS an uncited cross-spoke relative import (illuci -> claude)", () => {
  const r = checkCrossSpokeImports(
    "illuci/core/governance/a.js",
    "import { thing } from '../../../claude/system/a.js'\n",
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "cross-spoke-uncited");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].from, "illuci");
  assert.equal(r.violations[0].to, "claude");
  assert.equal(r.violations[0].line, 1);
});

test("allows a cross-spoke import cited on the SAME line", () => {
  const r = checkCrossSpokeImports(
    "claude/system/a.js",
    "import { id } from '../../illuci/core/agents/identity.js' // DR-099: explicit contract\n",
  );
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("allows a cross-spoke import cited on the PRECEDING line", () => {
  const r = checkCrossSpokeImports(
    "claude/system/a.js",
    "// DR-099: claude/system consumes illuci/core agents library\nimport { id } from '../../illuci/core/agents/identity.js'\n",
  );
  assert.equal(r.ok, true);
});

test("BLOCKS an uncited cross-spoke @/ alias import", () => {
  const r = checkCrossSpokeImports("claude/system/a.ts", "import { x } from '@/illuci/core/a'\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "cross-spoke-uncited");
  assert.equal(r.violations[0].to, "illuci");
  assert.equal(r.violations[0].importPath, "@/illuci/core/a");
});

test("allows a cited cross-spoke @/ alias import", () => {
  const r = checkCrossSpokeImports(
    "claude/system/a.ts",
    "// DR-099: contract\nimport { x } from '@/illuci/core/a'\n",
  );
  assert.equal(r.ok, true);
});

test("collects MULTIPLE uncited cross-spoke edges", () => {
  const src =
    "import { a } from '../../../claude/system/a.js'\n" +
    "import { b } from '@/primitives/p'\n" +
    "import { local } from './local.js'\n";
  const r = checkCrossSpokeImports("illuci/core/x.js", src);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
  assert.deepEqual(r.violations.map((v) => v.to).sort(), ["claude", "primitives"]);
});

test("the reason names the from -> to edge and the line", () => {
  const r = checkCrossSpokeImports("illuci/core/x.js", "import { a } from '@/claude/system/a'\n");
  assert.match(r.reason, /\[illuci -> claude\]/);
  assert.match(r.reason, /line 1/);
});

test("a same-spoke @/ alias import passes", () => {
  const r = checkCrossSpokeImports("illuci/core/x.js", "import { a } from '@/illuci/core/y'\n");
  assert.equal(r.ok, true);
});

test("longest-prefix classification is honored via opts.spokeOf override", () => {
  // A custom topology where a nested prefix wins over a broader one.
  const spokeOf = { outer: ["a"], inner: ["a/inner"] };
  // file under a/inner -> spoke 'inner'; import resolves up into a/ -> spoke 'outer' -> cross.
  const r = checkCrossSpokeImports("a/inner/x.js", "import { z } from '../z.js'\n", { spokeOf });
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].from, "inner");
  assert.equal(r.violations[0].to, "outer");
});

test("CRLF newlines are handled (line split is \\r?\\n)", () => {
  const r = checkCrossSpokeImports("illuci/core/x.js", "import { a } from '@/claude/a'\r\n");
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].line, 1);
});

test("a non-import line mentioning a path is ignored", () => {
  const r = checkCrossSpokeImports("illuci/core/x.js", "const note = 'see ../../claude/a.js'\n");
  assert.equal(r.ok, true);
});

test("DEFAULT_SPOKES exposes the four GZDS spokes", () => {
  assert.deepEqual(Object.keys(DEFAULT_SPOKES).sort(), [
    "claude",
    "constitutional",
    "illuci",
    "primitives",
  ]);
});
