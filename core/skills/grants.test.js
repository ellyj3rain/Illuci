/**
 * illuci — Skill Grants (M6 lived skill layer) tests (node:test)
 *
 * The load-bearing test is the DR-112 SECURITY INVARIANT: a skill grant is a
 * request still subject to the mode, never a bypass. It may DENY an off-floor
 * MCP call the seat is not licensed for, but it can NEVER approve a gated tool
 * or lower its level. "Wear the deploy skill" can never become "skip the gate".
 *
 * Run: node --test illuci/core/skills/grants.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSeatGrants, evaluateSkillGrant, renderSkillsBlock, isMcpTool, mcpBridgeOf } from "./grants.js";
import { getSkill } from "../agents/skill-registry.js";
import { executeTool } from "../bridges/tools.js";

test("resolveSeatGrants: max tool weights, MCP bridges collected, MOST-RESTRICTIVE autonomy", () => {
  const skills = [getSkill("security-audit"), getSkill("code-review")];
  const g = resolveSeatGrants(skills);
  // security-audit grants the snyk-cli bridge; code-review grants none
  assert.ok(g.mcpBridges.has("snyk-cli"));
  // tool weights are the max across skills
  assert.equal(g.toolWeights["grep_search"], 0.95); // security-audit's 0.95 > code-review's 0.9
  // autonomy is the most restrictive (min) across skills
  assert.equal(g.autonomy.maxDepth, 0); // code-review caps at 0
  assert.equal(g.autonomy.requiresIntrospector, true); // security-audit requires it
  assert.equal(g.autonomy.sandboxRequired, true);
  assert.deepEqual(g.skillIds.sort(), ["code-review", "security-audit"]);
});

test("INVARIANT: an off-floor MCP tool is DENIED without a granting skill", () => {
  const grants = resolveSeatGrants([getSkill("code-review")]); // grants no bridges
  const r = evaluateSkillGrant("snyk-cli__scan", grants);
  assert.equal(r.allow, false);
  assert.match(r.reason, /not licensed for MCP bridge "snyk-cli"/);
});

test("INVARIANT: a granted MCP tool is LICENSED — allow:true, never 'approved' (still faces the gate)", () => {
  const grants = resolveSeatGrants([getSkill("security-audit")]); // grants snyk-cli
  const r = evaluateSkillGrant("snyk-cli__scan", grants);
  assert.equal(r.allow, true);
  // the result is a LICENSE, not an approval — it cannot carry an "approved" verdict
  assert.equal(r.approved, undefined);
  assert.match(r.reason, /proceeds to the mode gate/);
});

test("INVARIANT: floor tools are always licensed (stratum 1), still subject to the gate", () => {
  const grants = resolveSeatGrants([getSkill("code-review")]);
  for (const floor of ["file_write", "file_edit", "shell_exec", "file_read", "search"]) {
    const r = evaluateSkillGrant(floor, grants);
    assert.equal(r.allow, true, `${floor} is a floor tool — inherent`);
    assert.equal(r.approved, undefined, "license is not approval");
  }
});

test("INVARIANT: no skill layer bound → floor governs, skills withhold nothing", () => {
  assert.equal(evaluateSkillGrant("snyk-cli__scan", null).allow, true);
  assert.equal(evaluateSkillGrant("file_write", null).allow, true);
});

test("isMcpTool / mcpBridgeOf classify namespaced tool names", () => {
  assert.equal(isMcpTool("snyk-cli__scan"), true);
  assert.equal(isMcpTool("github.create_issue"), true);
  assert.equal(isMcpTool("file_write"), false);
  assert.equal(isMcpTool("shell_exec"), false);
  assert.equal(mcpBridgeOf("snyk-cli__scan"), "snyk-cli");
  assert.equal(mcpBridgeOf("github.create_issue"), "github");
});

test("renderSkillsBlock lists competences + granted bridges + invariants; null when no skills", () => {
  const block = renderSkillsBlock([getSkill("security-audit")]);
  assert.match(block, /^\[Skills\]/);
  assert.match(block, /Security Audit/);
  assert.match(block, /Granted external access: snyk-cli/);
  assert.match(block, /never lift the operator's gate/);
  assert.equal(renderSkillsBlock([]), null);
});

test("ENFORCEMENT at executeTool: an ungranted MCP call is blocked BEFORE the gate", async () => {
  const grants = resolveSeatGrants([getSkill("code-review")]); // no bridges
  const res = await executeTool("snyk-cli__scan", { target: "." }, { skillGrants: grants, agentId: "deepseek", agentName: "reviewer" });
  assert.equal(res.success, false);
  assert.equal(res.blocked, true);
  assert.match(res.reason, /not licensed for MCP bridge/);
});

test("ENFORCEMENT at executeTool: a floor read passes the license check (no skill blocks the floor)", async () => {
  const grants = resolveSeatGrants([getSkill("security-audit")]);
  // file_read is gate level NONE and a floor tool — the license check must not block it.
  // (It then runs the real read; we only assert the license layer didn't deny.)
  const res = await executeTool("file_read", { path: "VERSION" }, { skillGrants: grants });
  // success or a read-specific result, but NOT a skill-license block
  assert.notEqual(res.reason, undefined === res.reason);
  assert.ok(!(res.blocked && /not licensed/.test(res.reason || "")), "floor read must not be skill-blocked");
});
