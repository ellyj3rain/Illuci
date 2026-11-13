// node:test - the message-blind semantic change-class gate (ceiling).
// One representative diff per class, plus the halt-don't-default (UNRESOLVED) path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChange } from "./semantic.js";

// ---- DOCTRINE: explicit invariant implementer, dominant. ----

test("PATCH: downstream constitutional mirror paths are not doctrine by location", () => {
  const r = classifyChange({
    path: "constitutional/01-dual-harness-architecture.md",
    oldContent: "# Dual Harness\nold prose\n",
    newContent: "# Dual Harness\nrevised prose\n",
  });
  assert.equal(r.class, "PATCH");
  assert.ok(/constitutional\//.test(r.evidence));
  assert.ok(/downstream/.test(r.evidence));
});

test("DOCTRINE: a path listed in the invariant-implementer manifest is doctrine", () => {
  const r = classifyChange({
    path: "illuci/core/identity/surface.js",
    oldContent: "export const a = 1;\n",
    newContent: "export const a = 2;\n",
    manifest: { paths: ["illuci/core/identity/surface.js"] },
  });
  assert.equal(r.class, "DOCTRINE");
  assert.ok(/manifest/.test(r.evidence));
});

test("DOCTRINE: a manifest-listed constitutional mirror path is explicitly promoted", () => {
  const r = classifyChange({
    path: "constitutional/CONSTITUTION.md",
    oldContent: "rule one\nrule two\n",
    newContent: "rule one\n\n   rule two\n",
    manifest: ["constitutional/CONSTITUTION.md"],
  });
  assert.equal(r.class, "DOCTRINE");
  assert.ok(/manifest/.test(r.evidence));
});

test("COSMETIC: whitespace-only constitutional mirror edits stay low unless manifest-promoted", () => {
  const r = classifyChange({
    path: "constitutional/02-operator-mediated-execution.md",
    oldContent: "rule one\nrule two\n",
    newContent: "rule one\n\n   rule two\n",
  });
  assert.equal(r.class, "COSMETIC");
});

// ---- MINOR: additive. ----

test("MINOR: a brand-new file (no prior content) is additive", () => {
  const r = classifyChange({
    path: "illuci/core/foo/new-thing.js",
    oldContent: "",
    newContent: "export function newThing() { return 1; }\n",
  });
  assert.equal(r.class, "MINOR");
  assert.ok(/additive/.test(r.evidence));
});

test("KOHAI: a new repository automation file is structural scaffolding", () => {
  const r = classifyChange({
    path: ".github/workflows/cd-dry-run.yml",
    oldContent: "",
    newContent: "name: cd-dry-run\n",
  });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

test("KOHAI: a new governance automation file is structural maturity", () => {
  const r = classifyChange({
    path: "core/governance/gitops/new-classifier.js",
    oldContent: "",
    newContent: "export function classify() { return true; }\n",
  });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

test("KOHAI: a new governance classifier contract is structural maturity", () => {
  const r = classifyChange({
    path: "core/governance/classifiers/cognitive-classifier.js",
    oldContent: "",
    newContent: "export function buildCognitiveClassification() { return true; }\n",
  });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

test("KOHAI: a new repository metadata config file is structural maturity", () => {
  const r = classifyChange({
    path: ".npmrc",
    oldContent: "",
    newContent: "cache=.illuci/cache/npm\n",
  });
  assert.equal(r.class, "KOHAI");
  assert.ok(/metadata\/config/.test(r.evidence));
});

test("PATCH: a nested Dockerfile remains repository metadata", () => {
  const r = classifyChange({
    path: "core/infrastructure/Dockerfile",
    oldContent: "FROM node:22\nCMD [\"node\", \"cli/illuci.mjs\"]\n",
    newContent: "FROM node:22\nCMD [\"node\", \"cli/illuci.mjs\", \"--help\"]\n",
  });
  assert.equal(r.class, "PATCH");
  assert.ok(/metadata\/config/.test(r.evidence));
});

test("KOHAI: a new dependency depot chunk is install closure, not API growth", () => {
  const r = classifyChange({
    path: "vendor/npm-cache/packages/openai-codex-0.141.0-linux-x64.tgz.part00",
    oldContent: "",
    newContent: "binary chunk placeholder",
  });
  assert.equal(r.class, "KOHAI");
  assert.ok(/dependency depot/.test(r.evidence));
});

test("PATCH: a new test companion does not drive runtime/API version class", () => {
  const r = classifyChange({
    path: "core/topologies/runner.cognitive-classifier.test.js",
    oldContent: "",
    newContent: "import { test } from \"node:test\";\ntest(\"x\", () => {});\n",
  });
  assert.equal(r.class, "PATCH");
  assert.ok(/test companion/.test(r.evidence));
});

test("MINOR: a new exported symbol added with nothing removed is additive", () => {
  const oldContent = "export function a() {}\n";
  const newContent = "export function a() {}\nexport function b() {}\n";
  const r = classifyChange({ path: "illuci/core/foo/api.js", oldContent, newContent });
  assert.equal(r.class, "MINOR");
  assert.ok(/b/.test(r.evidence));
});

test("KOHAI: a new governance automation export is not a public minor by itself", () => {
  const oldContent = "export function a() {}\n";
  const newContent = "export function a() {}\nexport function b() {}\n";
  const r = classifyChange({ path: ".github/scripts/collect-pr-outcome.mjs", oldContent, newContent });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

test("KOHAI: an exact governance instrumentation export is not public API growth", () => {
  const oldContent = "export async function runTopology() {}\n";
  const newContent = "export async function runTopology() {}\nexport async function buildCognitiveSeatFrame() {}\n";
  const r = classifyChange({ path: "core/topologies/runner.js", oldContent, newContent });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

// ---- PATCH: in-place, no interface removal. ----

test("PATCH: in-place modification with the same export set", () => {
  const oldContent = "export function add(a, b) { return a - b; }\n"; // bug
  const newContent = "export function add(a, b) { return a + b; }\n"; // fix
  const r = classifyChange({ path: "illuci/core/foo/math.js", oldContent, newContent });
  assert.equal(r.class, "PATCH");
  assert.ok(/no change to the exported interface/.test(r.evidence));
});

test("KOHAI: in-place ceiling policy changes are maturity movement", () => {
  const oldContent = "export function classifyChange() { return { class: \"PATCH\" }; }\n";
  const newContent = "export function classifyChange() { return { class: \"KOHAI\" }; }\n";
  const r = classifyChange({ path: "core/governance/authortime/ceiling/semantic.js", oldContent, newContent });
  assert.equal(r.class, "KOHAI");
  assert.ok(/structural maturity/.test(r.evidence));
});

// ---- CONTRACT: a removed export is a consumer-visible break. ----

test("CONTRACT: removing an exported symbol is a contract break", () => {
  const oldContent = "export function a() {}\nexport function b() {}\n";
  const newContent = "export function a() {}\n"; // b removed
  const r = classifyChange({ path: "illuci/core/foo/api.js", oldContent, newContent });
  assert.equal(r.class, "CONTRACT");
  assert.ok(/b/.test(r.evidence));
});

test("CONTRACT: deleting a source file with exports removes its interface", () => {
  const r = classifyChange({
    path: "illuci/core/foo/api.js",
    oldContent: "export function a() {}\n",
    newContent: "",
  });
  assert.equal(r.class, "CONTRACT");
});

test("MINOR: deleting an explicitly retired empty file remains governed cleanup", () => {
  const r = classifyChange({
    path: "design/empty-bloat.txt",
    oldContent: "",
    newContent: "",
    status: "deleted",
    retirement: { status: "retired", decision: "DR-056" },
  });
  assert.equal(r.class, "MINOR");
  assert.match(r.evidence, /explicitly retired surface/);
});

test("PATCH: deleting a repository automation workflow is config cleanup", () => {
  const r = classifyChange({
    path: ".github/workflows/ci.yml",
    oldContent: "name: old ci\n",
    newContent: "",
  });
  assert.equal(r.class, "PATCH");
  assert.ok(/workflow-shape tests/.test(r.evidence));
});
test("PATCH: governance JSON metadata paths classify as PATCH", () => {
  for (const path of [
    "core/governance/authortime/invariant-manifest.json",
    "core/governance/authortime/surface-retirements.json",
    "core/governance/compiler/output/governance.gir.json",
  ]) {
    const r = classifyChange({
      path,
      oldContent: "{\"old\":true}\n",
      newContent: "{\"new\":true}\n",
    });
    assert.equal(r.class, "PATCH", path);
    assert.ok(/metadata\/config/.test(r.evidence));
  }
});

test("PATCH: skill registry metadata manifests classify as source-owned metadata", () => {
  const r = classifyChange({
    path: "core/skills/registry-data/skills/security-audit/skill.json",
    oldContent: "{\"description\":\"old\"}\n",
    newContent: "{\"description\":\"new\"}\n",
  });
  assert.equal(r.class, "PATCH");
  assert.ok(/metadata\/config/.test(r.evidence));
});
// ---- COSMETIC: whitespace / comments / formatting only. ----

test("COSMETIC: only whitespace and comments changed", () => {
  const oldContent = "export function a(){return 1;}\n";
  const newContent = "// a returns one\nexport function a() {\n  return 1;\n}\n";
  const r = classifyChange({ path: "illuci/core/foo/a.js", oldContent, newContent });
  assert.equal(r.class, "COSMETIC");
});

test("COSMETIC: CRLF<->LF + reindent is not a heavier class", () => {
  const oldContent = "export const x = 1;\r\nexport const y = 2;\r\n";
  const newContent = "export const x = 1;\n    export const y = 2;\n";
  const r = classifyChange({ path: "illuci/core/foo/c.js", oldContent, newContent });
  assert.equal(r.class, "COSMETIC");
});

// ---- UNRESOLVED: halt, do not default to PATCH. ----

test("UNRESOLVED: a non-source file with a substantive (non-formatting) change", () => {
  // Ambiguous: prose/config edit, message-blind, cannot be weighed -> route to operator.
  const r = classifyChange({
    path: "claude/guide/walkthrough.md",
    oldContent: "Step one: do the thing.\n",
    newContent: "Step one: do the OTHER thing entirely.\n",
  });
  assert.equal(r.class, "UNRESOLVED");
  assert.ok(/operator/.test(r.evidence));
});

test("PATCH: a known markdown HEADING rewrite is release documentation, not cosmetic", () => {
  // The bug: stripFormatting treated '#'-prefixed lines as comments, so '# Old Title' and
  // '# New Title' equalized -> COSMETIC. For known release docs, a heading change is
  // substantive release documentation and should classify as PATCH, never COSMETIC.
  const r = classifyChange({
    path: "ARCHITECTURE.md",
    oldContent: "# Old Title\n\nbody stays the same\n",
    newContent: "# New Title\n\nbody stays the same\n",
  });
  assert.notEqual(r.class, "COSMETIC");
  assert.equal(r.class, "PATCH");
  assert.ok(/documentation artifact/.test(r.evidence));
});

test("PATCH: design markdown archive edits are known documentation", () => {
  const r = classifyChange({
    path: "design/forge-posture.md",
    oldContent: "# Forge Topology\n\nold routing prose\n",
    newContent: "# Forge Topology\n\nupdated routing prose\n",
  });
  assert.notEqual(r.class, "COSMETIC");
  assert.equal(r.class, "PATCH");
  assert.ok(/documentation artifact/.test(r.evidence));
});

test("PATCH: a known ROADMAP heading year-bump is NOT cosmetic", () => {
  const r = classifyChange({
    path: "ROADMAP.md",
    oldContent: "# 2024 goals\n- ship\n",
    newContent: "# 2025 goals\n- ship\n",
  });
  assert.notEqual(r.class, "COSMETIC");
  assert.equal(r.class, "PATCH");
});

test("COSMETIC still holds for markdown when ONLY whitespace changes (no heading edit)", () => {
  // The fix must not over-correct: a pure reformatting of a .md (same headings, same prose,
  // only blank-line / trailing-space changes) is still legitimately COSMETIC.
  const r = classifyChange({
    path: "GUIDE.md",
    oldContent: "# Title\n\nsome prose here\n",
    newContent: "# Title\n\n\nsome prose here   \n",
  });
  assert.equal(r.class, "COSMETIC");
});

test("'#' is STILL stripped as a comment for non-markdown (shell/source) files", () => {
  // The gate is on the .md/.markdown extension only - elsewhere a leading '#' is a comment and
  // adding/removing one is cosmetic. A .sh whose only delta is an added '# comment' line stays
  // COSMETIC (a non-source path, so it would otherwise route to UNRESOLVED).
  const r = classifyChange({
    path: "scripts/deploy.sh",
    oldContent: "echo hello\n",
    newContent: "# explain the echo\necho hello\n",
  });
  assert.equal(r.class, "COSMETIC");
});

test("UNRESOLVED: missing path cannot be classified (never defaults)", () => {
  const r = classifyChange({ oldContent: "a", newContent: "b" });
  assert.equal(r.class, "UNRESOLVED");
  assert.notEqual(r.class, "PATCH");
});

test("UNRESOLVED: unchanged content has no diff to classify (never defaults)", () => {
  const r = classifyChange({
    path: "illuci/core/foo/a.js",
    oldContent: "export const a = 1;\n",
    newContent: "export const a = 1;\n",
  });
  assert.equal(r.class, "UNRESOLVED");
});

// ---- Shape + determinism. ----

test("returns the {class, confidence, evidence} shape with a numeric confidence", () => {
  const r = classifyChange({ path: "x.js", oldContent: "", newContent: "export const a=1;\n" });
  assert.ok(["COSMETIC", "PATCH", "KOHAI", "MINOR", "CONTRACT", "DOCTRINE", "UNRESOLVED"].includes(r.class));
  assert.equal(typeof r.confidence, "number");
  assert.equal(typeof r.evidence, "string");
});

test("deterministic: same input yields the same verdict", () => {
  const input = {
    path: "illuci/core/foo/api.js",
    oldContent: "export function a() {}\nexport function b() {}\n",
    newContent: "export function a() {}\n",
  };
  assert.deepEqual(classifyChange(input), classifyChange(input));
});

test("manifest accepts a bare array form too", () => {
  const r = classifyChange({
    path: "illuci/core/identity/surface.js",
    oldContent: "export const a=1;\n",
    newContent: "export const a=2;\n",
    manifest: ["illuci/core/identity/surface.js"],
  });
  assert.equal(r.class, "DOCTRINE");
});

test("windows separators in the path normalize for manifest detection", () => {
  const r = classifyChange({
    path: "constitutional\\03-thing.md",
    oldContent: "a\n",
    newContent: "b changed\n",
    manifest: ["constitutional/03-thing.md"],
  });
  assert.equal(r.class, "DOCTRINE");
});
