// core/bridges/tool-paths.fallback.test.js
//
// [A46]/F-088 (second half): the bare last-resort fallback in resolveCommandPath
// force-appended ".cmd" on win32 — correct for npm shims, wrong for native .exe
// CLIs reachable on PATH (agy, grok): cmd.exe resolves a BARE name via PATHEXT,
// but "agy.cmd" matches nothing when only agy.exe exists. Surfaced by the
// operator-ratified machine dedupe (vendor-folder copies removed in favor of
// PATH-canonical installs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommandPath } from "./tool-paths.js";

test("a native .exe reachable on PATH resolves as the BARE name (shell resolves via PATHEXT)", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-fallback-"));
  const savedPath = process.env.PATH;
  const savedPathExt = process.env.PATHEXT;
  try {
    writeFileSync(join(dir, "zzz-a46-probe.exe"), "stub");
    process.env.PATH = dir;
    if (process.platform === "win32") process.env.PATHEXT = ".EXE;.CMD;.BAT";
    assert.equal(resolveCommandPath("zzz-a46-probe", "NO_SUCH_ENV_VAR_A46"), "zzz-a46-probe");
  } finally {
    process.env.PATH = savedPath;
    if (savedPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathExt;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name reachable nowhere keeps the historical fallback shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "illuci-fallback-"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = dir; // empty dir: nothing resolves
    const r = resolveCommandPath("zzz-a46-absent", "NO_SUCH_ENV_VAR_A46");
    assert.equal(r, process.platform === "win32" ? "zzz-a46-absent.cmd" : "zzz-a46-absent");
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
