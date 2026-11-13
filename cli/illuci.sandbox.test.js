import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

function makeFixture(t) {
  const isolatedTmp = mkdtempSync(join(tmpdir(), "illuci-sandbox-cli-test-"));
  const root = join(isolatedTmp, "illuci-cli-lane-sandbox");
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(isolatedTmp, { recursive: true, force: true }));

  // The CLI has no root override. Its child process receives an isolated OS
  // temp directory, so defaultCliSandboxRoot() resolves inside this fixture.
  const env = {
    ...process.env,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
  };

  return {
    isolatedTmp,
    root,
    run(args) {
      return spawnSync(process.execPath, [cliPath, ...args], {
        encoding: "utf8",
        env,
        windowsHide: true,
      });
    },
  };
}

function setAge(path, hours) {
  const timestamp = new Date(Date.now() - hours * 60 * 60 * 1000);
  utimesSync(path, timestamp, timestamp);
}

function readSingleJson(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "JSON mode must emit exactly one stdout line");
  return JSON.parse(lines[0]);
}

test("sandbox requires the sweep subverb", (t) => {
  const { run } = makeFixture(t);

  for (const args of [["sandbox"], ["sandbox", "unknown"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage: illuci sandbox <sweep> \.\.\./);
  }
});

test("sandbox sweep rejects invalid and unsupported options", (t) => {
  const { isolatedTmp, run } = makeFixture(t);

  for (const value of ["nonsense", "0", "-1", "NaN", "Infinity"]) {
    const result = run([
      "sandbox",
      "sweep",
      "--older-than-hours",
      value,
      "--json",
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /--older-than-hours requires a finite number greater than 0/,
    );
  }

  const rootOverride = run([
    "sandbox",
    "sweep",
    "--root",
    join(isolatedTmp, "decoy"),
    "--json",
  ]);
  assert.equal(rootOverride.status, 1);
  assert.equal(rootOverride.stdout, "");
  assert.match(rootOverride.stderr, /unknown option: --root/);
  assert.equal(existsSync(join(isolatedTmp, "decoy")), false);
});

test("sandbox sweep is hermetic, age-aware, dry-runnable, and stdout-pure", (t) => {
  const { root, run } = makeFixture(t);
  const expiredDefault = join(root, "expired-default");
  const overrideCandidate = join(root, "override-candidate");
  const fresh = join(root, "fresh");
  const retainedFile = join(root, "retained.txt");

  mkdirSync(expiredDefault);
  mkdirSync(overrideCandidate);
  mkdirSync(fresh);
  writeFileSync(retainedFile, "keep");
  setAge(expiredDefault, 25);
  setAge(overrideCandidate, 2);
  setAge(retainedFile, 72);

  const preflight = readSingleJson(
    run(["sandbox", "sweep", "--dry-run", "--json"]),
  );
  assert.deepEqual(Object.keys(preflight), [
    "schema",
    "root",
    "olderThanMs",
    "dryRun",
    "swept",
    "kept",
    "errors",
  ]);
  assert.equal(preflight.schema, "illuci.cli.sandbox-sweep/1");
  assert.equal(resolve(preflight.root), resolve(root));
  assert.equal(preflight.olderThanMs, DAY_MS);
  assert.equal(preflight.dryRun, true);
  assert.deepEqual(preflight.errors, []);
  assert.ok(preflight.swept.includes("expired-default"));
  assert.ok(preflight.kept.includes("override-candidate"));
  assert.ok(preflight.kept.includes("retained.txt"));
  assert.ok(existsSync(expiredDefault), "dry-run must not delete candidates");

  const defaultSweep = readSingleJson(
    run(["sandbox", "sweep", "--json"]),
  );
  assert.equal(defaultSweep.olderThanMs, DAY_MS);
  assert.equal(defaultSweep.dryRun, false);
  assert.deepEqual(defaultSweep.errors, []);
  assert.ok(!existsSync(expiredDefault));
  assert.ok(existsSync(overrideCandidate));
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(retainedFile));

  const overrideDryRun = readSingleJson(
    run([
      "sandbox",
      "sweep",
      "--older-than-hours",
      "1",
      "--dry-run",
      "--json",
    ]),
  );
  assert.equal(overrideDryRun.olderThanMs, 60 * 60 * 1000);
  assert.equal(overrideDryRun.dryRun, true);
  assert.ok(overrideDryRun.swept.includes("override-candidate"));
  assert.ok(existsSync(overrideCandidate));

  const overrideSweep = readSingleJson(
    run([
      "sandbox",
      "sweep",
      "--older-than-hours",
      "1",
      "--json",
    ]),
  );
  assert.equal(overrideSweep.olderThanMs, 60 * 60 * 1000);
  assert.deepEqual(overrideSweep.errors, []);
  assert.ok(!existsSync(overrideCandidate));
  assert.ok(existsSync(fresh));
  assert.ok(existsSync(retainedFile));

  const human = run(["sandbox", "sweep", "--dry-run"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(
    human.stdout,
    /^Sandbox sweep \(dry run\): \d+ swept, \d+ kept, 0 errors\.\r?\n$/,
  );
  assert.equal(human.stderr, "");
});

test("sandbox sweep exits 1 when an entry cannot be deleted (errors channel)", async (t) => {
  const { root, run } = makeFixture(t);
  const locked = join(root, "locked-dispatch");
  mkdirSync(locked);
  writeFileSync(join(locked, "held.txt"), "busy");
  setAge(locked, 48);

  // Two lock mechanisms, one per platform semantic: Windows refuses to delete
  // a directory that is some process's cwd; POSIX (non-root) refuses to unlink
  // inside a write-denied directory. Root (CI containers) bypasses both — the
  // probe below skips honestly where an undeletable entry cannot be simulated.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: locked,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolveSpawn) => holder.once("spawn", resolveSpawn));
  chmodSync(locked, 0o555);

  let result;
  try {
    result = run(["sandbox", "sweep", "--json"]);
  } finally {
    // release both locks BEFORE the fixture's own rmSync teardown runs;
    // where locks don't hold (root container) the dir is already gone
    try { chmodSync(locked, 0o755); } catch {}
    holder.kill();
    await new Promise((resolveExit) => holder.once("exit", resolveExit));
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(lines.length, 1, "JSON mode stays stdout-pure even with errors");
  const payload = JSON.parse(lines[0]);

  if (payload.errors.length === 0 && !existsSync(locked)) {
    // The platform deleted it anyway (e.g. root in a container: CAP_DAC_OVERRIDE
    // ignores the chmod lock; POSIX allows removing a process's cwd).
    t.skip("platform cannot simulate an undeletable entry");
    return;
  }

  assert.equal(result.status, 1, "errors present must exit 1");
  assert.ok(payload.errors.length >= 1);
  assert.equal(payload.errors[0].name, "locked-dispatch");
  assert.ok(existsSync(join(locked, "held.txt")), "locked victim must survive");
});
