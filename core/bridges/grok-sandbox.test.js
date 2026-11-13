// node:test — the grok-lane OS sandbox lever (DR-202; [A115]; F-141/F-142).
// grok imposes its OWN kernel-enforced sandbox; illuci defaults it to `strict`, with a
// disclosed env/dispatch override and an honest per-platform `enforced` signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveGrokSandbox,
  grokSandboxArgs,
  GROK_BUILTIN_PROFILES,
  GROK_SANDBOX_DEFAULT,
  GROK_ENFORCING_PLATFORMS,
} from "./grok-sandbox.js";
import { DEFAULTS } from "../governance/defaults-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("default is strict, sourced 'default', enforced on Linux", () => {
  const r = resolveGrokSandbox({}, {}, "linux");
  assert.equal(r.profile, "strict");
  assert.equal(r.source, "default");
  assert.equal(r.builtin, true);
  assert.equal(r.enforced, true);
  assert.deepEqual(grokSandboxArgs(r), ["--sandbox", "strict"]);
});

test("GROK_SANDBOX_DEFAULT is strict and a known built-in", () => {
  assert.equal(GROK_SANDBOX_DEFAULT, "strict");
  assert.ok(GROK_BUILTIN_PROFILES.includes("strict"));
  assert.ok(GROK_BUILTIN_PROFILES.includes("off"));
});

test("env ILLUCI_GROK_SANDBOX overrides the default", () => {
  const r = resolveGrokSandbox({}, { ILLUCI_GROK_SANDBOX: "read-only" }, "linux");
  assert.equal(r.profile, "read-only");
  assert.equal(r.source, "env");
  assert.equal(r.enforced, true);
  assert.deepEqual(grokSandboxArgs(r), ["--sandbox", "read-only"]);
});

test("dispatch option outranks env (precedence dispatch > env > default)", () => {
  const r = resolveGrokSandbox({ grokSandbox: "workspace" }, { ILLUCI_GROK_SANDBOX: "read-only" }, "linux");
  assert.equal(r.profile, "workspace");
  assert.equal(r.source, "dispatch");
});

test("off is the disclosed opt-out — no --sandbox arg, never enforced", () => {
  const r = resolveGrokSandbox({ grokSandbox: "off" }, {}, "linux");
  assert.equal(r.profile, "off");
  assert.equal(r.enforced, false);
  assert.deepEqual(grokSandboxArgs(r), []);
});

test("HONESTY (F-142): a real profile is NOT enforced on win32/unsupported platforms", () => {
  const win = resolveGrokSandbox({}, {}, "win32");
  assert.equal(win.profile, "strict");
  assert.equal(win.enforced, false, "grok sandbox is a silent no-op on Windows");
  // the flag is still passed (harmless no-op there, load-bearing on the deployed Linux runtime)
  assert.deepEqual(grokSandboxArgs(win), ["--sandbox", "strict"]);

  for (const plat of GROK_ENFORCING_PLATFORMS) {
    assert.equal(resolveGrokSandbox({}, {}, plat).enforced, true, `${plat} enforces`);
  }
});

test("built-in names normalize case; membership is case-insensitive", () => {
  const r = resolveGrokSandbox({ grokSandbox: "STRICT" }, {}, "darwin");
  assert.equal(r.profile, "strict");
  assert.equal(r.builtin, true);
});

test("a custom (unknown-but-safe) profile name passes through as non-builtin", () => {
  const r = resolveGrokSandbox({ grokSandbox: "locked_project" }, {}, "linux");
  assert.equal(r.profile, "locked_project");
  assert.equal(r.builtin, false);
  assert.equal(r.enforced, true, "custom profiles are enforced on Linux (grok fails closed if missing)");
  assert.deepEqual(grokSandboxArgs(r), ["--sandbox", "locked_project"]);
});

test("unsafe/garbage values degrade LOUDLY to the strict default", () => {
  for (const bad of ["", "  ", "--always-approve", "a b", "x;rm -rf /", "..\\evil"]) {
    const r = resolveGrokSandbox({ grokSandbox: bad }, {}, "linux");
    // empty/whitespace fall through to the default via the length guard; unsafe shapes
    // are caught by SAFE_PROFILE — both land on strict, the confined side.
    assert.equal(r.profile, "strict", `${JSON.stringify(bad)} must degrade to strict`);
    assert.equal(r.source, "default");
  }
});

test("grokSandboxArgs tolerates a null/absent descriptor", () => {
  assert.deepEqual(grokSandboxArgs(null), []);
  assert.deepEqual(grokSandboxArgs(undefined), []);
});

test("grok-lane-sandbox is a disclosed defaults-registry row (DR-130)", () => {
  const row = DEFAULTS.find((d) => d.id === "grok-lane-sandbox");
  assert.ok(row, "grok-lane-sandbox must be a disclosed defaults-registry row");
  assert.equal(row.resolve({}), "strict");
  assert.equal(row.resolve({ ILLUCI_GROK_SANDBOX: "off" }), "off");
  assert.equal(row.resolve({ ILLUCI_GROK_SANDBOX: "READ-ONLY" }), "read-only");
  assert.match(row.change.env, /ILLUCI_GROK_SANDBOX/);
  assert.equal(row.since, "A115");
});

test("SOURCE-GREP: grok-cli wires the sandbox lever and warns on non-enforcing platforms", () => {
  const src = readFileSync(join(HERE, "grok-cli.js"), "utf8");
  assert.match(src, /resolveGrokSandbox\(options\)/, "grok-cli must resolve the sandbox descriptor");
  assert.match(src, /grokSandboxArgs\(sandbox\)/, "grok-cli must splice the --sandbox args");
  assert.match(src, /!sandbox\.enforced/, "grok-cli must branch on the honest enforced signal");
});
