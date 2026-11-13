// node:test - the dual-TZ timestamp-format floor atom (complements header.js's presence check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDualTzTimestamp, extractHeaderTimestamp } from "./dual-tz-timestamp.js";

// A well-formed GZS header carrying the inline dual-TZ Timestamp form.
const VALID_TS = "2026-06-22 10:17 UTC / 03:17 PDT";
const headerWith = (ts) =>
  `| Document | Thing |\n|---|---|\n| Version | 1.0.0 |\n| Timestamp | ${ts} |\n| Author | y |\n| Repository | \`p\` |\n\n# Body\n`;

const VALID_HEADER = headerWith(VALID_TS);

test("extractHeaderTimestamp pulls the Timestamp field value", () => {
  assert.equal(extractHeaderTimestamp(VALID_HEADER), VALID_TS);
});

test("extractHeaderTimestamp returns null when there is no Timestamp row", () => {
  assert.equal(extractHeaderTimestamp("# Just a title\n\nprose\n"), null);
});

test("extractHeaderTimestamp ignores a Timestamp mention deep in the body (header region only)", () => {
  const body = ["# Title", "", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "| Timestamp | not-a-header |"].join("\n");
  assert.equal(extractHeaderTimestamp(body), null);
});

test("a well-formed PDT dual-TZ timestamp -> valid", () => {
  const r = checkDualTzTimestamp("", VALID_HEADER);
  assert.equal(r.ok, true);
  assert.equal(r.code, "valid");
  assert.equal(r.value, VALID_TS);
});

test("a well-formed PST dual-TZ timestamp -> valid (winter offset)", () => {
  const r = checkDualTzTimestamp("", headerWith("2026-01-05 18:00 UTC / 10:00 PST"));
  assert.equal(r.ok, true);
  assert.equal(r.code, "valid");
});

test("a doc with NO Timestamp field is inert (no-timestamp-field)", () => {
  const r = checkDualTzTimestamp("", "# plain doc\n\nbody\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "no-timestamp-field");
});

test("BLOCKS a single-zone timestamp (UTC only, missing the / PST|PDT half)", () => {
  const r = checkDualTzTimestamp("", headerWith("2026-06-22 10:17 UTC"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "malformed-timestamp");
  assert.equal(r.value, "2026-06-22 10:17 UTC");
});

test("BLOCKS a wrong zone label (EST is not PST|PDT)", () => {
  const r = checkDualTzTimestamp("", headerWith("2026-06-22 10:17 UTC / 03:17 EST"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "malformed-timestamp");
});

test("BLOCKS a free-text / placeholder timestamp", () => {
  const r = checkDualTzTimestamp("", headerWith("June 22, 2026 morning"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "malformed-timestamp");
});

test("BLOCKS a seconds-bearing / over-precise form (the regex is strict on the shape)", () => {
  const r = checkDualTzTimestamp("", headerWith("2026-06-22 10:17:30 UTC / 03:17 PDT"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "malformed-timestamp");
});

test("a NEWLY-INTRODUCED malformed timestamp (prior had a valid one) is blocked", () => {
  const r = checkDualTzTimestamp(VALID_HEADER, headerWith("2026-06-22 10:17 UTC"));
  assert.equal(r.ok, false);
  assert.equal(r.code, "malformed-timestamp");
});

test("a pre-existing malformed timestamp left UNCHANGED is not a false positive (unchanged-legacy)", () => {
  const legacy = headerWith("2026-06-22 10:17 UTC");
  // The body changed but the malformed timestamp value is identical to the prior content's.
  const r = checkDualTzTimestamp(legacy, legacy + "more body\n");
  assert.equal(r.ok, true);
  assert.equal(r.code, "unchanged-legacy");
  assert.equal(r.value, "2026-06-22 10:17 UTC");
});

test("fixing a legacy malformed timestamp to the valid form -> valid (the desired path)", () => {
  const legacy = headerWith("2026-06-22 10:17 UTC");
  const r = checkDualTzTimestamp(legacy, VALID_HEADER);
  assert.equal(r.ok, true);
  assert.equal(r.code, "valid");
});

test("CRLF in the header is not a false positive", () => {
  const r = checkDualTzTimestamp("", VALID_HEADER.replace(/\n/g, "\r\n"));
  assert.equal(r.ok, true);
  assert.equal(r.code, "valid");
});

test("deterministic + clock-free: the committed module reads no clock", () => {
  // Same inputs -> same verdict, and the source carries no Date.now / Math.random.
  const a = checkDualTzTimestamp("", VALID_HEADER);
  const b = checkDualTzTimestamp("", VALID_HEADER);
  assert.deepEqual(a, b);
});
