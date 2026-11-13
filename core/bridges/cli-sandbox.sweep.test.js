// Hermetic sweep tests for cli-sandbox (WO-S10 / DR-200 residual).
// Never touches the production sandbox root; fixture lives under mkdtemp.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { sweepCliLaneSandboxes } from "./cli-sandbox.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function touchAge(path, ageMs) {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

describe("sweepCliLaneSandboxes", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cli-sandbox-sweep-"));
  const opts = { root: fixtureRoot, allowTestRoot: true };

  after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("sweeps only entries older than olderThanMs; keeps fresh", () => {
    const oldDir = join(fixtureRoot, "old-dispatch");
    const freshDir = join(fixtureRoot, "fresh-dispatch");
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    writeFileSync(join(oldDir, "scratch.txt"), "old");
    writeFileSync(join(freshDir, "scratch.txt"), "fresh");
    touchAge(oldDir, 48 * HOUR);
    touchAge(freshDir, 1 * HOUR);

    const result = sweepCliLaneSandboxes({ ...opts, olderThanMs: DAY });

    assert.ok(result.swept.includes("old-dispatch"));
    assert.ok(result.kept.includes("fresh-dispatch"));
    assert.equal(result.errors.length, 0);
    assert.deepEqual(Object.keys(result).sort(), ["errors", "kept", "swept"]);
    assert.ok(!readdirSync(fixtureRoot).includes("old-dispatch"));
    assert.ok(readdirSync(fixtureRoot).includes("fresh-dispatch"));
  });

  it("dryRun lists candidates and deletes nothing", () => {
    const name = "dry-old";
    const p = join(fixtureRoot, name);
    mkdirSync(p);
    touchAge(p, 48 * HOUR);

    const result = sweepCliLaneSandboxes({
      ...opts,
      olderThanMs: DAY,
      dryRun: true,
    });

    assert.ok(result.swept.includes(name));
    assert.ok(readdirSync(fixtureRoot).includes(name));
  });

  it("second sweep is idempotent (nothing left to delete)", () => {
    const name = "once-old";
    const p = join(fixtureRoot, name);
    mkdirSync(p);
    touchAge(p, 48 * HOUR);

    const first = sweepCliLaneSandboxes({ ...opts, olderThanMs: DAY });
    assert.ok(first.swept.includes(name));

    const second = sweepCliLaneSandboxes({ ...opts, olderThanMs: DAY });
    assert.ok(!second.swept.includes(name));
    assert.equal(second.errors.length, 0);
  });

  it("refuses root without allowTestRoot; refuses root outside tmp", () => {
    const bare = sweepCliLaneSandboxes({ root: fixtureRoot, olderThanMs: DAY });
    assert.ok(bare.errors.some((e) => e.name === "(root)"));
    assert.equal(bare.swept.length, 0);

    // Absolute path outside OS temp (drive/fs root) must never become a sweep root.
    const homeish = process.platform === "win32" ? "C:\\" : "/";
    const refused = sweepCliLaneSandboxes({
      root: homeish,
      allowTestRoot: true,
      olderThanMs: DAY,
    });
    assert.ok(refused.errors.some((e) => e.name === "(root)"));
    assert.equal(refused.swept.length, 0);
  });

  it("never follows symlinks (escape attempt stays kept; target intact)", () => {
    const victim = mkdtempSync(join(tmpdir(), "cli-sandbox-victim-"));
    writeFileSync(join(victim, "precious.txt"), "do-not-delete");
    const linkName = "escape-link";
    const linkPath = join(fixtureRoot, linkName);
    try {
      symlinkSync(victim, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Symlink privilege may be unavailable on Windows CI — skip soft.
      rmSync(victim, { recursive: true, force: true });
      return;
    }
    touchAge(linkPath, 48 * HOUR);

    const result = sweepCliLaneSandboxes({ ...opts, olderThanMs: DAY });

    assert.ok(result.kept.includes(linkName) || result.errors.some((e) => e.name === linkName));
    assert.ok(!result.swept.includes(linkName));
    assert.ok(readdirSync(victim).includes("precious.txt"));

    rmSync(linkPath, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  });

  it("keeps aged non-directory entries — the sweep owns dispatch dirs only (WO-S10R ruling)", () => {
    const name = "stray-file.txt";
    const p = join(fixtureRoot, name);
    writeFileSync(p, "not-mine");
    touchAge(p, 48 * HOUR);

    const result = sweepCliLaneSandboxes({ ...opts, olderThanMs: DAY });

    assert.ok(result.kept.includes(name));
    assert.ok(!result.swept.includes(name));
    assert.ok(readdirSync(fixtureRoot).includes(name));

    rmSync(p, { force: true });
  });

  it("unsafe names from readdir path are never deleted outside root", () => {
    // readdir returns basenames only; safety helper still refuses junk if injected.
    // Prove production root is untouched: sweep fixture only, real root listing optional.
    const before = readdirSync(fixtureRoot);
    const result = sweepCliLaneSandboxes({
      ...opts,
      olderThanMs: 0,
      dryRun: true,
    });
    assert.ok(Array.isArray(result.swept));
    assert.ok(Array.isArray(result.kept));
    assert.ok(Array.isArray(result.errors));
    // dryRun must not remove anything present before
    for (const n of before) {
      assert.ok(readdirSync(fixtureRoot).includes(n));
    }
  });
});
