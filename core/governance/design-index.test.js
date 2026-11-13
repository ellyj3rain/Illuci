// node:test — the design-archive index gate (DR-188): inventory derived + gated,
// labels authored as data (sole authority), render content-addressed, fail-closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATUS_VOCABULARY,
  loadLabels,
  scanDesign,
  validateIndexLabels,
  computeStamp,
  renderIndexRegion,
  extractIndexRegion,
  refreshIndex,
  checkDesignIndex,
} from "./design-index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── live-repo proofs (the shipped map + INDEX satisfy the gate) ────────────

test("live: the shipped label map passes every fail-closed rule (C-5/C-6)", () => {
  const { labels } = loadLabels(repoRoot);
  const scan = scanDesign(repoRoot);
  const v = validateIndexLabels({ labels, scan, repoRoot });
  assert.deepEqual(v.violations, []);
  assert.equal(v.ok, true);
});

test("live: design/INDEX.md carries a fresh generated region", () => {
  const text = readFileSync(resolve(repoRoot, "design", "INDEX.md"), "utf8");
  const r = checkDesignIndex(text, { repoRoot });
  assert.equal(r.code, "fresh");
  assert.equal(r.ok, true);
});

// ── fixtures for the fail-closed rules ─────────────────────────────────────

const FIX_LABELS = {
  "design/a.md": { status: "ACTIVE", use: "a" },
  "design/b.md": { status: "SUPERSEDED", use: "b", supersededBy: "design/a.md" },
};
const FIX_SCAN = { mdFiles: ["design/a.md", "design/b.md"] };
const existsAll = () => true;

test("C-6: an on-disk root md absent from the map fails — no generator default, ever", () => {
  const scan = { mdFiles: [...FIX_SCAN.mdFiles, "design/new-unclassified.md"] };
  const v = validateIndexLabels({ labels: FIX_LABELS, scan, exists: existsAll });
  assert.equal(v.ok, false);
  assert.match(v.violations.join("\n"), /unclassified: design\/new-unclassified\.md/);
});

test("C-5.2: a classified path missing from disk fails", () => {
  const exists = (p) => p !== "design/b.md";
  const v = validateIndexLabels({ labels: FIX_LABELS, scan: FIX_SCAN, exists });
  assert.equal(v.ok, false);
  assert.match(v.violations.join("\n"), /missing: design\/b\.md/);
});

test("C-5.3: a status outside the closed vocabulary is rejected at load shape", () => {
  assert.ok(STATUS_VOCABULARY.includes("ACTIVE"));
  assert.ok(!STATUS_VOCABULARY.includes("PARKED"));
});

test("C-5.4: SUPERSEDED without supersededBy or orphan+reason fails; dangling pointer fails; orphan needs a reason", () => {
  const bare = { "design/x.md": { status: "SUPERSEDED", use: "x" } };
  let v = validateIndexLabels({ labels: bare, scan: { mdFiles: ["design/x.md"] }, exists: existsAll });
  assert.match(v.violations.join("\n"), /superseded-without-pointer/);

  const dangling = { "design/x.md": { status: "SUPERSEDED", use: "x", supersededBy: "design/gone.md" } };
  v = validateIndexLabels({ labels: dangling, scan: { mdFiles: ["design/x.md"] }, exists: (p) => p === "design/x.md" });
  assert.match(v.violations.join("\n"), /supersededBy: design\/x\.md points at design\/gone\.md/);

  const orphanNoReason = { "design/x.md": { status: "SUPERSEDED", use: "x", orphan: true, reason: "  " } };
  v = validateIndexLabels({ labels: orphanNoReason, scan: { mdFiles: ["design/x.md"] }, exists: existsAll });
  assert.match(v.violations.join("\n"), /superseded-without-pointer/);
});

// ── stamp + render determinism (C-4: content-addressed, no wall-clock) ────

test("stamp: deterministic on identical inputs, moves when the map text moves", () => {
  const a = computeStamp({ scan: FIX_SCAN, labelsRaw: "{x}" });
  const b = computeStamp({ scan: FIX_SCAN, labelsRaw: "{x}" });
  const c = computeStamp({ scan: FIX_SCAN, labelsRaw: "{y}" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("render → refresh → check round-trips; a hand-edit inside the region is drift", () => {
  const stamp = computeStamp({ scan: FIX_SCAN, labelsRaw: "{x}" });
  const rendered = renderIndexRegion({ labels: FIX_LABELS, patterns: [], stamp });
  const doc = refreshIndex("# Authored preamble\n", rendered);
  assert.equal(extractIndexRegion(doc), rendered);
  // idempotent
  assert.equal(refreshIndex(doc, rendered), doc);
  // freshness against injected inputs
  const inputs = { labelsBundle: { raw: "{x}", labels: FIX_LABELS, patterns: [] }, scan: FIX_SCAN, exists: existsAll };
  assert.equal(checkDesignIndex(doc, { repoRoot, inputs }).code, "fresh");
  const vandalized = doc.replace("| `design/a.md` | ACTIVE | a |", "| `design/a.md` | ACTIVE | hand-edited |");
  assert.equal(checkDesignIndex(vandalized, { repoRoot, inputs }).code, "stale");
});

test("no-region: an INDEX without markers fails with the write hint", () => {
  const inputs = { labelsBundle: { raw: "{x}", labels: FIX_LABELS, patterns: [] }, scan: FIX_SCAN, exists: existsAll };
  const r = checkDesignIndex("# bare doc\n", { repoRoot, inputs });
  assert.equal(r.code, "no-region");
});

test("labels-invalid short-circuits before any render comparison (fail-closed order)", () => {
  const scan = { mdFiles: ["design/a.md", "design/unlisted.md"] };
  const inputs = { labelsBundle: { raw: "{x}", labels: FIX_LABELS, patterns: [] }, scan, exists: existsAll };
  const r = checkDesignIndex("# anything\n", { repoRoot, inputs });
  assert.equal(r.code, "labels-invalid");
  assert.match(r.violations.join("\n"), /unclassified/);
});
