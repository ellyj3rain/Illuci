import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernanceTarget, targetIsBlocked } from "./target.js";

test("resolveGovernanceTarget defaults to cwd and recognizes VERSION governance", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-target-default-"));
  try {
    writeFileSync(join(dir, "VERSION"), "1.0.0\n");
    const target = resolveGovernanceTarget(null, { cwd: dir });
    assert.equal(target.mode, "default-current");
    assert.equal(target.repoRoot, dir);
    assert.equal(target.markers.versionFile, true);
    assert.equal(target.governed, true);
    assert.equal(targetIsBlocked(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGovernanceTarget resolves explicit targets relative to cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-target-root-"));
  const child = join(root, "child");
  try {
    mkdirSync(child);
    writeFileSync(join(child, "VERSION"), "1.0.0\n");
    const target = resolveGovernanceTarget("child", { cwd: root });
    assert.equal(target.mode, "explicit");
    assert.equal(target.requestedPath, "child");
    assert.equal(target.repoRoot, child);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGovernanceTarget blocks a missing target path", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-target-missing-"));
  try {
    const target = resolveGovernanceTarget("missing", { cwd: dir });
    assert.equal(target.exists, false);
    assert.equal(targetIsBlocked(target), true);
    assert.ok(target.findings.some((finding) => finding.code === "target-missing"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
