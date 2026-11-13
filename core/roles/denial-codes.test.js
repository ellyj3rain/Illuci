/**
 * illuci — Role Governance · denial-codes tests (node:test, hermetic)
 *
 * Governance refusal layers have DISTINCT denial codes. These pin that the enum
 * is frozen, the values are distinct strings, and value === key.
 *
 * Run: node --test illuci/core/roles/denial-codes.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DENIAL_CODES } from "./denial-codes.js";

test("denial codes are distinct string values", () => {
  const values = [
    DENIAL_CODES.CAPABILITY_DENIED,
    DENIAL_CODES.SKILL_LICENSE_DENIED,
    DENIAL_CODES.PERMISSION_DENIED,
    DENIAL_CODES.WORK_PERMIT_DENIED,
  ];
  for (const v of values) assert.equal(typeof v, "string");
  assert.equal(new Set(values).size, values.length, "all codes must be distinct");
});

test("each value equals its key", () => {
  for (const [k, v] of Object.entries(DENIAL_CODES)) {
    assert.equal(k, v, `value of ${k} must equal its key`);
  }
});

test("DENIAL_CODES is frozen", () => {
  assert.ok(Object.isFrozen(DENIAL_CODES));
  assert.throws(() => { "use strict"; DENIAL_CODES.NEW_CODE = "x"; });
});
