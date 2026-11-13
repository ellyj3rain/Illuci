// illuci/core/governance/authortime/override.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOverride, MIN_REASON_LEN } from "./override.js";

test("override absent: env has no GZDS_OVERRIDE -> not overridden", () => {
  const r = checkOverride({});
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("override absent: GZDS_OVERRIDE undefined -> not overridden", () => {
  const r = checkOverride({ GZDS_OVERRIDE: undefined });
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("override too-trivial: empty string -> not overridden", () => {
  const r = checkOverride({ GZDS_OVERRIDE: "" });
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("override too-trivial: whitespace-only -> not overridden", () => {
  const r = checkOverride({ GZDS_OVERRIDE: "     " });
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("override too-trivial: short value like '1' / 'true' / 'y' -> not overridden", () => {
  for (const v of ["1", "true", "y", "yes"]) {
    const r = checkOverride({ GZDS_OVERRIDE: v });
    assert.equal(r.overridden, false, `value "${v}" must not override`);
    assert.equal(r.reason, null);
  }
});

test("override too-trivial: just under the minimum length -> not overridden", () => {
  const v = "x".repeat(MIN_REASON_LEN - 1);
  const r = checkOverride({ GZDS_OVERRIDE: v });
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("override present: a real reason at the minimum length -> overridden", () => {
  const v = "x".repeat(MIN_REASON_LEN);
  const r = checkOverride({ GZDS_OVERRIDE: v });
  assert.equal(r.overridden, true);
  assert.equal(r.reason, v);
});

test("override present: a descriptive reason -> overridden, reason captured", () => {
  const r = checkOverride({ GZDS_OVERRIDE: "emergency hotfix for prod outage" });
  assert.equal(r.overridden, true);
  assert.equal(r.reason, "emergency hotfix for prod outage");
});

test("override present: surrounding whitespace is trimmed in the recorded reason", () => {
  const r = checkOverride({ GZDS_OVERRIDE: "   migration: legacy ledger reconcile   " });
  assert.equal(r.overridden, true);
  assert.equal(r.reason, "migration: legacy ledger reconcile");
});

test("non-string GZDS_OVERRIDE -> not overridden (defensive)", () => {
  // env values are strings in practice; guard against a non-string slipping in.
  const r = checkOverride({ GZDS_OVERRIDE: 123456 });
  assert.equal(r.overridden, false);
  assert.equal(r.reason, null);
});

test("default arg does not throw when process.env is used", () => {
  // Smoke: calling with no arg reads process.env and returns the shape.
  const r = checkOverride();
  assert.equal(typeof r.overridden, "boolean");
  assert.ok(r.reason === null || typeof r.reason === "string");
});
