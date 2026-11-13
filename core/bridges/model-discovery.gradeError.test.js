import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeError } from "./model-discovery.js";

test("gradeError: 429 / rate-limit / quota -> throttled (the classifyProbe blind spot)", () => {
  assert.equal(gradeError(new Error("HTTP 429: Too Many Requests"), "HTTP 429: Too Many Requests"), "throttled");
  assert.equal(gradeError(new Error("rate limit reached"), "rate limit reached"), "throttled");
  assert.equal(gradeError({ message: "You exceeded your current quota" }, "You exceeded your current quota"), "throttled");
  assert.equal(gradeError(new Error("model is overloaded"), "model is overloaded"), "throttled");
});

test("gradeError: a route miss, denied access and invalid request remain distinct", () => {
  assert.equal(gradeError(new Error("404 not found"), "404 not found"), "unavailable");
  assert.equal(gradeError(new Error("401 unauthorized"), "401 unauthorized"), "auth-or-access-denied");
  assert.equal(gradeError(new Error("403 forbidden"), "403 forbidden"), "auth-or-access-denied");
  assert.equal(gradeError(new Error("400 bad request"), "400 bad request"), "invalid-request");
  assert.equal(gradeError(new Error("422 validation error"), "422 validation error"), "invalid-request");
});

test("gradeError: missing / unloadable module -> missing (permanent transport fault)", () => {
  const e = new Error("Cannot find module './agy.js'");
  e.code = "ERR_MODULE_NOT_FOUND";
  assert.equal(gradeError(e, e.message), "missing");
});

test("gradeError: unrecognized transient blip -> unknown (non-blocking)", () => {
  assert.equal(gradeError(new Error("ECONNRESET socket hang up"), "ECONNRESET socket hang up"), "unknown");
});
