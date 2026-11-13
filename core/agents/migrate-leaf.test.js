import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateLeaf } from "./migrate-leaf.js";
import { migrateProject } from "./migrate-project.js";
import { migrateHome } from "./migrate-home.js";

const freshRoot = () => mkdtempSync(join(tmpdir(), "illuci-mig-"));

test("nothing-to-migrate when src absent", () => {
  const root = freshRoot();
  try {
    const r = migrateLeaf(join(root, ".neocli"), join(root, ".illuci"));
    assert.equal(r.status, "nothing-to-migrate");
    assert.equal(existsSync(join(root, ".illuci")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty-source: only empty dirs, no files -> no delete", () => {
  const root = freshRoot();
  try {
    const src = join(root, ".neocli");
    mkdirSync(join(src, "sub"), { recursive: true });
    const r = migrateLeaf(src, join(root, ".illuci"));
    assert.equal(r.status, "empty-source");
    assert.equal(existsSync(src), true, "source left intact");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dry-run: plans, writes nothing, leaves src", () => {
  const root = freshRoot();
  try {
    const src = join(root, ".neocli");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "project.json"), '{"a":1}');
    const r = migrateLeaf(src, join(root, ".illuci"));
    assert.equal(r.status, "dry-run");
    assert.equal(r.fileCount, 1);
    assert.equal(existsSync(join(root, ".illuci")), false, "dst not created");
    assert.equal(existsSync(join(src, "project.json")), true, "src intact");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refused: destination not empty -> src intact, dst untouched", () => {
  const root = freshRoot();
  try {
    const src = join(root, ".neocli");
    const dst = join(root, ".illuci");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "f"), "x");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "existing"), "keep");
    const r = migrateLeaf(src, dst, { apply: true });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "destination-not-empty");
    assert.equal(existsSync(join(src, "f")), true, "src intact on refuse");
    assert.equal(readFileSync(join(dst, "existing"), "utf8"), "keep");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrated: nested files copied + verified, empty dirs preserved, src deleted", () => {
  const root = freshRoot();
  try {
    const src = join(root, ".neocli");
    const dst = join(root, ".illuci");
    mkdirSync(join(src, "sessions"), { recursive: true });
    mkdirSync(join(src, "memory", "personas"), { recursive: true });
    mkdirSync(join(src, "empty-dir"), { recursive: true });
    writeFileSync(join(src, "project.json"), '{"id":"p"}');
    writeFileSync(join(src, "sessions", "s1.json"), "session-1");
    writeFileSync(join(src, "memory", "personas", "warden.jsonl"), "line1\nline2\n");
    const r = migrateLeaf(src, dst, { apply: true });
    assert.equal(r.status, "migrated");
    assert.equal(r.verified, true);
    assert.equal(r.deletedSource, true);
    assert.equal(existsSync(src), false, "src deleted after clean verify");
    assert.equal(readFileSync(join(dst, "project.json"), "utf8"), '{"id":"p"}');
    assert.equal(readFileSync(join(dst, "sessions", "s1.json"), "utf8"), "session-1");
    assert.equal(readFileSync(join(dst, "memory", "personas", "warden.jsonl"), "utf8"), "line1\nline2\n");
    assert.equal(existsSync(join(dst, "empty-dir")), true, "empty dir preserved");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refused: non-regular (symlink) entry leaves src intact [best-effort]", (t) => {
  const root = freshRoot();
  try {
    const src = join(root, ".neocli");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(root, "target.txt"), "t");
    try {
      symlinkSync(join(root, "target.txt"), join(src, "link"));
    } catch {
      t.skip("symlink creation unsupported here");
      return;
    }
    writeFileSync(join(src, "real.json"), "r");
    const r = migrateLeaf(src, join(root, ".illuci"), { apply: true });
    assert.equal(r.status, "refused");
    assert.equal(r.reason, "non-regular-entry");
    assert.equal(existsSync(join(src, "real.json")), true, "src intact on refuse");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrateProject wraps the core on <dir>/.neocli -> <dir>/.illuci", () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, ".neocli"), { recursive: true });
    writeFileSync(join(root, ".neocli", "project.json"), "{}");
    const r = migrateProject(root, { apply: true });
    assert.equal(r.status, "migrated");
    assert.equal(existsSync(join(root, ".illuci", "project.json")), true);
    assert.equal(existsSync(join(root, ".neocli")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrateProject requires a projectDir string", () => {
  assert.throws(() => migrateProject(undefined), /projectDir/);
});

test("migrateHome honors homeRoot override (test-only) on .neocli -> .illuci", () => {
  const root = freshRoot();
  try {
    mkdirSync(join(root, ".neocli", "agents"), { recursive: true });
    writeFileSync(join(root, ".neocli", "agents", "id.json"), '{"m":1}');
    const r = migrateHome({ apply: true, homeRoot: root });
    assert.equal(r.status, "migrated");
    assert.equal(readFileSync(join(root, ".illuci", "agents", "id.json"), "utf8"), '{"m":1}');
    assert.equal(existsSync(join(root, ".neocli")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
