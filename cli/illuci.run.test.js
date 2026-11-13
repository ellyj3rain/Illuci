import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./illuci.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function runIlluci(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ILLUCI_QUIET_DEFAULTS: "1" },
    encoding: "utf8",
  });
}

test("run CLI rejects malformed orchestration flags before dispatch", () => {
  const cases = [
    [["--agenda"], /--agenda requires a value/],
    [["--architect"], /--architect requires a value/],
    [["--architect-preset"], /--architect-preset requires a value/],
    [["--json", "false"], /--json does not take a value/],
  ];

  for (const [extra, pattern] of cases) {
    const result = runIlluci(["run", "direct", "inspect this", ...extra]);
    assert.equal(result.status, 1, `${extra.join(" ")} should reject before dispatch`);
    assert.match(result.stderr, pattern);
  }
});

// [A90.1]/DR-183: the genome flags fail closed before dispatch — the arm is
// --genome-project-dir; refining an absent arm is a loud mistake, not a no-op.
test("run CLI rejects malformed genome flags before dispatch", () => {
  const cases = [
    [["--genome-project-dir"], /--genome-project-dir requires a value/],
    [["--genome-project-dir", ".", "--genome-precedence", "sideways"], /--genome-precedence must be one of: seed, dominant, pull/],
    [["--genome-project-dir", ".", "--genome-seal-threshold", "-3"], /--genome-seal-threshold must be a non-negative integer/],
    [["--genome-precedence", "seed"], /require --genome-project-dir/],
    [["--genome-seal-threshold", "8"], /require --genome-project-dir/],
    // [A91.1]/DR-184 + [A92]/DR-185: the childIdentity flag — unknown states
    // exit 1 loudly through the ONE policy module (all four ratified states
    // are live as of A92); refining an absent arm is loud too.
    [["--genome-project-dir", ".", "--genome-child-identity", "sideways"], /not a state/],
    [["--genome-child-identity", "inherit"], /require --genome-project-dir/],
  ];

  for (const [extra, pattern] of cases) {
    const result = runIlluci(["run", "direct", "inspect this", ...extra]);
    assert.equal(result.status, 1, `${extra.join(" ")} should reject before dispatch`);
    assert.match(result.stderr, pattern);
  }
});
