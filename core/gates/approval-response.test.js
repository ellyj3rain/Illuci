import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerApprovalCallback, clearApprovalCallback, requestCallbackApproval } from "./callback-gate.js";
import { makeGateCallback } from "../mcp/dispatch-tools.js";
import { makeElicitor } from "../mcp/server.js";

test("callback accepts only literal booleans and preserves no-decision", async () => {
  try {
    for (const value of ["false", "true", 1, 0, null, undefined, {}, []]) {
      registerApprovalCallback(async () => ({ approved: value }));
      const result = await requestCallbackApproval({});
      assert.equal(result.approved, false, String(value));
      assert.equal(result.code, "approval-not-provided");
    }
    for (const value of [true, false]) {
      registerApprovalCallback(async () => ({ approved: value, reason: "fixture" }));
      const result = await requestCallbackApproval({});
      assert.equal(result.approved, value);
      assert.equal(result.code, undefined);
    }
    registerApprovalCallback(async () => { throw Error("synthetic"); });
    assert.equal((await requestCallbackApproval({})).code, "approval-not-provided");
    registerApprovalCallback(async () => ({ approved: true, code: "approval-not-provided" }));
    const contradictory = await requestCallbackApproval({});
    assert.equal(contradictory.approved, false);
    assert.equal(contradictory.code, "approval-not-provided");
  } finally { clearApprovalCallback(); }
});

test("MCP approval form requires an accepted explicit true; generic action-only stays supported", async () => {
  const cases = [
    [{ action: "accept", content: { approved: true } }, true, false],
    [{ action: "accept", content: { approved: false } }, false, false],
    [{ action: "decline" }, false, false],
    [{ action: "accept" }, false, true],
    [{ action: "accept", content: { approved: "true" } }, false, true],
    [{ action: "cancel", content: { approved: true } }, false, true],
    [null, false, true],
  ];
  for (const [reply, approved, missing] of cases) {
    let request;
    const gate = makeGateCallback("ask", async value => { request = value; return reply; });
    const result = await gate({ tool: "shell_exec" });
    assert.deepEqual(request.requestedSchema.required, ["approved"]);
    assert.equal(result.approved, approved);
    assert.equal(result.code === "approval-not-provided", missing);
  }
  let elicitCalled = false;
  const edits = makeGateCallback("accept-edits", async () => { elicitCalled = true; });
  assert.equal((await edits({ tool: "file_write" })).approved, true);
  assert.equal(elicitCalled, false);
  let resolveReply;
  const generic = makeElicitor(true, () => {}, resolve => { resolveReply = resolve; return "synthetic"; });
  const pending = generic({ message: "Generic form", requestedSchema: { type: "object", properties: {} } });
  resolveReply({ action: "accept" });
  assert.deepEqual(await pending, { action: "accept" });
});

test("malformed callback refusal is not cached as a human denial", async () => {
  const { requestApproval } = await import("./gate-controller.js");
  const { setApprovalContext, clearApprovalContext, getApprovalContext } = await import("./approval-context.js");
  const { GATE_LEVELS } = await import("./gate-types.js");
  setApprovalContext({ task: "synthetic", allowedPaths: [], deniedPaths: [], allowedActions: ["file_write"] });
  let calls = 0;
  registerApprovalCallback(async () => { calls++; return { approved: "false" }; });
  try {
    const params = { tool: "file_write", args: { path: "synthetic-only/never-written.txt" }, level: GATE_LEVELS.FULL };
    assert.equal((await requestApproval(params)).approved, false);
    assert.equal((await requestApproval(params)).approved, false);
    assert.equal(calls, 2);
    assert.equal(getApprovalContext().denials.length, 0);
    registerApprovalCallback(async () => ({ approved: true, code: "approval-not-provided" }));
    assert.equal((await requestApproval(params)).approved, false);
    assert.equal(getApprovalContext().approvals.length, 0);
    assert.equal(getApprovalContext().denials.length, 0);
    registerApprovalCallback(makeGateCallback("ask", async () => ({ action: "cancel", content: { approved: true } })));
    assert.equal((await requestApproval(params)).approved, false);
    assert.equal(getApprovalContext().approvals.length, 0);
    assert.equal(getApprovalContext().denials.length, 0);
  } finally { clearApprovalCallback(); clearApprovalContext(); }
});

test("NDJSON bridge requires boolean on the matching request and records malformed provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-approval-response-"));
  const logger = join(root, "decisions.jsonl");
  const bridge = new URL("./bridge-gate.js", import.meta.url).href;
  const script = `import {requestBridgeApproval,closeBridge} from ${JSON.stringify(bridge)};\n` +
    `const result=await requestBridgeApproval({tool:'synthetic'});console.log(JSON.stringify({type:'result',result}));closeBridge();`;
  try {
    for (const [value, expected, status] of [[true, true, "operator-approved"], [false, false, "operator-denied"], ["false", false, "operator-absent"], [undefined, false, "operator-absent"]]) {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: root, env: { ...process.env, ILLUCI_DATA_HOME: join(root, "data"), ILLUCI_DECISIONS_FILE: logger }, stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "", result, requests = 0, stderr = "";
      child.stderr.on("data", part => { stderr += part; });
      child.stdout.on("data", part => {
        buffer += part;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.type === "gate_request") {
            requests++;
            child.stdin.write(JSON.stringify({ type: "gate_decision", id: "wrong-id", approved: true }) + "\n");
            child.stdin.write(JSON.stringify({ type: "gate_decision", id: message.id, approved: value }) + "\n");
          }
          if (message.type === "result") { result = message.result; child.stdin.end(); }
        }
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error("synthetic bridge timed out")); }, 10000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", exit => { clearTimeout(timer); resolve(exit); });
      });
      assert.equal(code, 0, stderr);
      assert.equal(requests, 1);
      assert.equal(result.approved, expected);
      assert.equal(result.code === "approval-not-provided", status === "operator-absent");
      const rows = readFileSync(logger, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(rows.at(-1).humanStatus, status);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
