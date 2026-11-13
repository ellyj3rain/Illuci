/**
 * illuci — persona-kernel loader + Tier-1 addon gate ([A82]/DR-175).
 *
 * Two tiers of test, matching the optional-load posture:
 *   - HERMETIC (always run; CI is node-only): the loader's absent/mismatch
 *     behavior, the decoder contract, error-code vocabulary.
 *   - ADDON (skip unless the addon is built — `npm run kernel:napi:build`):
 *     the ADR-04 worked-example golden traces, marshalling roundtrip,
 *     determinism, and the closed ADR-07 error codes across the real FFI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadPersonaKernel, decodeActivations, KERNEL_ERROR_CODES } from "./persona-kernel.js";

// ── hermetic ────────────────────────────────────────────────────────────────

test("loader: absent addon is honest and harmless — available:false with the build pointer", () => {
  const k = loadPersonaKernel({ addonPath: join(tmpdir(), "definitely-not-built.node"), force: true });
  assert.equal(k.available, false);
  assert.match(k.reason, /not built/);
  assert.match(k.reason, /kernel:napi:build/);
});

test("decoder: rejects a blob that is not whole 12-byte records", () => {
  assert.throws(() => decodeActivations(Buffer.alloc(13)), (e) => e.code === "KERNEL_BAD_SEED_BLOB");
});

test("the ADR-07 error vocabulary is closed and stable", () => {
  assert.deepEqual([...KERNEL_ERROR_CODES], [
    "KERNEL_BAD_AXES_LEN",
    "KERNEL_BAD_CATEGORICAL_LEN",
    "KERNEL_AXIS_NOT_FINITE",
    "KERNEL_AXIS_RANGE",
    "KERNEL_BAD_SEED_BLOB",
    "KERNEL_BAD_SIGNAL",     // DR-176 (B2)
    "KERNEL_BAD_DIRECTIONS", // DR-176 (B2)
  ]);
});

// ── addon (skipped until built) ─────────────────────────────────────────────

const kernel = loadPersonaKernel({ force: true });
const skip = kernel.available ? false : "addon not built (npm run kernel:napi:build)";

const mid = () => new Array(68).fill(0.5);

test("addon: kernelInfo pins the ABI (68 axes, 547-byte seed, 12-byte records)", { skip }, () => {
  assert.equal(kernel.info.abi, "persona-kernel-napi/1");
  assert.equal(kernel.info.nAxes, 68);
  assert.equal(kernel.info.nCategorical, 3);
  assert.equal(kernel.info.seedBlobLen, 547);
  assert.equal(kernel.info.activationRecordLen, 12);
});

test("addon: the ADR-04 worked-example traces hold byte-exactly across the FFI", { skip }, () => {
  // axis_11 is the ADR-04 example coordinate; the three ratified traces:
  //   0.82 -> q 3_521_873_183, band7 5, directive_band +1
  //   0.50 -> q 2_147_483_648, band7 3, directive_band  0
  //   0.18 -> q   773_094_113, band7 1, directive_band -1
  for (const [seedVal, q, band7, db] of [
    [0.82, 3_521_873_183n, 5, 1],
    [0.5, 2_147_483_648n, 3, 0],
    [0.18, 773_094_113n, 1, -1],
  ]) {
    const values = mid();
    values[11] = seedVal;
    const blob = kernel.seedFromPreset(values, [3, 4, 1]);
    assert.equal(blob.length, 547);
    const acts = decodeActivations(kernel.renderDirective(blob));
    assert.equal(acts.length, 68);
    const a11 = acts.find((a) => a.axis === 11);
    assert.equal(a11.qValue, q, `q(${seedVal})`);
    assert.equal(a11.band7, band7, `band7(${seedVal})`);
    assert.equal(a11.directiveBand, db, `directive_band(${seedVal})`);
  }
});

test("addon: marshalling roundtrip is deterministic and byte-identical", { skip }, () => {
  const values = mid().map((v, i) => (i % 7) / 7); // varied but in [0,1]
  const b1 = kernel.seedFromPreset(values, [1, 2, 3]);
  const b2 = kernel.seedFromPreset(values, [1, 2, 3]);
  assert.deepEqual(Buffer.from(b1), Buffer.from(b2), "same inputs -> same seed blob");
  const r1 = kernel.renderDirective(b1);
  const r2 = kernel.renderDirective(b2);
  assert.deepEqual(Buffer.from(r1), Buffer.from(r2), "same seed -> same activation blob");
  // categorical codes survive the blob (last 3 bytes)
  const tail = Buffer.from(b1).subarray(544);
  assert.deepEqual([...tail], [1, 2, 3]);
});

test("addon: the closed ADR-07 error codes surface on error.code", { skip }, () => {
  const expect = (fn, code) => {
    try {
      fn();
      assert.fail(`expected ${code}`);
    } catch (e) {
      assert.equal(e.code, code, e.message);
    }
  };
  expect(() => kernel.seedFromPreset(new Array(67).fill(0.5), [0, 0, 0]), "KERNEL_BAD_AXES_LEN");
  expect(() => kernel.seedFromPreset(mid(), [0, 0]), "KERNEL_BAD_CATEGORICAL_LEN");
  expect(() => kernel.seedFromPreset(mid().fill(NaN, 3, 4), [0, 0, 0]), "KERNEL_AXIS_NOT_FINITE");
  expect(() => kernel.seedFromPreset(mid().fill(1.5, 9, 10), [0, 0, 0]), "KERNEL_AXIS_RANGE");
  expect(() => kernel.renderDirective(Buffer.alloc(10)), "KERNEL_BAD_SEED_BLOB");
});

// ── addon: DR-176 v1 grade (Phase B2) ───────────────────────────────────────

test("addon: gradeSignals — gated consolidation, exact dyadic steps", { skip }, () => {
  // gated: stable + enough runs -> ±1/32 exactly
  const gated = kernel.decodeDeltas(kernel.gradeSignals(0.9, 3, [1, -1, 1]));
  assert.deepEqual(gated, [0.03125, -0.03125, 0.03125]);
  // stability below 0.75 -> all zero (fail-quiet)
  const churn = kernel.decodeDeltas(kernel.gradeSignals(0.74, 10, [1, -1]));
  assert.deepEqual(churn, [0, 0]);
  // single run -> all zero (no learning from one observation)
  const single = kernel.decodeDeltas(kernel.gradeSignals(1.0, 1, [1, -1]));
  assert.deepEqual(single, [0, 0]);
  // exactly at the gates -> grades (>= semantics)
  const edge = kernel.decodeDeltas(kernel.gradeSignals(0.75, 2, [-1]));
  assert.deepEqual(edge, [-0.03125]);
});

test("addon: gradeSignals is deterministic and byte-identical", { skip }, () => {
  const a = Buffer.from(kernel.gradeSignals(0.8, 4, [1, -1, 1, -1]));
  const b = Buffer.from(kernel.gradeSignals(0.8, 4, [1, -1, 1, -1]));
  assert.deepEqual(a, b);
});

test("addon: gradeSignals rejects malformed signals with the DR-176 codes", { skip }, () => {
  const expect = (fn, code) => {
    try { fn(); assert.fail(`expected ${code}`); } catch (e) { assert.equal(e.code, code, e.message); }
  };
  expect(() => kernel.gradeSignals(NaN, 2, [1]), "KERNEL_BAD_SIGNAL");
  expect(() => kernel.gradeSignals(1.5, 2, [1]), "KERNEL_BAD_SIGNAL");
  expect(() => kernel.gradeSignals(0.9, 2, [1, 0]), "KERNEL_BAD_DIRECTIONS");
  expect(() => kernel.gradeSignals(0.9, 2, [2]), "KERNEL_BAD_DIRECTIONS");
});
