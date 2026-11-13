// illuci/core/governance/authortime/maturity.test.js
//
// Verifies the Standard 13 maturity suffix is ENFORCED, not just documented: the odometer source
// parses/validates the suffix, a count bump preserves it, a promotion climbs one rung (rc -> GA),
// and the version gate accepts a count bump or a single-rung promotion while rejecting a skip.
// Backward-compat: legacy X.Y.Z roots parse, but successors migrate onto X.Y.K.P.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessOdometer, computeNextVersion, maturitySuccessors } from "../assess.js";
import { checkVersionTransition } from "./version-gate.js";

test("assessOdometer: X.Y.K.P is GA; a valid suffix parses; a bad suffix is illegal", () => {
  const ga = assessOdometer("6.8.0.2");
  assert.equal(ga.legal, true);
  assert.equal(ga.maturity, null);
  assert.equal(ga.kohai, 0);
  assert.equal(ga.patch, 2);
  const a = assessOdometer("6.9.1.0-alpha");
  assert.equal(a.legal, true);
  assert.equal(a.maturity, "alpha");
  assert.equal(a.kohai, 1);
  assert.equal(a.patch, 0);
  assert.equal(assessOdometer("6.9.1.0-banana").legal, false);
  assert.equal(assessOdometer("6.9.1.0-alpha.kohai.1").legal, false);
  assert.equal(assessOdometer("6.13.0.0-alpha").legal, false);
  assert.equal(assessOdometer("6.9.17.0-alpha").legal, false);
  assert.equal(assessOdometer("6.9.1.25-alpha").legal, false);
});

test("computeNextVersion preserves the maturity suffix across a count bump", () => {
  assert.equal(computeNextVersion("6.9.1.0-alpha", "minor").next, "6.10.0.0-alpha");
  assert.equal(computeNextVersion("6.8.2", "minor").next, "6.9.0.0"); // legacy three-part input migrates to four-part root version
});

test("computeNextVersion supports kohai as the third numeric coordinate", () => {
  const r = computeNextVersion("2.7.0-alpha", "kohai");
  assert.equal(r.next, "2.7.1.0-alpha");
  assert.equal(r.tier, "kohai");
  assert.equal(computeNextVersion("2.7.1.0-alpha", "patch").next, "2.7.1.1-alpha");
  assert.equal(computeNextVersion("2.7.1.24-alpha", "patch").next, "2.7.2.0-alpha");
  assert.equal(computeNextVersion("2.7.16.0-alpha", "kohai").next, "2.8.0.0-alpha");
  assert.equal(computeNextVersion("2.12.16.24-alpha", "patch").next, "3.0.0.0-alpha");
});

test("maturitySuccessors: climbs one rung, rc -> bare GA, nothing at GA", () => {
  assert.deepEqual(maturitySuccessors("6.9.1.0-alpha"), ["6.9.1.0-beta"]);
  assert.deepEqual(maturitySuccessors("6.9.1.0-rc"), ["6.9.1.0"]);
  assert.deepEqual(maturitySuccessors("6.9.1.0"), []);
});

test("version gate: count bump + single-rung promotion valid; a rung-skip is not", () => {
  assert.equal(checkVersionTransition("6.8.2", "6.9.0.0").ok, true);             // legacy bare minor migrates to four-part root version
  assert.equal(checkVersionTransition("6.9.1.0-alpha", "6.10.0.0-alpha").ok, true); // count bump, suffix kept
  assert.equal(checkVersionTransition("6.9.1.0-alpha", "6.9.1.0-beta").ok, true);   // maturity promotion
  assert.equal(checkVersionTransition("6.9.1.0-rc", "6.9.1.0").ok, true);           // rc -> GA
  assert.equal(checkVersionTransition("6.8.2", "6.9.0.0-alpha").ok, true);        // policy-introduction stamp on a legacy bare version
  assert.equal(checkVersionTransition("2.1.1", "2.1.1-alpha").ok, true);        // same-core corrective stamp
  assert.equal(checkVersionTransition("6.8.2", "6.11.0.0-alpha").ok, false);      // an out-of-step CORE is still blocked
  assert.equal(checkVersionTransition("6.9.1.0-alpha", "6.9.1.0-rc").ok, false);    // skipping beta is not one step
});
