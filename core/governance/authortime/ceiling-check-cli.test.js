import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = process.env.ILLUCI_CEILING_CLI_TEST_PATH || fileURLToPath(new URL("./ceiling-check-cli.mjs", import.meta.url));
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "illuci-ceiling-scope-cli-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "existing.js"), "export function value(){ return 1; }\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "core.hooksPath=", "commit", "-qm", "fixture"], { cwd: dir });
    run(dir);
  } finally {
    assert.equal(resolve(dir, ".."), resolve(tmpdir()), "recursive cleanup stays in the created fixture directory");
    rmSync(dir, { recursive: true, force: true });
  }
}
function cli(dir, args = [], explicitRoot = true) {
  const result = spawnSync(process.execPath, [CLI, ...(explicitRoot ? [dir] : []), "--working", ...args],
    { cwd: dir, encoding: "utf8", shell: false });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const scope = (kind) => JSON.stringify({ kind, evidence: "owning feature record and closure evidence" });

test("ceiling CLI scope JSON guides existing-file work without new exports", () => fixture((dir) => {
  writeFileSync(join(dir, "core", "existing.js"), "export function value(){ return 2; }\n");
  assert.match(cli(dir, ["--version-scope", scope("increment")]), /version action = kohai/);
  assert.match(cli(dir, ["--version-scope", scope("completed-feature")]), /version action = minor/);
  assert.match(cli(dir, ["--version-scope=" + scope("completed-feature")]), /version action = minor/);
}));

test("ceiling CLI forwards evidenced scope through real gathered API growth", () => fixture((dir) => {
  writeFileSync(join(dir, "core", "new.js"), "export const added = 1;\n");
  const omitted = cli(dir);
  assert.match(omitted, /version action = scope-assessment-required/);
  assert.match(omitted, /warn: version-scope/);
  assert.match(cli(dir, ["--version-scope", scope("increment")], false), /version action = kohai/);
  const completed = cli(dir, ["--version-scope", scope("completed-feature")], false);
  assert.match(completed, /version action = minor/);
  assert.doesNotMatch(completed, /warn: version-scope/);
}));

test("ceiling CLI malformed optional scope is explicit advisory error without completion", () => fixture((dir) => {
  writeFileSync(join(dir, "core", "new.js"), "export const added = 1;\n");
  for (const value of ["{", "null", "[]", '{"kind":"completed-feature"}',
    '{"kind":"completed-feature","evidence":" "}', '{"kind":"increment","evidence":[]}',
    '{"kind":"unknown","evidence":"record"}', '{"kind":"completed-feature","evidence":"record","extra":true}']) {
    const output = cli(dir, ["--version-scope", value]);
    assert.match(output, /Invalid --version-scope/);
    assert.match(output, /version action = scope-assessment-required/);
    assert.doesNotMatch(output, /version action = minor\b/);
  }
  assert.match(cli(dir, ["--version-scope"]), /JSON scope argument is missing/);
  assert.match(cli(dir, ["--version-scope", scope("completed-feature"), "--version-scope", scope("increment")]), /provide one JSON scope argument/);
}));

test("ceiling CLI evidenced scope preserves cosmetic advice and epoch gates", () => fixture((dir) => {
  assert.match(cli(dir, ["--version-scope", scope("completed-feature")]), /version action = none/);
  writeFileSync(join(dir, "core", "existing.js"), "const removed = 1;\n");
  assert.match(cli(dir, ["--version-scope", scope("increment")]), /version action = scope-assessment-required/);
  assert.match(cli(dir, ["--version-scope", scope("completed-feature")]), /version action = scope-assessment-required/);
}));
