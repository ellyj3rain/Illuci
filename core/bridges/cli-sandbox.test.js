// node:test — the CLI-agent lane sandbox (DR-200; F-139): agentic-CLI lanes
// ground in a per-dispatch scratch dir by default; the shared-workspace
// opt-out is explicit; every CLI bridge's spawn passes the resolved cwd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_LANE_WORKSPACE_MODES, resolveCliLaneWorkspace } from "./cli-sandbox.js";
import { DEFAULTS } from "../governance/defaults-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("default: a fresh per-dispatch sandbox under the OS temp root, created on resolve", () => {
  const a = resolveCliLaneWorkspace({ runId: "run-abc" }, {});
  assert.equal(a.mode, "sandbox");
  assert.ok(a.cwd.startsWith(join(tmpdir(), "illuci-cli-lane-sandbox") + sep), a.cwd);
  assert.ok(a.cwd.includes("run-abc"), "sandbox dir carries the run id for legibility");
  assert.ok(existsSync(a.cwd), "the sandbox dir is created before spawn");
  const b = resolveCliLaneWorkspace({ runId: "run-abc" }, {});
  assert.notEqual(a.cwd, b.cwd, "each dispatch gets its OWN scratch dir");
});

test("shared is an explicit opt-out: dispatch option or env, and it is exactly the engine cwd", () => {
  assert.deepEqual(resolveCliLaneWorkspace({ cliWorkspace: "shared" }, {}), { mode: "shared", cwd: process.cwd() });
  assert.deepEqual(resolveCliLaneWorkspace({}, { ILLUCI_CLI_LANE_WORKSPACE: "shared" }), { mode: "shared", cwd: process.cwd() });
  // the dispatch option wins over env (nearest control wins)
  assert.equal(resolveCliLaneWorkspace({ cliWorkspace: "sandbox" }, { ILLUCI_CLI_LANE_WORKSPACE: "shared" }).mode, "sandbox");
});

test("an unknown mode degrades to sandbox — the safe side of a typo is isolation", () => {
  const r = resolveCliLaneWorkspace({ cliWorkspace: "shraed" }, {});
  assert.equal(r.mode, "sandbox");
  assert.ok(r.cwd.startsWith(join(tmpdir(), "illuci-cli-lane-sandbox") + sep));
});

test("the sandbox dir name sanitizes hostile run ids (no path traversal)", () => {
  const r = resolveCliLaneWorkspace({ runId: "../..\\evil id" }, {});
  const base = join(tmpdir(), "illuci-cli-lane-sandbox");
  assert.ok(resolve(r.cwd).startsWith(base + sep), `sandbox escaped its root: ${r.cwd}`);
});

test("the vocabulary is closed and disclosed", () => {
  assert.deepEqual([...CLI_LANE_WORKSPACE_MODES], ["sandbox", "shared"]);
  const row = DEFAULTS.find((d) => d.id === "cli-lane-sandbox");
  assert.ok(row, "cli-lane-sandbox must be a disclosed defaults-registry row (DR-130)");
  assert.equal(row.resolve({}), "sandbox");
  assert.equal(row.resolve({ ILLUCI_CLI_LANE_WORKSPACE: "shared" }), "shared");
  assert.equal(row.change.env, "ILLUCI_CLI_LANE_WORKSPACE=shared");
});

// ── SOURCE-GREP GUARD: every CLI-agent bridge grounds its spawn (the F-138
// bridge lesson applied forward: the seam is guarded where it lives). ──
const CLI_BRIDGES = ["claude.js", "kimi.js", "agy.js"];

test("GUARD: every CLI-agent bridge spawn passes cwd from resolveCliLaneWorkspace", () => {
  for (const rel of CLI_BRIDGES) {
    const src = readFileSync(join(HERE, rel), "utf8");
    assert.match(
      src,
      /cwd:\s*resolveCliLaneWorkspace\(options\)\.cwd,/,
      `${rel} must ground its spawned agentic CLI via resolveCliLaneWorkspace (DR-200) — an unwired spawn inherits the engine workspace`,
    );
  }
  // grok-cli resolves the lane into a variable (it co-locates its --prompt-file inside
  // the grounded cwd so the DR-202 `strict` sandbox — read CWD + system paths — can read
  // it) and spawns with that same cwd; guard both halves.
  const grok = readFileSync(join(HERE, "grok-cli.js"), "utf8");
  assert.match(
    grok,
    /const lane = resolveCliLaneWorkspace\(options\);/,
    "grok-cli.js must resolve the lane workspace through the DR-200 seam",
  );
  assert.match(
    grok,
    /cwd:\s*lane\.cwd,/,
    "grok-cli.js must spawn grok grounded in the resolved lane cwd (DR-200)",
  );
  // gemini keeps its stronger explicit-cwd control; guard its exact resolution
  const gemini = readFileSync(join(HERE, "gemini.js"), "utf8");
  assert.match(
    gemini,
    /const sandbox = resolveCliLaneWorkspace\(options\);/,
    "gemini.js must resolve the lane workspace through the DR-200 seam",
  );
  assert.match(
    gemini,
    /options\.cwd \|\| \(sandbox\.mode === "shared"/,
    "gemini.js: explicit options.cwd wins; otherwise sandbox-by-default with the shared opt-out",
  );
  // codex grounds via the SDK thread's workingDirectory (its native sandboxMode
  // jail then encloses the DR-200 scratch dir — sandbox-in-sandbox); an
  // explicit options.workingDirectory stays the stronger control.
  const codex = readFileSync(join(HERE, "codex.js"), "utf8");
  assert.match(
    codex,
    /if \(options\.workingDirectory\) return options\.workingDirectory;[\s\S]{0,400}return resolveCliLaneWorkspace\(options\)\.cwd;/,
    "codex.js must ground its SDK threads in the DR-200 sandbox by default (explicit workingDirectory wins)",
  );
});
