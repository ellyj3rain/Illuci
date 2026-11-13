// node:test - the pure FLOOR aggregator (runFloorChecks) + the policy classification.
// gatherChangeSet (git I/O) is exercised by running the CLI against the repo, not here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFloorChecks, DEFAULT_FLOOR_POLICY } from "./floor-check.js";

test("a clean changeset passes (valid bump + appended ledger)", () => {
  const r = runFloorChecks({
    version: { prior: "1.2.3", proposed: "1.2.0.4" },
    ledgers: [{ file: "BATCH_LOG.md", prior: "a\n", proposed: "a\nb\n" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("an empty changeset passes (nothing staged to check)", () => {
  assert.equal(runFloorChecks({}).ok, true);
});

test("unchanged VERSION + appended ledger passes", () => {
  const r = runFloorChecks({
    version: { prior: "1.2.3", proposed: "1.2.3" },
    ledgers: [{ file: "BATCH_LOG.md", prior: "a\n", proposed: "a\nb\n" }],
  });
  assert.equal(r.ok, true);
});

test("a bad version transition blocks (default policy)", () => {
  const r = runFloorChecks({ version: { prior: "5.8.0.0", proposed: "5.10.0.0" } });
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].atom, "version-gate");
});

test("a ledger history-edit blocks (default policy)", () => {
  const r = runFloorChecks({ ledgers: [{ file: "DECISION_REGISTRY.md", prior: "x\ny\n", proposed: "X\ny\n" }] });
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].atom, "append-only");
});

test("multiple block-tier violations are all collected", () => {
  const r = runFloorChecks({
    version: { prior: "5.8.0.0", proposed: "5.10.0.0" },
    ledgers: [{ file: "FINDINGS.md", prior: "x\n", proposed: "Y\n" }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 2);
});

test("a warn-mode atom yields a warning, not a block", () => {
  const r = runFloorChecks({ version: { prior: "5.8.0.0", proposed: "5.10.0.0" } }, { "version-gate": "warn" });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].atom, "version-gate");
});

test("an off-mode atom is ignored entirely (consumer opted out)", () => {
  const r = runFloorChecks(
    { ledgers: [{ file: "DECISION_REGISTRY.md", prior: "x\ny\n", proposed: "X\ny\n" }] },
    { "append-only": "off" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("default policy preserves odometer/append-only and has no companion-generation atom", () => {
  assert.equal(DEFAULT_FLOOR_POLICY["version-gate"], "block");
  assert.equal(DEFAULT_FLOOR_POLICY["append-only"], "block");
  assert.equal(Object.hasOwn(DEFAULT_FLOOR_POLICY, "dual-format"), false);
});

test("a stripped doc-pack header blocks (default policy: header=block)", () => {
  const HEADER = "| Document | T |\n|---|---|\n| Version | 1.0.0 |\n| Repository | p |\n";
  const r = runFloorChecks({ docPack: [{ file: "CORE.md", prior: HEADER, proposed: "# no header\n" }] });
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].atom, "header");
});

test("ordinary Markdown has no twin prerequisite, including a legacy policy override", () => {
  const r = runFloorChecks({ twins: [{ md: "CORE.md", mdChanged: true, twinExists: false, twinChanged: false }] }, { "dual-format": "block" });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});

test("default policy surfaces operator-pause as a warning", () => {
  assert.equal(DEFAULT_FLOOR_POLICY["operator-pause"], "warn");
  const r = runFloorChecks({
    docPack: [{ file: "DOCTRINE.md", prior: "", proposed: "The user said this is canonical doctrine.\n" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings[0].atom, "operator-pause");
  assert.equal(r.warnings[0].code, "unratified-operator-promotion");
});

test("operator-pause can be disabled by project policy", () => {
  const r = runFloorChecks(
    { docPack: [{ file: "DOCTRINE.md", prior: "", proposed: "The user said this is canonical doctrine.\n" }] },
    { "operator-pause": "off" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 0);
});
