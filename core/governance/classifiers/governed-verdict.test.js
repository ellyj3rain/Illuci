import { test } from "node:test";
import assert from "node:assert/strict";

import { SEVERITIES, makeGovernedVerdict, makeSignal, riskBandFor } from "./governed-verdict.js";

test("governed verdict keeps structured risk instead of a bare boolean", () => {
  const verdict = makeGovernedVerdict({
    classifier: "test.classifier",
    subject: "thing",
    decision: "operator-decision",
    allowed: true,
    code: "needs-human",
    signals: [
      makeSignal({
        code: "operator-signal",
        severity: SEVERITIES.OPERATOR,
        dimension: "ceremony",
        evidence: "operator ceremony is required",
      }),
    ],
  });

  assert.equal(verdict.schema, "illuci.governance.classifier-verdict/1");
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.requiresOperator, true);
  assert.equal(verdict.riskBand, "operator");
  assert.equal(verdict.audit.blockingSignals[0], "operator-signal");
});

test("risk band accumulates caution signals into a block", () => {
  const band = riskBandFor([
    makeSignal({ code: "a", severity: SEVERITIES.CAUTION }),
    makeSignal({ code: "b", severity: SEVERITIES.CAUTION }),
  ]);
  assert.equal(band, "block");
});
