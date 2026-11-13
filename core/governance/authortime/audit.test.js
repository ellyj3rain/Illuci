// illuci/core/governance/authortime/audit.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAuditRecord, appendAudit, AUDIT_RELPATH } from "./audit.js";

const TS = "2026-06-22 12:00 UTC / 05:00 PST";

test("buildAuditRecord: passed outcome when no blocking violations", () => {
  const rec = buildAuditRecord({ ts: TS, action: "commit", blocking: [], warnings: [] });
  assert.equal(rec.ts, TS);
  assert.equal(rec.action, "commit");
  assert.deepEqual(rec.blocking, []);
  assert.deepEqual(rec.warnings, []);
  assert.deepEqual(rec.override, { overridden: false, reason: null });
  assert.equal(rec.outcome, "passed");
});

test("buildAuditRecord: blocked outcome when blocking present and not overridden", () => {
  const blocking = [{ atom: "append-only", file: "FINDINGS.md", code: "append-only-violation", reason: "edited history" }];
  const rec = buildAuditRecord({ ts: TS, action: "commit", blocking, warnings: [] });
  assert.equal(rec.outcome, "blocked");
  assert.deepEqual(rec.blocking, blocking);
  assert.equal(rec.override.overridden, false);
});

test("buildAuditRecord: overridden outcome when blocking present and override set", () => {
  const blocking = [{ atom: "version-gate", file: "VERSION", code: "invalid-transition", reason: "hand-set jump" }];
  const override = { overridden: true, reason: "emergency hotfix for prod outage" };
  const rec = buildAuditRecord({ ts: TS, action: "commit", blocking, warnings: [], override });
  assert.equal(rec.outcome, "overridden");
  assert.deepEqual(rec.override, override);
});

test("buildAuditRecord: warnings are carried through independent of outcome", () => {
  const warnings = [{ atom: "cast-trailer", file: "COMMIT_MSG", code: "model-attribution", reason: "model attribution needs review" }];
  const rec = buildAuditRecord({ ts: TS, action: "commit", blocking: [], warnings });
  assert.equal(rec.outcome, "passed");
  assert.deepEqual(rec.warnings, warnings);
});

test("buildAuditRecord: defaults blocking/warnings to [] and override to false-shape", () => {
  const rec = buildAuditRecord({ ts: TS, action: "pre-tool-use" });
  assert.deepEqual(rec.blocking, []);
  assert.deepEqual(rec.warnings, []);
  assert.deepEqual(rec.override, { overridden: false, reason: null });
  assert.equal(rec.outcome, "passed");
});

test("buildAuditRecord: PURE - no clock used; null ts/action normalize predictably", () => {
  const rec = buildAuditRecord({});
  assert.equal(rec.ts, null);
  assert.equal(rec.action, null);
  assert.equal(rec.outcome, "passed");
});

test("buildAuditRecord: non-boolean overridden coerces to boolean", () => {
  const rec = buildAuditRecord({ ts: TS, action: "commit", blocking: [{ x: 1 }], override: { overridden: "yes", reason: "r" } });
  assert.equal(rec.override.overridden, true);
  assert.equal(rec.override.reason, "r");
  assert.equal(rec.outcome, "overridden");
});

test("AUDIT_RELPATH points at the .illuci governance JSONL ledger", () => {
  assert.equal(AUDIT_RELPATH, join(".illuci", "governance", "floor-audit.jsonl"));
});

test("appendAudit: writes a JSONL line, mkdir -p's the dirs, and round-trips", () => {
  const root = mkdtempSync(join(tmpdir(), "floor-audit-"));
  try {
    const rec = buildAuditRecord({ ts: TS, action: "commit", blocking: [], warnings: [] });
    const res = appendAudit(root, rec);
    assert.equal(res.ok, true);
    assert.equal(res.path, join(root, AUDIT_RELPATH));

    const raw = readFileSync(res.path, "utf8");
    assert.ok(raw.endsWith("\n"), "each record ends with a newline");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "exactly one JSONL line written");
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, rec, "the written line round-trips back to the record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendAudit: successive appends accumulate as separate JSONL lines", () => {
  const root = mkdtempSync(join(tmpdir(), "floor-audit-"));
  try {
    const a = buildAuditRecord({ ts: TS, action: "commit", blocking: [], warnings: [] });
    const b = buildAuditRecord({
      ts: TS,
      action: "commit",
      blocking: [{ atom: "header", file: "CORE.md", code: "header-stripped", reason: "lost header" }],
      override: { overridden: true, reason: "doc-pack restructure approved" },
    });
    appendAudit(root, a);
    const res = appendAudit(root, b);

    const lines = readFileSync(res.path, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), a);
    assert.deepEqual(JSON.parse(lines[1]), b);
    assert.equal(JSON.parse(lines[1]).outcome, "overridden");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
