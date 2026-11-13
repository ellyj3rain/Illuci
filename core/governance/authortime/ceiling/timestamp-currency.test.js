// node:test - the header-timestamp CURRENCY ceiling rule (advisory complement to the floor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTimestampCurrency } from "./timestamp-currency.js";

const TS_A = "2026-06-22 10:17 UTC / 03:17 PDT";
const TS_B = "2026-06-22 18:40 UTC / 11:40 PDT";

// A GZS header carrying timestamp `ts`, followed by a body `body`.
const doc = (ts, body) =>
  `| Document | Thing |\n|---|---|\n| Version | 1.0.0 |\n| Timestamp | ${ts} |\n| Author | y |\n| Repository | \`p\` |\n\n${body}\n`;

test("STALE: body changed but the header Timestamp did not move (the finding)", () => {
  const r = checkTimestampCurrency({
    path: "primitives/patterns/thing.md",
    oldContent: doc(TS_A, "# Body\noriginal prose\n"),
    newContent: doc(TS_A, "# Body\nREVISED prose\n"),
  });
  assert.equal(r.stale, true);
  assert.equal(r.code, "timestamp-stale");
  assert.equal(r.newTimestamp, TS_A);
});

test("FRESH: body changed and the Timestamp advanced -> timestamp-advanced (not stale)", () => {
  const r = checkTimestampCurrency({
    path: "primitives/patterns/thing.md",
    oldContent: doc(TS_A, "# Body\noriginal prose\n"),
    newContent: doc(TS_B, "# Body\nREVISED prose\n"),
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "timestamp-advanced");
});

test("body-unchanged: a timestamp-only / no-op edit is not stale (no circular finding)", () => {
  const r = checkTimestampCurrency({
    path: "primitives/patterns/thing.md",
    oldContent: doc(TS_A, "# Body\nsame prose\n"),
    newContent: doc(TS_A, "# Body\nsame prose\n"),
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "body-unchanged");
});

test("a body edit that only moved the Timestamp field is body-unchanged (header is excluded)", () => {
  // Only the timestamp differs; the body is identical -> we must NOT call this stale.
  const r = checkTimestampCurrency({
    path: "primitives/patterns/thing.md",
    oldContent: doc(TS_A, "# Body\nsame prose\n"),
    newContent: doc(TS_B, "# Body\nsame prose\n"),
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "body-unchanged");
});

test("not-markdown: a source file is out of scope (it has no GZS header)", () => {
  const r = checkTimestampCurrency({
    path: "illuci/core/governance/assess.js",
    oldContent: "export const a = 1;\n",
    newContent: "export const a = 2;\n",
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "not-markdown");
});

test("new-file: a brand-new doc's timestamp is original, not stale", () => {
  const r = checkTimestampCurrency({
    path: "primitives/patterns/thing.md",
    oldContent: "",
    newContent: doc(TS_A, "# Body\nfresh\n"),
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "new-file");
});

test("no-timestamp-field: a markdown doc without a header Timestamp is out of scope", () => {
  const r = checkTimestampCurrency({
    path: "primitives/patterns/plain.md",
    oldContent: "# plain\nold\n",
    newContent: "# plain\nnew\n",
  });
  assert.equal(r.stale, false);
  assert.equal(r.code, "no-timestamp-field");
});

test("clock-free + deterministic: identical inputs -> identical verdict", () => {
  const a = checkTimestampCurrency({ path: "x.md", oldContent: doc(TS_A, "a\n"), newContent: doc(TS_A, "b\n") });
  const b = checkTimestampCurrency({ path: "x.md", oldContent: doc(TS_A, "a\n"), newContent: doc(TS_A, "b\n") });
  assert.deepEqual(a, b);
});
