// node:test - the invariant-implementation manifest + its completeness oracle.
// Pure detector/lookup tests run on literals; the tree-walk tests build a throwaway
// fixture repo under the OS temp dir so they don't depend on (or race) the live worktree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  detectInvariant,
  loadManifest,
  isInvariantImplementer,
  manifestedInvariantsOf,
  findUnmanifestedImplementers,
  MANIFEST_FILE,
} from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Build a minimal fixture repo. Copies the REAL seeded manifest into the right nested
// location so loadManifest resolves it, then lays down whatever extra files the test wants.
function makeFixture(extraFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "manifest-test-"));
  const maniDir = join(root, "illuci", "core", "governance", "authortime");
  mkdirSync(maniDir, { recursive: true });
  cpSync(join(HERE, MANIFEST_FILE), join(maniDir, MANIFEST_FILE));
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

// ---- detectInvariant (pure) ----

test("detectInvariant flags an odometer cap redefiner", () => {
  const src = `export const MINOR_HARD_CAP = 12;\nexport const KOHAI_HARD_CAP = 16;\nexport const PATCH_HARD_CAP = 24;\n`;
  assert.deepEqual(detectInvariant("illuci/core/governance/assess.js", src), ["odometer"]);
});

test("detectInvariant flags a file importing the odometer bump skill", () => {
  const src = `import bump from "../../odometer/bump.mjs";\n`;
  assert.deepEqual(detectInvariant("some/consumer.mjs", src), ["odometer"]);
});

test("detectInvariant does not flag downstream constitutional mirror paths by location", () => {
  assert.deepEqual(detectInvariant("constitutional/08-systematic-odometer-versioning.md"), []);
});

test("detectInvariant does NOT flag mere prose mentions of the cap name", () => {
  const src = `// the MINOR_HARD_CAP is 12, see assess.js\nconsole.log("KOHAI_HARD_CAP and PATCH_HARD_CAP discussion");\n`;
  assert.deepEqual(detectInvariant("docs/notes.js", src), []);
});

test("detectInvariant ignores a non-code, non-constitutional file", () => {
  assert.deepEqual(detectInvariant("README.md", "MINOR_HARD_CAP = 12 mention"), []);
});

// ---- loadManifest + isInvariantImplementer (against the real seed) ----

test("the real seed lists assess.js and bump.mjs as odometer implementers", () => {
  const root = makeFixture();
  try {
    const mani = loadManifest(root);
    assert.ok(mani.invariants.odometer, "odometer invariant present in seed");
    assert.equal(isInvariantImplementer("illuci/core/governance/assess.js", mani), true);
    assert.equal(
      isInvariantImplementer("claude/system/skills/artifact-standards/odometer/bump.mjs", mani),
      true,
    );
    assert.deepEqual(
      manifestedInvariantsOf("illuci/core/governance/assess.js", mani).sort(),
      ["odometer"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isInvariantImplementer normalizes backslash paths", () => {
  const root = makeFixture();
  try {
    const mani = loadManifest(root);
    assert.equal(
      isInvariantImplementer("illuci\\core\\governance\\assess.js", mani),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadManifest on a manifest-less root returns an empty manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "manifest-empty-"));
  try {
    const mani = loadManifest(root);
    assert.deepEqual(mani.invariants, {});
    assert.equal(isInvariantImplementer("anything.js", mani), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- findUnmanifestedImplementers (tree walk) ----

test("a clean fixture (only manifested implementers) surfaces nothing", () => {
  const root = makeFixture({
    "illuci/core/governance/assess.js": `export const MINOR_HARD_CAP = 12;\nexport const KOHAI_HARD_CAP = 16;\nexport const PATCH_HARD_CAP = 24;\n`,
    "claude/system/skills/artifact-standards/odometer/bump.mjs": `if (MINOR > 16) {}\n// odometer/bump.mjs self\n`,
    "constitutional/BILL_OF_STANDARDS.md": `# bill of standards\n`,
    "constitutional/CONSTITUTION.md": `# constitution\n`,
    "constitutional/README.md": `# readme\n`,
  });
  try {
    const found = findUnmanifestedImplementers(root);
    assert.deepEqual(found, [], `expected none, got ${JSON.stringify(found)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synthetic UN-LISTED cap redefiner surfaces via findUnmanifestedImplementers", () => {
  const root = makeFixture({
    "illuci/experimental/shadow-odometer.js": `export const MINOR_HARD_CAP = 12;\n// a second uncoordinated home for the cap\n`,
  });
  try {
    const found = findUnmanifestedImplementers(root);
    const rogue = found.find((f) => f.file === "illuci/experimental/shadow-odometer.js");
    assert.ok(rogue, `the rogue implementer should surface; got ${JSON.stringify(found)}`);
    assert.deepEqual(rogue.invariants, ["odometer"]);
    assert.deepEqual(rogue.missing, ["odometer"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a synthetic UN-LISTED constitutional mirror file does not surface as doctrine by location", () => {
  const root = makeFixture({
    "constitutional/11-new-doctrine.md": `# a brand new constitutional surface\n`,
  });
  try {
    const found = findUnmanifestedImplementers(root);
    assert.ok(!found.some((f) => f.file === "constitutional/11-new-doctrine.md"), `mirror context should not surface by path only; got ${JSON.stringify(found)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("implementers inside SCAN_IGNORE_DIRS (sandboxes / node_modules) are NOT counted", () => {
  const root = makeFixture({
    ".illuci-sandboxes/impl-x/illuci/core/governance/assess.js": `export const MINOR_HARD_CAP = 12;\n`,
    "node_modules/pkg/bump.mjs": `export const PATCH_HARD_CAP = 24;\n`,
  });
  try {
    const found = findUnmanifestedImplementers(root);
    assert.deepEqual(found, [], `ignored dirs must not surface; got ${JSON.stringify(found)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the manifest file itself is never reported as an implementer", () => {
  const root = makeFixture();
  try {
    const found = findUnmanifestedImplementers(root);
    assert.ok(!found.some((f) => f.file.endsWith(MANIFEST_FILE)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the LIVE worktree: the seed must be complete against its own tree ----

test("the live seed is complete: no unmanifested implementers in the real worktree", () => {
  // HERE = .../illuci/core/governance/authortime ; repo root is 4 levels up.
  const repoRoot = join(HERE, "..", "..", "..", "..");
  if (!existsSync(join(repoRoot, MANIFEST_FILE)) && !existsSync(join(repoRoot, "VERSION"))) {
    return; // not running inside the worktree; skip rather than false-fail
  }
  const found = findUnmanifestedImplementers(repoRoot);
  assert.deepEqual(
    found,
    [],
    `seed is stale - these implementers are unmanifested: ${JSON.stringify(found, null, 2)}`,
  );
});
