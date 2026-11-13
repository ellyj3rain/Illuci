// core/bridges/cli-error.test.js — [A46]/F-088 pure coverage for the shared
// CLI-reported-error detector.

import test from "node:test";
import assert from "node:assert/strict";
import { cliReportedError } from "./cli-error.js";

test("claude's exit-0 error shape is detected (is_error true, message in result)", () => {
  const msg = cliReportedError({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
  assert.match(msg, /Not logged in/);
});

test("grok's error shape is detected (type error, message field)", () => {
  const msg = cliReportedError({ type: "error", message: "Internal error: upstream 500" });
  assert.match(msg, /Internal error/);
});

test("real answers pass through as null", () => {
  assert.equal(cliReportedError({ type: "result", is_error: false, result: "OK" }), null);
  assert.equal(cliReportedError({ result: "OK", usage: { input_tokens: 1 } }), null);
});

test("degenerate inputs are never misclassified", () => {
  assert.equal(cliReportedError(null), null);
  assert.equal(cliReportedError("Not logged in"), null);
  assert.equal(cliReportedError([1, 2]), null);
  const unnamed = cliReportedError({ is_error: true });
  assert.match(unnamed, /unknown CLI-reported error/, "an error report with no message still names itself");
});
