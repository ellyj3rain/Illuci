// illuci/core/governance/compiler/floor-bridge.test.js
//
// Verifies the commit-time activation: fact extraction, the applicability gate, and that a
// staged secret VALUE is blocked while clean content passes - and that the dispatch-scoped
// obligations stay inert at floor time (they would otherwise fail-closed and block every commit).

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "./runtime/predicate.js";
import { applicable, runCompiledFloor } from "./runtime/floor-bridge.js";

test("extractFacts pulls the facts a predicate references", () => {
  assert.deepEqual(extractFacts("NOT matches_secret_pattern(written_content)"), ["written_content"]);
  assert.deepEqual(extractFacts("active_branch == dispatched_branch").sort(), ["active_branch", "dispatched_branch"]);
  assert.deepEqual(extractFacts("count(canonical_roots) == 1"), ["canonical_roots"]);
});

test("applicability gate: secret-scan applies with content, repo-authority does not", () => {
  const secretMod = { PREDICATE: "NOT matches_secret_pattern(written_content)" };
  const branchMod = { PREDICATE: "active_branch == dispatched_branch" };
  const ctx = { written_content: "x", staged_diff: "x" };
  assert.equal(applicable(secretMod, ctx), true, "secret-scan facts are present");
  assert.equal(applicable(branchMod, ctx), false, "branch-gate facts (dispatched_branch) are absent -> inert");
});

test("compiled floor pass blocks a staged secret value", async () => {
  const r = await runCompiledFloor(process.cwd(), {
    facts: { written_content: "const k = AKIAIOSFODNN7EXAMPLE", staged_diff: "const k = AKIAIOSFODNN7EXAMPLE" },
  });
  assert.ok(r.blocking.length >= 1, "a staged secret must be blocked by the compiled floor pass");
});

test("compiled floor pass passes clean staged content (no false block from inert enforcers)", async () => {
  const r = await runCompiledFloor(process.cwd(), {
    facts: { written_content: "const total = a + b", staged_diff: "const total = a + b" },
  });
  assert.equal(r.blocking.length, 0, "clean content must not be blocked; dispatch-scoped obligations stay inert");
});
