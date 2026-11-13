// node:test — the [A33] runtime grounding guard: launcher/root mismatch fails
// closed; served ephemeral grounding fails closed; the session-side doctor
// comparison detects the split-brain no self-polling server can see.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorktreeKind,
  classifyGrounding,
  compareSessionGrounding,
  normalizeRootPath,
  isServeEntry,
  assertServeGrounding,
  GroundingError,
  EXPECTED_ROOT_ENV,
} from "./grounding.js";

// ── path normalization (Windows-real) ─────────────────────────────────────────

test("normalizeRootPath: backslashes, trailing slashes, and case fold to one comparable form", () => {
  assert.equal(
    normalizeRootPath("C:\\Users\\J\\Illuci\\"),
    normalizeRootPath("c:/users/j/illuci"),
  );
  assert.equal(normalizeRootPath(null), null);
});

// ── worktree kind ──────────────────────────────────────────────────────────────

test("classifyWorktreeKind: deployed beats git; linked worktree detected by git-dir split; primary otherwise", () => {
  assert.equal(classifyWorktreeKind({ hasBuildStamp: true }), "deployed");
  assert.equal(classifyWorktreeKind({ gitDir: null }), "non-git");
  assert.equal(
    classifyWorktreeKind({ gitDir: "C:/repo/.git/worktrees/wt1", gitCommonDir: "C:/repo/.git" }),
    "linked-worktree",
  );
  assert.equal(classifyWorktreeKind({ gitDir: "C:/repo/.git", gitCommonDir: "C:/repo/.git" }), "primary-checkout");
});

// ── the fail-closed verdicts ───────────────────────────────────────────────────

test("launcher/root MISMATCH fails closed — declared root != actual root", () => {
  const v = classifyGrounding({
    actualRoot: "C:/illuci/.claude/worktrees/exciting-diffie-96cd88",
    expectedRoot: "C:/Users/example-user/illuci-deployed",
    worktreeKind: "linked-worktree",
    serving: true,
  });
  assert.equal(v.status, "mismatch");
  assert.equal(v.failClosed, true);
});

test("mismatch fails closed even for a NON-serving process (env-driven, universal)", () => {
  const v = classifyGrounding({
    actualRoot: "C:/a",
    expectedRoot: "C:/b",
    worktreeKind: "primary-checkout",
    serving: false,
  });
  assert.equal(v.failClosed, true);
});

test("SERVING from an ephemeral linked worktree fails closed by default", () => {
  const v = classifyGrounding({
    actualRoot: "C:/illuci/.claude/worktrees/exciting-diffie-96cd88",
    expectedRoot: null,
    worktreeKind: "linked-worktree",
    serving: true,
  });
  assert.equal(v.status, "ephemeral");
  assert.equal(v.failClosed, true);
});

test("the ephemeral override is deliberate, visible, and audited in the verdict", () => {
  const v = classifyGrounding({
    actualRoot: "C:/illuci/.claude/worktrees/dev",
    worktreeKind: "linked-worktree",
    serving: true,
    allowEphemeral: true,
  });
  assert.equal(v.failClosed, false);
  assert.equal(v.status, "ephemeral-overridden");
  assert.equal(v.overridden, true);
});

test("a NON-serving process in a linked worktree is fine (dev CLI/tests unchanged)", () => {
  const v = classifyGrounding({
    actualRoot: "C:/illuci/.claude/worktrees/dev",
    worktreeKind: "linked-worktree",
    serving: false,
  });
  assert.equal(v.failClosed, false);
  assert.equal(v.status, "grounded");
});

test("deployed and primary roots are grounded; a matching declaration verifies", () => {
  assert.equal(classifyGrounding({ actualRoot: "C:/srv/illuci", worktreeKind: "deployed", serving: true }).failClosed, false);
  const declared = classifyGrounding({
    actualRoot: "C:\\Users\\J\\Illuci",
    expectedRoot: "c:/users/j/illuci/",
    worktreeKind: "primary-checkout",
    serving: true,
  });
  assert.equal(declared.status, "grounded");
});

// ── the session-side doctor comparison (the exciting-diffie case, reproduced) ─

test("compareSessionGrounding: the CONFIRMED split-brain — active session vs stale MCP launcher root", () => {
  const r = compareSessionGrounding({
    activeRoot: "C:/illuci/.claude/worktrees/suspicious-einstein-b05323",
    servedRoot: "C:/illuci/.claude/worktrees/exciting-diffie-96cd88",
  });
  assert.equal(r.match, false);
  assert.equal(r.status, "split-brain");
});

test("compareSessionGrounding: aligned when the MCP serves the active worktree; unreported when identity is pre-[A33]", () => {
  assert.equal(
    compareSessionGrounding({ activeRoot: "C:/illuci", servedRoot: "C:\\illuci\\" }).status,
    "aligned",
  );
  assert.equal(compareSessionGrounding({ activeRoot: "C:/illuci", servedRoot: null }).status, "unreported");
});

// ── the serve-entry discriminator + the thrown gate ───────────────────────────

test("isServeEntry: server.js/supervisor.js as main are serve entries; test runners are not", () => {
  assert.equal(isServeEntry("C:\\illuci\\core\\mcp\\server.js"), true);
  assert.equal(isServeEntry("/srv/illuci/core/mcp/supervisor.js"), true);
  assert.equal(isServeEntry("C:/illuci/node_modules/.bin/test-runner.js"), false);
  assert.equal(isServeEntry(undefined), false);
});

test("assertServeGrounding THROWS GroundingError on a declared-root mismatch (fail closed before serving)", () => {
  assert.throws(
    () => assertServeGrounding({ env: { [EXPECTED_ROOT_ENV]: "C:/some/other/root" }, serving: true }),
    (err) => err instanceof GroundingError && err.code === "ILLUCI_GROUNDING_REFUSED" && err.jsonRpcCode === -32076,
  );
});

test("assertServeGrounding passes for a non-serving embed with no declaration (tests, verify scripts)", () => {
  const facts = assertServeGrounding({ env: {}, serving: false });
  assert.equal(facts.grounding.failClosed, false);
  assert.ok(facts.sourceRoot);
  assert.ok(facts.pid > 0);
  assert.ok(Object.hasOwn(facts, "launcherPath"));
});
