/**
 * illuci — Hard-invariant deterministic rule tests (Phase 6, node:test, no judge)
 *
 * The 2 hard invariants (append-only-history, cross-spoke-contract) now carry
 * deterministic .rule fns. verify.js already routes tier==="hard" && rule to the
 * rule (no judge); these prove the rules + that routing.
 *
 * Run: node --test illuci/core/invariants/rules.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { INVARIANTS, byId, hard, soft, appendOnlyHistoryViolation, crossSpokeContractViolation } from "./registry.js";
import { verify, verifyAll } from "./verify.js";

const aSoft = soft()[0]; // any soft (judge-routed) invariant — the parse path under test

// ─── append-only-history ───────────────────────────────────────────────────────

test("append-only-history: editing a ledger is a VIOLATION", () => {
  assert.equal(appendOnlyHistoryViolation("Let me edit BATCH_LOG.md to fix the typo in entry A4."), true);
  assert.equal(appendOnlyHistoryViolation("I will replace the line in DECISION_REGISTRY.md."), true);
  assert.equal(appendOnlyHistoryViolation("deleted the old FINDINGS.md row."), true);
});

test("append-only-history: appending / superseding is CLEAN", () => {
  assert.equal(appendOnlyHistoryViolation("Append a new entry to BATCH_LOG.md that supersedes A4."), false);
  assert.equal(appendOnlyHistoryViolation("new entry in DECISION_REGISTRY.md (supersedes DR-012)."), false);
  // editing a NON-ledger file is not this invariant's concern
  assert.equal(appendOnlyHistoryViolation("edit the README.md to fix a typo."), false);
  // mentioning a ledger without an edit verb is clean
  assert.equal(appendOnlyHistoryViolation("BATCH_LOG.md records every shipment."), false);
});

// ─── cross-spoke-contract ──────────────────────────────────────────────────────

test("cross-spoke-contract: a cross-spoke import with NO DR citation is a VIOLATION", () => {
  assert.equal(crossSpokeContractViolation(`import { x } from "../illuci/core/thing.js";`), true);
  assert.equal(crossSpokeContractViolation(`import foo from "claude/system/skills/bar.js";`), true);
});

test("cross-spoke-contract: a DR citation on or above the import line is CLEAN", () => {
  assert.equal(crossSpokeContractViolation(`import { x } from "../illuci/core/thing.js"; // DR-045`), false);
  assert.equal(
    crossSpokeContractViolation(`// crosses to illuci per DR-112\nimport { x } from "../illuci/core/thing.js";`),
    false,
  );
});

test("cross-spoke-contract: a same-spoke / relative import is CLEAN (no crossing)", () => {
  assert.equal(crossSpokeContractViolation(`import { y } from "./sibling.js";`), false);
  assert.equal(crossSpokeContractViolation(`import { z } from "../throttle/throttle.js";`), false);
  assert.equal(crossSpokeContractViolation(`const a = 1; // no imports at all`), false);
});

// ─── verify.js routing: hard rules run WITHOUT a judge ─────────────────────────

test("verify routes hard invariants to the deterministic rule (judge is never called)", async () => {
  let judgeCalled = false;
  const judge = async () => { judgeCalled = true; return "{}"; };

  const dirty = await verify("edit DECISION_REGISTRY.md and replace entry A4", byId("append-only-history"), judge);
  assert.equal(dirty.violates, true);
  assert.equal(dirty.reason, "rule matched");
  assert.equal(judgeCalled, false, "a hard invariant must not consult the judge");

  const clean = await verify("append a new entry to BATCH_LOG.md", byId("append-only-history"), judge);
  assert.equal(clean.violates, false);
  assert.equal(judgeCalled, false);
});

test("both hard invariants now own a .rule (the previously-missing fns exist)", () => {
  for (const inv of hard()) {
    assert.equal(typeof inv.rule, "function", `hard invariant "${inv.id}" must own a deterministic rule`);
  }
});

test("verifyAll: 6 invariants, 2 hard deterministic + 4 soft judged", async () => {
  let judgeCalls = 0;
  const judge = async () => { judgeCalls += 1; return '{"violates": false, "reason": "clean"}'; };
  const results = await verifyAll("a clean output", judge);
  assert.equal(results.length, 6, "all six invariants are checked");
  assert.equal(judgeCalls, 4, "only the 4 soft invariants invoke the judge");
  assert.equal(INVARIANTS.filter((i) => i.tier === "hard").length, 2);
});

// ─── append-only-history: the broadened verb set (MEDIUM-1) ────────────────────

test("append-only-history: the broadened mutation verbs (change/modify/update/amend/correct/remove) bite", () => {
  for (const verb of ["change", "modify", "update", "amend", "correct", "remove"]) {
    assert.equal(
      appendOnlyHistoryViolation(`Please ${verb} the entry in BATCH_LOG.md.`),
      true,
      `"${verb}" on a ledger without an append marker must be a violation`,
    );
  }
  // the original verbs still bite (no regression)
  assert.equal(appendOnlyHistoryViolation("replace the line in FINDINGS.md"), true);
  // an append/supersede marker still clears any verb
  assert.equal(appendOnlyHistoryViolation("update via a new entry in DECISION_REGISTRY.md"), false);
});

// ─── cross-spoke-contract: dynamic import + backward DR window (MEDIUM-2) ───────

test("cross-spoke-contract: a DYNAMIC import() crossing a spoke with NO DR citation is a VIOLATION", () => {
  assert.equal(crossSpokeContractViolation(`const m = await import("../illuci/core/thing.js");`), true);
  assert.equal(crossSpokeContractViolation(`import( "claude/system/skills/bar.js" )`), true);
});

test("cross-spoke-contract: a dynamic import() WITH a DR citation (same line or window above) is CLEAN", () => {
  assert.equal(crossSpokeContractViolation(`const m = await import("../illuci/core/thing.js"); // DR-045`), false);
  // citation two lines above (a multiline import / comment placement) still satisfies the rule
  assert.equal(
    crossSpokeContractViolation(`// crosses to illuci per DR-112\n// (see the contract)\nconst m = await import("../illuci/core/thing.js");`),
    false,
  );
});

test("cross-spoke-contract: a DR citation OUTSIDE the backward window does NOT clear the violation", () => {
  // DR is 4 lines above the import — beyond DR_WINDOW (3) — so the import is uncited.
  const out = `// DR-200\n\n\n\nimport { x } from "../illuci/core/thing.js";`;
  assert.equal(crossSpokeContractViolation(out), true);
});

// ─── verify.js judge-parse resilience (HIGH-4) ─────────────────────────────────

test("verify: a prose-wrapped / markdown-fenced judge reply is parsed, not thrown", async () => {
  const fenced = async () => 'Sure!\n```json\n{"violates": true, "reason": "leaked a name"}\n```\nHope that helps.';
  const r = await verify("some output", aSoft, fenced);
  assert.equal(r.violates, true);
  assert.match(r.reason, /leaked a name/);
});

test("verify: a NON-STRING judge reply is coerced, never throws (no .indexOf on a non-string)", async () => {
  for (const bad of [null, undefined, 42, { violates: true }]) {
    const judge = async () => bad;
    let r;
    await assert.doesNotReject(async () => { r = await verify("x", aSoft, judge); });
    assert.equal(r.id, aSoft.id);
    assert.equal(r.violates, null, "an unparseable reply degrades to violates:null, not a throw");
  }
});

test("verify: malformed brace-slice JSON degrades to { violates:null }, does not throw", async () => {
  const judge = async () => "{ this is : not, valid json } trailing";
  const r = await verify("x", aSoft, judge);
  assert.equal(r.violates, null);
});

test("verifyAll: one malformed (or throwing) judge reply cannot abort the rest of the pass", async () => {
  let calls = 0;
  // first soft invariant's judge call throws; later ones must still run + return.
  const judge = async () => { calls += 1; if (calls === 1) throw new Error("judge exploded"); return '{"violates": false}'; };
  const results = await verifyAll("a clean output", judge);
  assert.equal(results.length, 6, "all six invariants still produce a result despite one judge throw");
  const errored = results.find((r) => /verify error/.test(r.reason || ""));
  assert.ok(errored, "the throwing invariant degrades to a verify-error result, not an aborted pass");
});
