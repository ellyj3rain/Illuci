/**
 * illuci — [A24.2] PR-shape v1 role-aware tier classifier (node:test, hermetic)
 *
 * Unit surface for roleForFile + classifyPrShapeTiers: role precedence,
 * structural exemption + orphan reversion, the role-aware staged budget, the
 * tier triggers, and the never-read declared-exemption rule. The GOLDEN CORPUS
 * (tests/governance/golden_corpus/) is exercised by pr-shape-tiers.corpus.test.js
 * — 100% precision there is the slice's ratified verification bar.
 *
 * Run: node --test core/governance/gitops/pr-shape-tiers.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_ROLE_TAGS, roleForFile, classifyPrShapeTiers } from "./pr-shape-tiers.js";

// ─── Role tagging: precedence is load-bearing ───────────────────────────────────

test("A24.2: role precedence — version companions beat the generic test read", () => {
  assert.equal(roleForFile("core/governance/version-replay.test.js"), "version-companion");
  assert.equal(roleForFile("core/governance/version-replay.js"), "version-companion");
  assert.equal(roleForFile("VERSION"), "version-companion");
  assert.equal(roleForFile("package.json"), "version-companion");
});

test("A24.2: role tagging across the vocabulary", () => {
  assert.equal(roleForFile("BATCH_LOG.md"), "ledger-companion");
  assert.equal(roleForFile("FINDINGS.md"), "ledger-companion");
  assert.equal(roleForFile("core/dispatch/dispatch.test.js"), "test");
  assert.equal(roleForFile(".gitlab-ci.yml"), "infra");
  assert.equal(roleForFile(".github/workflows/ci.yml"), "infra");
  assert.equal(roleForFile("scripts/run-test-lane.mjs"), "infra");
  assert.equal(roleForFile("deploy/illuci-runtime.service"), "infra");
  assert.equal(roleForFile("design/plan.md"), "docs");
  assert.equal(roleForFile("GOVERNANCE.md"), "docs");
  assert.equal(roleForFile(".env"), "generated");
  assert.equal(roleForFile("artifacts/report.docx"), "generated");
  assert.equal(roleForFile("core/governance/gitops/corpus/pr-outcomes/pr-00118.json"), "generated");
  assert.equal(roleForFile("core/dispatch/dispatch.js"), "intent-surface");
  assert.equal(roleForFile("cli/illuci.mjs"), "intent-surface");
});

test("A24.2: first-consumer is caller-DECLARED via the closure, never inferred", () => {
  assert.equal(roleForFile("core/mcp/server.js"), "intent-surface");
  assert.equal(roleForFile("core/mcp/server.js", { firstConsumers: new Set(["core/mcp/server.js"]) }), "first-consumer");
  assert.ok(PR_ROLE_TAGS.includes("first-consumer"));
});

// ─── Structural exemption + the role-aware budget ───────────────────────────────

test("A24.2: companions are exempt from the counted budget while a closure exists", () => {
  const verdict = classifyPrShapeTiers({
    changedFiles: [
      { path: "core/bridges/x.js", additions: 100 },
      { path: "core/bridges/x.test.js", additions: 300 },
      { path: "BATCH_LOG.md", additions: 20 },
      { path: "VERSION", additions: 1, deletions: 1 },
    ],
  });
  assert.equal(verdict.dimensions.counted.files, 1);
  assert.equal(verdict.dimensions.counted.lines, 100);
  assert.equal(verdict.dimensions.exempt.files, 3);
  assert.equal(verdict.dimensions.tier, 2);
});

test("A24.2: content orphans revert to intent-surface when no closure exists (tests-only diff counts)", () => {
  const verdict = classifyPrShapeTiers({
    changedFiles: [
      { path: "core/a.test.js", additions: 50 },
      { path: "BATCH_LOG.md", additions: 5 },
    ],
  });
  assert.equal(verdict.dimensions.counted.files, 1, "the test file is the diff's real subject");
  assert.deepEqual(verdict.dimensions.orphansReverted, [{ path: "core/a.test.js", from: "test" }]);
  assert.equal(verdict.dimensions.tier, 2);
});

test("A24.2: a ledger-only diff is its own intent (reverts and counts)", () => {
  const verdict = classifyPrShapeTiers({ changedFiles: [{ path: "BATCH_LOG.md", additions: 12 }] });
  assert.equal(verdict.dimensions.counted.files, 1);
  assert.equal(verdict.dimensions.tier, 3, "a counted closure with no REMAINING ledger companion is missing-companions");
});

test("A24.2: the role-aware budget ignores exempt lines (the role-blind mislabel is closed)", () => {
  // 2 intent files / 120 counted lines; 1500 companion lines would have tripped
  // the raw 700-line caution — role-aware counting stays within.
  const verdict = classifyPrShapeTiers({
    changedFiles: [
      { path: "core/x.js", additions: 60 },
      { path: "core/y.js", additions: 60 },
      { path: "core/x.test.js", additions: 1500 },
      { path: "BATCH_LOG.md", additions: 10 },
    ],
  });
  assert.equal(verdict.dimensions.budget.verdict, "within");
  assert.equal(verdict.dimensions.tier, 2);
});

// ─── Tier triggers ──────────────────────────────────────────────────────────────

test("A24.2: production target and unauthorized provenance are Tier-3 triggers", () => {
  const base = { changedFiles: [{ path: "core/x.js", additions: 5 }, { path: "BATCH_LOG.md", additions: 3 }] };
  assert.equal(classifyPrShapeTiers({ ...base, productionTarget: true }).dimensions.tier, 3);
  assert.equal(classifyPrShapeTiers({ ...base, unauthorizedProvenance: true }).dimensions.tier, 3);
  assert.equal(classifyPrShapeTiers(base).dimensions.tier, 2, "the same closure without triggers is watch");
});

test("A24.2: Tier-3 requires the operator; Tier-2 is watch; Tier-1 is ungated", () => {
  const t3 = classifyPrShapeTiers({ changedFiles: [{ path: "core/x.js" }] });
  assert.equal(t3.requiresOperator, true);
  assert.equal(t3.allowed, false);
  const t2 = classifyPrShapeTiers({ changedFiles: [{ path: "core/x.js" }, { path: "BATCH_LOG.md" }] });
  assert.equal(t2.dimensions.watch, true);
  assert.equal(t2.allowed, true);
  const t1 = classifyPrShapeTiers({ changedFiles: [] });
  assert.equal(t1.dimensions.tier, 1);
  assert.equal(t1.code, "no-intent-bearing-surface");
});

test("A24.2: declared exemptions are NEVER read (structural deduction only)", () => {
  const files = [{ path: "core/x.js", additions: 30 }];
  const honest = classifyPrShapeTiers({ changedFiles: files });
  const bypass = classifyPrShapeTiers({ changedFiles: files, isExempt: true, exempt: true, roles: { "core/x.js": "docs" } });
  assert.equal(bypass.dimensions.tier, honest.dimensions.tier);
  assert.equal(bypass.code, honest.code);
});
