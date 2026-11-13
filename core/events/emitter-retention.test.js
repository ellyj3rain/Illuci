// [A116]/DR-203/F-143 — model_message content retention. The persisted telemetry
// copy and the live SSE event carried a hardcoded 500-char truncation that made
// long deliverables unrecoverable. Default keeps the full content;
// ILLUCI_TELEMETRY_MESSAGE_MAX caps it only when an operator sets a positive value.
import test from "node:test";
import assert from "node:assert/strict";

import { __test } from "./emitter.js";

const ORIG = process.env.ILLUCI_TELEMETRY_MESSAGE_MAX;

function withMax(value, fn) {
  if (value === undefined) delete process.env.ILLUCI_TELEMETRY_MESSAGE_MAX;
  else process.env.ILLUCI_TELEMETRY_MESSAGE_MAX = value;
  try {
    fn();
  } finally {
    if (ORIG === undefined) delete process.env.ILLUCI_TELEMETRY_MESSAGE_MAX;
    else process.env.ILLUCI_TELEMETRY_MESSAGE_MAX = ORIG;
  }
}

test("telemetry content keeps the full deliverable by default (far past the retired 500-char cap)", () => {
  const big = "DELIVERABLE ".repeat(1000); // ~12000 chars
  withMax(undefined, () => {
    assert.equal(__test.telemetryContent(big), big);
    assert.equal(__test.telemetryContent(big).length, big.length);
    assert.equal(__test.telemetryMessageMax(), 0); // 0 = unlimited
  });
});

test("ILLUCI_TELEMETRY_MESSAGE_MAX applies a positive cap; 0/empty/garbage stay unlimited", () => {
  const big = "x".repeat(5000);
  withMax("2000", () => assert.equal(__test.telemetryContent(big).length, 2000));
  withMax("0", () => assert.equal(__test.telemetryContent(big).length, 5000));
  withMax("", () => assert.equal(__test.telemetryContent(big).length, 5000));
  withMax("nonsense", () => assert.equal(__test.telemetryContent(big).length, 5000));
  withMax("-10", () => assert.equal(__test.telemetryContent(big).length, 5000));
});

test("telemetry content coerces non-strings and short content passes through", () => {
  withMax(undefined, () => {
    assert.equal(__test.telemetryContent("short"), "short");
    assert.equal(__test.telemetryContent(null), "");
    assert.equal(__test.telemetryContent(undefined), "");
    assert.equal(__test.telemetryContent(42), "42");
  });
});
