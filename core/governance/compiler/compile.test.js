// illuci/core/governance/compiler/compile.test.js
//
// Verifies the governance-compiler: the pure predicate evaluator, the trigger x severity
// lowering, the promise-gap classification, and - the real teeth - that an EMITTED enforcer
// actually blocks (the secret-value scan) and that the GZDS_OVERRIDE hatch converts a block
// into an audited pass. Run: node --test compile.test.js (after a compile has emitted compiled/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePredicate } from "./runtime/predicate.js";
import { mapObligation } from "./ir/obligation-mapper.js";
import { analyze } from "./ir/promise-gap.js";

test("predicate evaluator: comparison, logical, real secret scan", () => {
  assert.equal(evaluatePredicate("a == b", { a: 1, b: 1 }).ok, true);
  assert.equal(evaluatePredicate("a == b", { a: 1, b: 2 }).ok, false);
  assert.equal(evaluatePredicate("x IS KNOWN", { x: "v" }).ok, true);
  assert.equal(evaluatePredicate("x IS KNOWN", {}).ok, false);
  assert.equal(evaluatePredicate("worktree_path IS KNOWN AND worktree_path == intended", { worktree_path: "w", intended: "w" }).ok, true);
  assert.equal(evaluatePredicate("p IMPLIES q", { p: true, q: false }).ok, false);
  assert.equal(evaluatePredicate("p IMPLIES q", { p: false }).ok, true);
  assert.equal(evaluatePredicate("count(roots) == 1", { roots: ["a"] }).ok, true);
  assert.equal(evaluatePredicate("count(roots) == 1", { roots: ["a", "b"] }).ok, false);
  // the real secret-value scan
  assert.equal(evaluatePredicate("NOT matches_secret_pattern(written_content)", { written_content: "AKIAIOSFODNN7EXAMPLE" }).ok, false);
  assert.equal(evaluatePredicate("NOT matches_secret_pattern(written_content)", { written_content: "the quick brown fox" }).ok, true);
});

test("lowering: trigger x severity -> tier + backend", () => {
  assert.deepEqual(mapObligation({ trigger: "pre-edit", severity: "hard" }), { tier: "hard", backend: "floor_atom" });
  assert.deepEqual(mapObligation({ trigger: "pre-dispatch", severity: "hard" }), { tier: "hard", backend: "dispatch_gate" });
  assert.deepEqual(mapObligation({ trigger: "session-init", severity: "carried" }), { tier: "carried", backend: "carried_preamble" });
  assert.deepEqual(mapObligation({ trigger: "post-task", severity: "soft" }), { tier: "soft", backend: "soft_verify" });
  assert.equal(mapObligation({ trigger: "post-task", severity: "hard" }).downgraded, true);
  assert.equal(mapObligation({ severity: "human" }).human, true);
});

test("promise-gap: undeclared standard is a failing Class-A gap", () => {
  const lowered = [{ id: "std-1.x", source_key: "std-1", tier: "hard", backend: "floor_atom" }];
  const prose = [
    { key: "std-1", label: "Standard 1", declared: true },
    { key: "std-2", label: "Standard 2", declared: false },
  ];
  const r = analyze(lowered, prose);
  assert.equal(r.failing, true);
  assert.equal(r.gaps.filter((g) => g.class === "no_declaration").length, 1);
});

test("emitted enforcer bites: secret-scan blocks, override is an audited pass", async () => {
  const mod = await import("../compiled/floor/art-IX.secret-isolation.no-secret-in-content.js");
  assert.equal(mod.check({ written_content: "token AKIAIOSFODNN7EXAMPLE here" }).ok, false, "a real key must block");
  assert.equal(mod.check({ written_content: "ordinary prose" }).ok, true, "clean content must pass");

  const repoRoot = mkdtempSync(join(tmpdir(), "illuci-override-audit-"));
  try {
    process.env.GZDS_OVERRIDE = "audited emergency reason";
    const ov = mod.check({ written_content: "token AKIAIOSFODNN7EXAMPLE here", repoRoot });
    assert.equal(ov.ok, true, "a substantive override converts the block to a pass");
    assert.equal(ov.overridden, true, "and marks it overridden for the audit trail");
    assert.equal(existsSync(join(repoRoot, "core", "governance", "compiler", "audit", "overrides.jsonl")), true);
    assert.equal(existsSync(join(repoRoot, "illuci", "core", "governance", "compiler", "audit", "overrides.jsonl")), false);
  } finally {
    delete process.env.GZDS_OVERRIDE;
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
test("emitted enforcer bites: branch gate blocks a diverged branch", async () => {
  const mod = await import("../compiled/floor/std-12.repo-authority.branch-verify.js");
  assert.equal(mod.check({ active_branch: "main", dispatched_branch: "main" }).ok, true);
  assert.equal(mod.check({ active_branch: "rogue", dispatched_branch: "main" }).ok, false);
});
