// core/matrix/no-exclusive-candidates.test.js — [A48]/DR-128
//
// The operator's invariant: "there is no such thing as exclusive candidates for
// roles." A role that only ONE model DECLARES (regardless of live availability)
// is a data bug — it guarantees a single point of failure and, when that lone
// model is a dead lane (auditor -> claude-sonnet), a role that can never be
// seated live. This is the DATA-level enforcement: it reads the static
// MODEL_CAPABILITIES declaration breadth, independent of runtime health.

import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_CAPABILITIES, getRoles } from "./capability-matrix.js";
import { MIN_CANDIDATES } from "../fleet/seating-engine.js";

/** Count how many models DECLARE a role in the static matrix. */
function declaredCount(role) {
  let n = 0;
  for (const caps of Object.values(MODEL_CAPABILITIES)) if (caps[role]) n++;
  return n;
}

test("every role is declared by at least MIN_CANDIDATES models (no exclusive candidates)", () => {
  const offenders = getRoles()
    .map((role) => ({ role, count: declaredCount(role) }))
    .filter((r) => r.count < MIN_CANDIDATES);
  assert.deepEqual(
    offenders,
    [],
    `roles with fewer than ${MIN_CANDIDATES} declared candidates (a data bug — every role needs a real fallback):\n` +
      offenders.map((o) => `  ${o.role}: ${o.count}`).join("\n"),
  );
});
