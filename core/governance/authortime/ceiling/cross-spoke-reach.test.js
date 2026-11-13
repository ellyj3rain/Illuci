// node:test - the cross-spoke-reach ceiling rule (per-file edge classifier, advisory tier).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCrossSpokeReach } from "./cross-spoke-reach.js";

test("a hub / non-source file yields no edges", () => {
  const r = classifyCrossSpokeReach("CORE.md", "import x from 'illuci/a.js'\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "not-spoke-source");
  assert.equal(r.edges.length, 0);
});

test("a same-spoke-only file has no cross-spoke edges", () => {
  const r = classifyCrossSpokeReach("illuci/core/a.js", "import { b } from './b.js'\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-cross-spoke-edges");
});

test("an UNCITED cross-spoke edge classifies DOCTRINE (not ok)", () => {
  const r = classifyCrossSpokeReach("illuci/core/a.js", "import { x } from '@/claude/system/a'\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "uncited-cross-spoke-edge");
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].class, "DOCTRINE");
  assert.equal(r.edges[0].dr, null);
});

test("a CITED cross-spoke edge classifies CONTRACT (ok, gated lane)", () => {
  const r = classifyCrossSpokeReach(
    "claude/system/a.js",
    "// DR-099: contract\nimport { id } from '../../illuci/core/identity.js'\n",
  );
  assert.equal(r.ok, true);
  assert.equal(r.code, "all-edges-contracted");
  assert.equal(r.edges[0].class, "CONTRACT");
  assert.equal(r.edges[0].dr, "DR-099");
});

test("a same-line citation is captured on the edge", () => {
  const r = classifyCrossSpokeReach(
    "claude/system/a.ts",
    "import { x } from '@/illuci/core/a' // DR-045\n",
  );
  assert.equal(r.ok, true);
  assert.equal(r.edges[0].dr, "DR-045");
});

test("a mix of cited + uncited edges is DOCTRINE (uncited dominates the ok flag)", () => {
  const src =
    "// DR-045: ok\nimport { a } from '@/illuci/a'\n" +
    "import { b } from '@/primitives/p'\n";
  const r = classifyCrossSpokeReach("claude/system/x.js", src);
  assert.equal(r.ok, false);
  assert.equal(r.edges.length, 2);
  const uncited = r.edges.filter((e) => e.class === "DOCTRINE");
  assert.equal(uncited.length, 1);
  assert.equal(uncited[0].to, "primitives");
});

test("the reason cites ARCHITECTURE.md / Amendment 5 for an uncited edge", () => {
  const r = classifyCrossSpokeReach("illuci/core/x.js", "import { a } from '@/claude/a'\n");
  assert.match(r.reason, /Amendment 5/);
  assert.match(r.reason, /DOCTRINE/);
});

test("opts.spokeOf override drives the classification", () => {
  const spokeOf = { left: ["L"], right: ["R"] };
  const r = classifyCrossSpokeReach("L/x.js", "import { z } from '@/R/z'\n", { spokeOf });
  assert.equal(r.ok, false);
  assert.equal(r.edges[0].from, "left");
  assert.equal(r.edges[0].to, "right");
});

test("CRLF newlines are handled", () => {
  const r = classifyCrossSpokeReach("illuci/core/x.js", "import { a } from '@/claude/a'\r\n");
  assert.equal(r.ok, false);
  assert.equal(r.edges[0].line, 1);
});
