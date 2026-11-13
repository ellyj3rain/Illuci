/**
 * illuci — [A24.2] The golden corpus gate (node:test, hermetic)
 *
 * The slice's ratified verification bar (DR-115 / the emitted plan): the tier
 * classifier executes against EVERY case in tests/governance/golden_corpus/
 * with 100% precision — every pinned tier, watch posture, expected code, and
 * counted-file count must match exactly. A new corpus case is a new law; a
 * classifier change that flips a pinned verdict must supersede the case file
 * in the same review unit, loudly.
 *
 * Run: node --test core/governance/gitops/pr-shape-tiers.corpus.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyPrShapeTiers } from "./pr-shape-tiers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, "..", "..", "..", "tests", "governance", "golden_corpus");

const cases = readdirSync(CORPUS_DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({ file, ...JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")) }));

test("A24.2: the golden corpus is populated", () => {
  assert.ok(cases.length >= 10, `expected >=10 corpus cases, found ${cases.length}`);
});

for (const c of cases) {
  test(`A24.2 corpus [${c.file}] ${c.name}: tier ${c.expect.tier}`, () => {
    const verdict = classifyPrShapeTiers(c.input);
    assert.equal(verdict.dimensions.tier, c.expect.tier, `${c.name}: tier`);
    assert.equal(verdict.dimensions.watch, c.expect.watch, `${c.name}: watch`);
    if (c.expect.code !== undefined) assert.equal(verdict.code, c.expect.code, `${c.name}: code`);
    if (c.expect.countedFiles !== undefined) {
      assert.equal(verdict.dimensions.counted.files, c.expect.countedFiles, `${c.name}: counted files`);
    }
    // Tier semantics hold corpus-wide: 3 requires the operator, 1/2 proceed.
    assert.equal(verdict.requiresOperator, c.expect.tier === 3, `${c.name}: operator routing`);
    assert.equal(verdict.allowed, c.expect.tier !== 3, `${c.name}: allowed`);
  });
}
