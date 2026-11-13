// node:test - the operator-mediated-pause adherence atom (constitutional/CONSTITUTION.md).
// Covers the ceiling rule's pure checkOperatorPause and the floor wrapper's assessOperatorPause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOperatorPause } from "./ceiling/operator-pause.js";
import { assessOperatorPause, ATOM, DEFAULT_POLICY } from "./operator-pause.js";

// ---- scope gate -------------------------------------------------------------------------

test("source scope: executable statements and strings are not evaluated as prose", () => {
  const r = checkOperatorPause("illuci/core/foo.js", "", "const reason = 'because the bridge needs it';\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("out of scope: a non-design, non-hub markdown is not evaluated", () => {
  const r = checkOperatorPause("claude/notes/scratch.md", "", "the schema is finalized\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "out-of-scope");
});

test("out of scope: downstream constitutional mirror paths are not evaluated by location", () => {
  const r = checkOperatorPause("constitutional/11-new.md", "", "the naming convention is ratified\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "out-of-scope");
});

test("in scope: a hub doc (ARCHITECTURE.md) is evaluated", () => {
  const r = checkOperatorPause("ARCHITECTURE.md", "", "the architecture is locked\n");
  assert.equal(r.ok, false);
});

test("in scope: a design markdown (matches design/.*\\.md) is evaluated", () => {
  const r = checkOperatorPause("otl/design/continuation-spec.md", "", "the default option is chosen\n");
  assert.equal(r.ok, false);
});

// ---- detection: unratified lock language ------------------------------------------------

test("FLAGS an added line locking a naming decision with no operator marker", () => {
  const r = checkOperatorPause("CORE.md", "# Core\n", "# Core\nThe module naming is ratified as `illuci-skills`.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "unratified-lock-language");
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].line, 2);
  assert.match(r.reason, /unratified-lock-language/);
});

test("FLAGS multiple qualifying added lines and counts them", () => {
  const old = "# Spec\n";
  const next = "# Spec\nThe schema is finalized.\nThe default architecture is decided.\n";
  const r = checkOperatorPause("illuci/design/governance-architecture.md", old, next);
  assert.equal(r.ok, false);
  assert.equal(r.signals.length, 2);
  assert.match(r.reason, /\(2 line\(s\)\)/);
});

// ---- the operator-ownership escape hatch (the prescribed pattern) -----------------------

test("QUIET when an operator-ownership marker is present (decision routed, not locked)", () => {
  const next = "The naming is ratified pending operator approval.\n";
  const r = checkOperatorPause("CORE.md", "", next);
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("QUIET when 'pending ratification' marks the decision as still open", () => {
  const next = "The schema is chosen (pending ratification).\n";
  const r = checkOperatorPause("DOCTRINE.md", "", next);
  assert.equal(r.ok, true);
});

test("QUIET when 'proposed' frames it as a proposal, not a lock", () => {
  const next = "Proposed: the naming convention is finalized as X.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, true);
});

// ---- precision: lock verb OR decision noun alone is not enough ---------------------------

test("does NOT flag a lock verb with no decision noun on the line", () => {
  const r = checkOperatorPause("CORE.md", "", "The release was finalized last week.\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("does NOT flag a decision noun with no lock verb on the line", () => {
  const r = checkOperatorPause("CORE.md", "", "The naming convention is under discussion.\n");
  assert.equal(r.ok, true);
});

// ---- diff semantics: only ADDED lines are scanned ----------------------------------------

test("does NOT re-flag lock language that already existed in the prior content", () => {
  const old = "The naming is ratified as X.\n";
  const next = "The naming is ratified as X.\nA new unrelated paragraph.\n";
  const r = checkOperatorPause("CORE.md", old, next);
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
});

test("CRLF vs LF in prior content is not a false positive", () => {
  const old = "The naming is ratified as X.\r\n";
  const next = "The naming is ratified as X.\nAppended note.\n";
  const r = checkOperatorPause("CORE.md", old, next);
  assert.equal(r.ok, true);
});


// ---- semantic promotion and spec prose posture ------------------------------------------

test("FLAGS raw operator speech promoted into governance without ratification evidence", () => {
  const r = checkOperatorPause("DOCTRINE.md", "", "The operator said this is canonical governance truth.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "unratified-operator-promotion");
  assert.equal(r.signals[0].code, "unratified-operator-promotion");
});

test("QUIET when operator speech is tied to an explicit decision record", () => {
  const r = checkOperatorPause("DOCTRINE.md", "", "DR-033 records the operator-ratified canonical governance posture.\n");
  assert.equal(r.ok, true);
});

test("FLAGS avoidable negative-qualifier prose in a root specification surface", () => {
  const r = checkOperatorPause("CORE.md", "", "Illuci does not adopt the old resolver as its canonical bridge.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "negative-qualifier-clutter");
});

test("QUIET for exclusion language inside a safety boundary", () => {
  const next = "## Safety Boundary\nIlluci does not expose local secrets through substrate bridge output.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, true);
});

test("FLAGS unmarked exposition in a root specification surface", () => {
  const next = "This bridge exists because older hosts need a quieter routing path.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, false);
  assert.equal(r.code, "unmarked-exposition");
  assert.equal(r.signals[0].code, "unmarked-exposition");
});

test("QUIET for exposition inside a marked rationale section", () => {
  const next = "## Rationale\nThis bridge exists because older hosts need a quieter routing path.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, true);
});

test("QUIET for exposition inside a marked context field", () => {
  const next = "*Context:* This bridge exists because older hosts need a quieter routing path.\n";
  const r = checkOperatorPause("CORE.md", "", next);
  assert.equal(r.ok, true);
});

test("QUIET for exposition in an append-only decision record", () => {
  const next = "## DR-999 | Example\n\n*Rationale:* This bridge exists because older hosts need a quieter routing path.\n";
  const r = checkOperatorPause("DECISION_REGISTRY.md", "", next);
  assert.equal(r.ok, true);
});

test("QUIET for exposition in a provenance record", () => {
  const next = "# Audit\n\nThis record exists because the change needs replayable evidence.\n";
  const r = checkOperatorPause("provenance/EXPOSITION-AUDIT.md", "", next);
  assert.equal(r.ok, true);
});

test("FLAGS unmarked exposition in an added source comment", () => {
  const next = "// This branch exists because older hosts need a quieter routing path.\nexport const x = 1;\n";
  const r = checkOperatorPause("core/governance/example.js", "", next);
  assert.equal(r.ok, false);
  assert.equal(r.code, "unmarked-exposition");
  assert.equal(r.signals[0].line, 1);
});

test("QUIET for marked rationale in an added source comment", () => {
  const next = "// Rationale: older hosts need a quieter compatibility path because provider ids vary.\nexport const x = 1;\n";
  const r = checkOperatorPause("core/governance/example.js", "", next);
  assert.equal(r.ok, true);
});

test("FLAGS retired integration terms reused as live canonical prose", () => {
  const r = checkOperatorPause("ARCHITECTURE.md", "", "The bridge writes sessions to `.neocli/sessions`.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "retired-term-reuse");
});

test("QUIET for retired terms inside compatibility provenance context", () => {
  const next = "## Compatibility Boundary\nLegacy substrate reads preserve `.neocli` provenance during migration.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, true);
});


test("FLAGS stale ILLUCI path posture outside EON provenance context", () => {
  const r = checkOperatorPause("ARCHITECTURE.md", "", "The bridge stores prompts under `ILLUCI/runtime` for active execution.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "retired-term-reuse");
});

test("QUIET for ILLUCI path references in EON provenance context", () => {
  const next = "Historical `ILLUCI/` path references identify EON provenance records.\n";
  const r = checkOperatorPause("CONTEXT.md", "", next);
  assert.equal(r.ok, true);
});

test("QUIET for canonical lowercase .illuci runtime paths", () => {
  const next = "Project substrate records write to `.illuci/project.json` and `.illuci/data`.\n";
  const r = checkOperatorPause("GOVERNANCE.md", "", next);
  assert.equal(r.ok, true);
});

test("FLAGS new design markdown without a Status header", () => {
  const next = `# Draft

This archived note records a future index.
`;
  const r = checkOperatorPause("design/new-note.md", "", next);
  assert.equal(r.ok, false);
  assert.equal(r.code, "design-archive-status-missing");
});

test("QUIET for new design markdown with a Status header", () => {
  const next = `| Document | Design Note |
|---|---|
| Status | PROVENANCE - indexed design record. |

# Design Note
`;
  const r = checkOperatorPause("design/new-note.md", "", next);
  assert.equal(r.ok, true);
});

// ---- determinism -------------------------------------------------------------------------

test("is deterministic: identical inputs yield identical verdicts", () => {
  const a = checkOperatorPause("CORE.md", "", "The schema is locked.\n");
  const b = checkOperatorPause("CORE.md", "", "The schema is locked.\n");
  assert.deepEqual(a, b);
});

// ---- floor wrapper: warn-tier operator-route shaping -------------------------------------

test("floor wrapper routes a detection to the operator (never blocks)", () => {
  const r = assessOperatorPause("CORE.md", "", "The naming is locked as X.\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "unratified-lock-language");
  assert.equal(r.route, "operator");
  assert.ok(Array.isArray(r.signals) && r.signals.length === 1);
});

test("floor wrapper passes a clean verdict through with no route", () => {
  const r = assessOperatorPause("CORE.md", "", "An ordinary descriptive paragraph.\n");
  assert.equal(r.ok, true);
  assert.equal(r.route, undefined);
});

test("floor wrapper passes out-of-scope through as ok", () => {
  const r = assessOperatorPause("notes/scratch.md", "", "The naming is ratified.\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "out-of-scope");
});

test("registers its atom name and the warn-tier (never-block) default", () => {
  assert.equal(ATOM, "operator-pause");
  assert.equal(DEFAULT_POLICY, "warn");
});
