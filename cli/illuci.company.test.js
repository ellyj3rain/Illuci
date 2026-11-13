/**
 * illuci — `illuci company` verb: feature-flag gate (node:test, child-process hermetic).
 *
 * The verb is feature-flagged OFF by default (company-enabled). When OFF it must
 * REFUSE cleanly — print the off message and exit non-zero, WITHOUT running. When ON
 * it must get PAST the gate and into config construction + dispatch. We drive the real
 * illuci.mjs as a child process so the gate's actual env/config read is exercised.
 *
 * The flag-ON construct+dispatch path is forced hermetic with ILLUCI_COMPANY_TEST_STUB=1,
 * which the CLI honors by swapping orchestrate() for an injected stub that records the
 * built company config and resolves a synthetic result (no live models). The stub seam
 * is test-only and gated behind the same enabled flag, so it is never on a real run.
 *
 * Run: node --test illuci/cli/illuci.company.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "illuci.mjs");
const REPO_ROOT = resolve(__dirname, "..", ".."); // …/quizzical-hypatia-9d84a2

function runCli(args, env = {}) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      // Run from a temp-ish cwd with no illuci.config.json so the file read can't flip the
      // flag unexpectedly; REPO_ROOT has no illuci.config.json so it is a clean default.
      cwd: REPO_ROOT,
      env: { ...process.env, ILLUCI_COMPANY_ENABLED: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

// ─── FLAG OFF: the verb refuses cleanly and does NOT run ────────────────────────

test("flag OFF (default): `illuci company` refuses with a clear message and exits non-zero", async () => {
  const { code, stdout, stderr } = await runCli(["company", "judiciary", "decide this"]);
  assert.notEqual(code, 0, "a disabled verb must exit non-zero");
  const out = stdout + stderr;
  assert.match(out, /company-enabled is off/i, "the refusal names the flag that is off");
  assert.match(out, /ILLUCI_COMPANY_ENABLED/, "the refusal tells the operator how to enable it");
  // It must NOT have run anything — no company session header on a refused run.
  assert.doesNotMatch(out, /=== company .* session company-/);
});

test("flag explicitly OFF: ILLUCI_COMPANY_ENABLED=0 also refuses", async () => {
  const { code, stdout, stderr } = await runCli(["company", "judiciary", "x"], { ILLUCI_COMPANY_ENABLED: "0" });
  assert.notEqual(code, 0);
  assert.match(stdout + stderr, /company-enabled is off/i);
});

// ─── FLAG ON: the verb gets PAST the gate and constructs + dispatches ───────────

test("flag ON: `illuci company` constructs the company config and dispatches (hermetic stub)", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "judiciary,legislature", "what should illuci build next?", "--prosecutor", "grok-build", "--awareness", "--json"],
    { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" },
  );
  const out = stdout + stderr;
  assert.equal(code, 0, `flag-ON run should succeed via the stub; got code ${code}\n${out}`);
  // The stub echoes the constructed company config as JSON — assert the verb built it right.
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.__stub, "the dispatch went through the hermetic stub (no live models)");
  const ids = parsed.config.topologies.map((t) => t.topologyId);
  assert.deepEqual(ids, ["judiciary", "legislature"], "both named topologies are in the company set");
  assert.equal(parsed.config.prompt, "what should illuci build next?");
  assert.equal(parsed.config.awareness, true);
  assert.deepEqual(parsed.config.lineup, { prosecutor: "grok-build" }, "the per-seat lineup is parsed and passed");
});

test("flag ON: an unknown topology is rejected before any dispatch", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "not-a-topology", "x"],
    { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" },
  );
  assert.notEqual(code, 0);
  assert.match(stdout + stderr, /unknown topolog/i);
});


test("flag ON: global disposition flags fan out to auto-filled company seats", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "dev-team", "compose this", "--preset", "executive", "--role", "implementer", "--json"],
    { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" },
  );

  const out = stdout + stderr;
  assert.equal(code, 0, "company disposition run should succeed via the stub; got code " + code + "\n" + out);
  const parsed = JSON.parse(stdout);
  const seatDispositions = parsed.config.topologies[0].options.seatDispositions;

  assert.deepEqual(Object.keys(seatDispositions), ["architect", "implementer", "reviewer", "qa"]);
  for (const seatId of Object.keys(seatDispositions)) {
    assert.deepEqual(seatDispositions[seatId], { presetId: "executive", role: "implementer" });
  }
});

test("flag ON: --cognitive-controls passes through to each company member options object", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "judiciary,legislature", "classify this", "--cognitive-controls", "--json"],
    { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" },
  );

  const out = stdout + stderr;
  assert.equal(code, 0, "company cognitive-controls run should succeed via the stub; got code " + code + "\n" + out);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.config.topologies[0].options.cognitiveControlsEnabled, true);
  assert.equal(parsed.config.topologies[1].options.cognitiveControlsEnabled, true);
  assert.equal(parsed.config.lineup, null);
});

test("flag ON: --mutation-authority blocked fans out through run-control", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "dev-team,devops-pipeline", "plan this without writes", "--mutation-authority", "blocked", "--json"],
    { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" },
  );

  const out = stdout + stderr;
  assert.equal(code, 0, "company run-control run should succeed via the stub; got code " + code + "\n" + out);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.config.topologies[0].options.runControl.execution, { mutationAuthority: "blocked" });
  assert.deepEqual(parsed.config.topologies[1].options.runControl.execution, { mutationAuthority: "blocked" });
  assert.equal(parsed.config.lineup, null);
});

test("flag ON: malformed orchestration flags reject before dispatch", async () => {
  const cases = [
    [["company", "dev-team", "plan this", "--agenda"], /--agenda requires a value/],
    [["company", "dev-team", "plan this", "--architect"], /--architect requires a value/],
    [["company", "dev-team", "plan this", "--architect-preset"], /--architect-preset requires a value/],
    [["company", "dev-team", "plan this", "--json", "false"], /--json does not take a value/],
  ];

  for (const [args, pattern] of cases) {
    const { code, stdout, stderr } = await runCli(args, { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" });
    assert.equal(code, 1, `${args.join(" ")} should reject before dispatch`);
    assert.match(stdout + stderr, pattern);
  }
});

// ─── [A99]/DR-192: genome + agents parity with `illuci run` ────────────────────────

const PARITY_AGENTS = "{\"agents\":{\"scout\":{}},\"seatAgents\":{\"red\":\"scout\"}}";
const ON = { ILLUCI_COMPANY_ENABLED: "1", ILLUCI_COMPANY_TEST_STUB: "1" };

test("A99: the agents manifest + genome control thread into BOTH member options and the company config", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "adversarial-debate", "parity proof",
     "--agents", PARITY_AGENTS,
     "--genome-project-dir", "/tmp/parity",
     "--genome-precedence", "dominant",
     "--genome-seal-threshold", "16",
     "--genome-child-identity", "inherit"],
    ON,
  );
  assert.equal(code, 0, stdout + stderr);
  const { config } = JSON.parse(stdout);

  // Company-level carry: under childIdentity=inherit the members' children
  // receive these through carryChildIdentity (A91/DR-184).
  assert.ok(config.agents, "company config carries the agents manifest");
  assert.equal(config.genome.precedence, "dominant");
  assert.equal(config.genome.sealThreshold, 16);
  assert.equal(config.genome.childIdentity, "inherit");

  // Member-level: every topology arms the same manifest + genome.
  const member = config.topologies[0].options;
  assert.ok(member.agents, "member options carry the agents manifest");
  assert.equal(member.genome.childIdentity, "inherit");
  assert.match(member.genome.projectDir, /parity/);
});

test("A99: unarmed company omits genome + agents entirely (byte-identical default)", async () => {
  const { code, stdout, stderr } = await runCli(["company", "adversarial-debate", "no arm"], ON);
  assert.equal(code, 0, stdout + stderr);
  const { config } = JSON.parse(stdout);
  assert.equal(config.genome, undefined);
  assert.equal(config.agents, undefined);
  assert.equal(config.topologies[0].options.genome, undefined);
  assert.equal(config.topologies[0].options.agents, undefined);
});

test("A99: company genome flags fail closed exactly like illuci run, naming the company surface", async () => {
  const cases = [
    [["--genome-precedence", "seed"], /require --genome-project-dir/],
    [["--genome-seal-threshold", "8"], /require --genome-project-dir/],
    [["--genome-child-identity", "inherit"], /require --genome-project-dir/],
    [["--genome-project-dir", "/tmp/g", "--genome-precedence", "bogus"], /--genome-precedence must be one of/],
    [["--genome-project-dir", "/tmp/g", "--genome-seal-threshold", "-2"], /non-negative integer/],
    [["--genome-project-dir", "/tmp/g", "--genome-child-identity", "bogus"], /is not a state/],
  ];
  for (const [extra, pattern] of cases) {
    const { code, stdout, stderr } = await runCli(["company", "adversarial-debate", "x", ...extra], ON);
    assert.equal(code, 1, extra.join(" ") + " should exit 1");
    const out = stdout + stderr;
    assert.match(out, /illuci company:/, "the error names the company surface");
    assert.match(out, pattern);
  }
});

test("A99: the parity flags never leak into the per-seat lineup (RESERVED)", async () => {
  const { code, stdout, stderr } = await runCli(
    ["company", "adversarial-debate", "lineup isolation",
     "--agents", PARITY_AGENTS, "--genome-project-dir", "/tmp/parity", "--red", "deepseek"],
    ON,
  );
  assert.equal(code, 0, stdout + stderr);
  const { config } = JSON.parse(stdout);
  assert.deepEqual(Object.keys(config.lineup), ["red"], "only the real seat flag became lineup");
  assert.equal(config.lineup.red, "deepseek");
});
