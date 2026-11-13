// node:test - the GZS-header preservation floor atom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGzsHeader, checkHeaderPreserved } from "./header.js";

const HEADER =
  "| Document | Thing |\n|---|---|\n| Version | 1.0.0 |\n| Timestamp | x |\n| Author | y |\n| Repository | `p` |\n\n# Body\n";

test("hasGzsHeader detects the GZS header table", () => {
  assert.equal(hasGzsHeader(HEADER), true);
});

test("hasGzsHeader is false for a plain doc", () => {
  assert.equal(hasGzsHeader("# Just a title\n\nprose\n"), false);
});

test("header kept across an edit -> ok", () => {
  assert.equal(checkHeaderPreserved(HEADER, HEADER + "more body\n").ok, true);
});

test("BLOCKS stripping an existing header", () => {
  const r = checkHeaderPreserved(HEADER, "# Body\nno header now\n");
  assert.equal(r.ok, false);
  assert.equal(r.code, "header-stripped");
});

test("a file that never had a header is not forced to add one (floor = preservation)", () => {
  assert.equal(checkHeaderPreserved("# plain\n", "# plain\nedited\n").ok, true);
});
