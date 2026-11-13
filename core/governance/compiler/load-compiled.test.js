// illuci/core/governance/compiler/load-compiled.test.js
//
// Verifies the runtime bridge: the full compiled corpus loads, the hard pass blocks a bad
// context, and the carried preambles carry real obligation text. Requires a prior compile to
// have emitted compiled/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCompiled, runHard, carriedPreambles, runSoft } from "./runtime/load-compiled.js";

test("loader loads the full compiled corpus", async () => {
  const { floor, gate, carried, soft } = await loadCompiled();
  assert.ok(floor.length + gate.length >= 14, "hard enforcers loaded");
  assert.ok(carried.length >= 15, "carried preambles loaded");
  assert.ok(soft.length >= 12, "soft invariants loaded");
});

test("runHard blocks a secret-bearing, diverged context", async () => {
  const r = await runHard({
    written_content: "token AKIAIOSFODNN7EXAMPLE",
    active_branch: "rogue",
    dispatched_branch: "main",
    canonical_root: "/canonical",
    working_root: "/elsewhere",
  });
  assert.equal(r.ok, false, "a context that violates hard obligations must be blocked");
  assert.ok(r.blocking.length >= 2, "multiple hard enforcers should fire");
});

test("runHard passes a clean, aligned context", async () => {
  const r = await runHard({
    written_content: "ordinary prose with no secrets",
    active_branch: "main",
    dispatched_branch: "main",
    canonical_root: "/canonical",
    working_root: "/canonical",
    worktree_path: "/canonical",
    intended_worktree: "/canonical",
    canonical_roots: ["/canonical"],
    implementer_registered: true,
    version_within_caps: true,
    maturity_suffix_valid: true,
    cast_trailer_present: true,
    scope_record: "task-scope",
  });
  assert.equal(r.ok, true, "a clean aligned context must pass the hard pass");
});

test("carried preambles carry obligation text", async () => {
  const ps = await carriedPreambles();
  assert.ok(ps.length >= 15);
  assert.ok(ps.every((p) => typeof p.preamble === "string" && p.preamble.length > 0));
});
