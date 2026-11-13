// node:test - the odometer-legality slice of `illuci project assess`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessOdometer, assessProject, computeNextVersion } from "./assess.js";

test("assessOdometer flags a MINOR over the hard cap (4.13.0.0 is illegal)", () => {
  const r = assessOdometer("4.13.0.0");
  assert.equal(r.legal, false);
  assert.match(r.violation, /MINOR=13/);
  assert.equal(r.ceiling, "4.12.16.24");
});

test("assessOdometer accepts the exact ceiling X.12.16.24", () => {
  assert.equal(assessOdometer("4.12.16.24").legal, true);
});

test("assessOdometer flags a PATCH over the hard cap", () => {
  const r = assessOdometer("4.12.16.25");
  assert.equal(r.legal, false);
  assert.match(r.violation, /PATCH=25/);
});

test("assessOdometer accepts a legal version", () => {
  assert.equal(assessOdometer("5.6.1.0").legal, true);
});

test("assessOdometer rejects a malformed version", () => {
  const r = assessOdometer("4.x");
  assert.equal(r.legal, false);
  assert.match(r.violation, /malformed/);
});

test("assessProject = exception-bearing on an illegal VERSION", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-assess-"));
  try {
    writeFileSync(join(dir, "VERSION"), "4.13.0.0\n");
    const r = assessProject(dir);
    assert.equal(r.verdict, "exception-bearing");
    assert.equal(r.version, "4.13.0.0");
    assert.ok(r.findings.some((f) => f.code === "odometer-illegal"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assessProject = standard on a legal VERSION", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-assess-"));
  try {
    writeFileSync(join(dir, "VERSION"), "5.6.1.0\n");
    const r = assessProject(dir);
    assert.equal(r.verdict, "standard");
    assert.equal(r.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assessProject = blocked when VERSION is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-assess-"));
  try {
    const r = assessProject(dir);
    assert.equal(r.verdict, "blocked");
    assert.ok(r.findings.some((f) => f.code === "version-missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeNextVersion: MINOR bump (1.2.0.0 -> 1.3.0.0)", () => {
  const r = computeNextVersion("1.2.0.0", "minor");
  assert.equal(r.ok, true);
  assert.equal(r.next, "1.3.0.0");
});

test("computeNextVersion: MINOR hard-cap rolls MAJOR (1.12.0.0 -> 2.0.0.0)", () => {
  assert.equal(computeNextVersion("1.12.0.0", "minor").next, "2.0.0.0");
});

test("computeNextVersion: PATCH hard-cap rolls KOHAI (1.0.0.24 -> 1.0.1.0)", () => {
  assert.equal(computeNextVersion("1.0.0.24", "patch").next, "1.0.1.0");
});

test("computeNextVersion: chained PATCH->KOHAI->MINOR->MAJOR overflow", () => {
  assert.equal(computeNextVersion("1.12.16.24", "patch").next, "2.0.0.0");
});

test("computeNextVersion: PATCH bump unaffected by MINOR at cap", () => {
  assert.equal(computeNextVersion("1.12.0.0", "patch").next, "1.12.0.1");
});

test("computeNextVersion: discretionary MAJOR (1.2.0.0 major -> 2.0.0.0)", () => {
  assert.equal(computeNextVersion("1.2.0.0", "major").next, "2.0.0.0");
});

test("computeNextVersion: reports the soft milestone marker at MINOR=10", () => {
  const r = computeNextVersion("1.9.0.0", "minor");
  assert.equal(r.next, "1.10.0.0");
  assert.match(r.softMarker, /soft milestone/);
});

test("computeNextVersion: REJECTS an illegal current version", () => {
  const r = computeNextVersion("5.13.0.0", "minor");
  assert.equal(r.ok, false);
  assert.match(r.error, /illegal/);
});

test("computeNextVersion: rejects a bad tier", () => {
  assert.equal(computeNextVersion("1.2.0.0", "frobnicate").ok, false);
});
