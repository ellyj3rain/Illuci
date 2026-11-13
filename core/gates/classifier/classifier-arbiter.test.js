/**
 * illuci — Action Classifier · Arbiter + Feature-Extractor tests
 * (node:test, hermetic — no LLM, no real git mutation, no operator prompt)
 *
 * Covers:
 *   - TIER 0 categorical veto: tool outside PERMISSION_ACTIONS[level] → deny tier 0.
 *   - TIER 0 in-set tool with no relational trip → undecided.
 *   - TIER 1 worktree-mismatch: same root → not denied; different root → deny tier 1.
 *   - TIER 1 workspace containment: escaping path → deny tier 1.
 *   - TIER 1 dangerous shell command → deny tier 1.
 *   - Feature extractor validation: no active context → throws (caller fails closed).
 *
 * Run: node --test illuci/core/gates/classifier/classifier-arbiter.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { classifyAction } from "./classifier-arbiter.js";
import { buildFeatureContext } from "./feature-extractor.js";
import { setApprovalContext, clearApprovalContext } from "../approval-context.js";

// A normalized comparison helper that matches the arbiter's (platform-aware).
function root(p) {
  return resolve(p);
}

// ─── TIER 0 — CATEGORICAL PERMISSION VETO ───

test("TIER 0: tool outside PERMISSION_ACTIONS[level] → deny tier 0", async () => {
  // read-verify may NEVER file_write (categorical), regardless of context scope.
  const featureCtx = {
    tool: "file_write",
    permissionLevel: "read-verify",
    targetPath: root("some/file.js"),
    seatWorktreeRoot: null,
    workspaceRoot: null,
    targetGit: { worktreeRoot: null, normalizedRoot: null },
    command: null,
  };
  const cls = await classifyAction(featureCtx);
  assert.equal(cls.decision, "deny");
  assert.equal(cls.tier, 0);
  assert.equal(cls.auditData.rule, "tier0-categorical-veto");
});

test("TIER 0: unknown permission level → deny tier 0 (fail-closed)", async () => {
  const cls = await classifyAction({
    tool: "file_write",
    permissionLevel: "does-not-exist",
    targetPath: null,
    targetGit: { worktreeRoot: null, normalizedRoot: null },
  });
  assert.equal(cls.decision, "deny");
  assert.equal(cls.tier, 0);
  assert.equal(cls.auditData.rule, "tier0-unknown-level");
});

test("TIER 0: in-set tool with no relational trip → undecided", async () => {
  // implement MAY file_write; with no path it cannot trip containment/worktree.
  const cls = await classifyAction({
    tool: "file_write",
    permissionLevel: "implement",
    targetPath: null,
    seatWorktreeRoot: null,
    workspaceRoot: null,
    targetGit: { worktreeRoot: null, normalizedRoot: null },
    command: null,
  });
  assert.equal(cls.decision, "undecided");
});

// ─── TIER 1 — GIT WORKTREE MISMATCH (the worktree pin) ───

test("TIER 1: target git root === seat worktree → NOT denied by mismatch", async () => {
  const seat = root("/repo/worktreeA");
  const featureCtx = {
    tool: "file_write",
    permissionLevel: "implement",
    targetPath: root("/repo/worktreeA/src/x.js"),
    seatWorktreeRoot: seat,
    workspaceRoot: seat,
    // same owning worktree as the seat → mismatch must NOT fire
    targetGit: {
      worktreeRoot: seat,
      normalizedRoot: process.platform === "win32" ? seat.replace(/\\/g, "/").toLowerCase() : seat.replace(/\\/g, "/"),
    },
    command: null,
  };
  const cls = await classifyAction(featureCtx);
  assert.notEqual(cls.decision, "deny");
  // contained + same worktree → undecided (defer to operator)
  assert.equal(cls.decision, "undecided");
});

test("TIER 1: target git root !== seat worktree → deny tier 1 (worktree mismatch)", async () => {
  const seat = root("/repo/worktreeA");
  const otherTree = root("/repo/worktreeB");
  const featureCtx = {
    tool: "file_write",
    permissionLevel: "implement",
    // target lives in worktreeB, but the seat intends worktreeA
    targetPath: root("/repo/worktreeB/src/y.js"),
    seatWorktreeRoot: seat,
    workspaceRoot: seat,
    targetGit: {
      worktreeRoot: otherTree,
      normalizedRoot: process.platform === "win32"
        ? otherTree.replace(/\\/g, "/").toLowerCase()
        : otherTree.replace(/\\/g, "/"),
    },
    command: null,
  };
  const cls = await classifyAction(featureCtx);
  assert.equal(cls.decision, "deny");
  assert.equal(cls.tier, 1);
  assert.equal(cls.auditData.rule, "tier1-worktree-mismatch");
});

// ─── TIER 1 — WORKSPACE CONTAINMENT ───

test("TIER 1: path escaping the workspace root → deny tier 1 (containment)", async () => {
  const seat = root("/repo/worktreeA");
  const featureCtx = {
    tool: "file_write",
    permissionLevel: "implement",
    targetPath: root("/somewhere/else/z.js"),
    seatWorktreeRoot: seat,
    workspaceRoot: seat,
    // unknown owning worktree → mismatch can't prove, containment must catch it
    targetGit: { worktreeRoot: null, normalizedRoot: null },
    command: null,
  };
  const cls = await classifyAction(featureCtx);
  assert.equal(cls.decision, "deny");
  assert.equal(cls.tier, 1);
  assert.equal(cls.auditData.rule, "tier1-workspace-containment");
});

// ─── TIER 1 — DANGEROUS SHELL COMMAND ───

test("TIER 1: dangerous shell command → deny tier 1", async () => {
  const cls = await classifyAction({
    tool: "shell_exec",
    permissionLevel: "implement",
    targetPath: null,
    seatWorktreeRoot: null,
    workspaceRoot: null,
    targetGit: { worktreeRoot: null, normalizedRoot: null },
    command: "rm -rf build",
  });
  assert.equal(cls.decision, "deny");
  assert.equal(cls.tier, 1);
  assert.equal(cls.auditData.rule, "tier1-dangerous-command");
});

// ─── FEATURE EXTRACTOR — VALIDATION (caller fails closed on throw) ───

test("feature extractor: no active approval context → throws", async () => {
  clearApprovalContext();
  await assert.rejects(
    () => buildFeatureContext({ tool: "file_write", args: { path: "x.js" }, source: {} }, { decision: "gate" }),
    /no active approval context/,
  );
});

test("feature extractor: missing tool → throws", async () => {
  setApprovalContext({ permissionLevel: "implement", allowedActions: ["file_write"] });
  await assert.rejects(
    () => buildFeatureContext({ args: { path: "x.js" }, source: {} }, { decision: "gate" }),
    /params\.tool missing/,
  );
  clearApprovalContext();
});

test("feature extractor: valid context → returns real fields", async () => {
  setApprovalContext({
    permissionLevel: "implement",
    allowedActions: ["file_write", "file_read"],
    allowedPaths: ["core/x"],
    allowedPatterns: ["core/**"],
    deniedPaths: ["secrets"],
  });
  const fc = await buildFeatureContext(
    { tool: "file_write", args: { path: "core/x/y.js" }, source: { seat: "seat-1", model: "m" } },
    { decision: "gate", reason: "out of scope" },
  );
  assert.equal(fc.tool, "file_write");
  assert.equal(fc.permissionLevel, "implement");
  assert.equal(fc.targetPath, "core/x/y.js");
  assert.deepEqual(fc.allowedActions, ["file_write", "file_read"]);
  assert.equal(fc.seatId, "seat-1");
  // targetGit is always present (resolved via getGitInfo)
  assert.ok(fc.targetGit && "worktreeRoot" in fc.targetGit);
  clearApprovalContext();
});
