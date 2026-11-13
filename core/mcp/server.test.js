/**
 * illuci/core/mcp/server.test.js — MCP server tools surface + stdio transport
 *
 * Covers the [A78] server half of Phase 2 MCP: the composition resolvers exposed
 * as Tier-1 tools, and the real hand-rolled stdio transport — proven by driving
 * the server with illuci's own outbound MCP client (the [A77] client ↔ this server).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startServer, makeProgressNotifier, makeElicitor } from "./server.js";
import { connectMcpServer } from "../tools/mcp-client.js";
import { postureWriteMode, POSTURES, makeGateCallback, mcpStepFromPhaseResponse } from "./dispatch-tools.js";
import { summarizeMousecatAgents } from "./mousecat-bridge-resource.js";

function hasStructuredKey(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((item) => {
    if (Array.isArray(item)) return item.some((entry) => hasStructuredKey(entry, key));
    return hasStructuredKey(item, key);
  });
}

test("server exposes composition tools via the in-process handler map", async () => {
  const { handlers } = await startServer({ tenantId: "test" });

  const list = await handlers["tools/list"]({});
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes("compose_role_v1"), "compose_role_v1 registered");
  assert.ok(names.includes("compose_skill_v1"), "compose_skill_v1 registered");
  assert.ok(names.includes("compose_skill_framework_v1"), "compose_skill_framework_v1 registered");
  assert.ok(names.includes("compose_skill_framework_use_v1"), "compose_skill_framework_use_v1 registered");

  // Schema-versioning discipline: every tool carries a version + an input schema.
  for (const t of list.tools) {
    assert.ok(t.schema_version, `${t.name} carries a schema_version`);
    assert.equal(t.inputSchema.type, "object");
  }
  const topologyTool = list.tools.find((x) => x.name === "run_topology_v1");
  assert.ok(topologyTool.inputSchema.properties.skillFrameworks, "run_topology_v1 accepts global skill-framework requests");
  assert.ok(topologyTool.inputSchema.properties.seatSkillFrameworks, "run_topology_v1 accepts per-seat skill-framework requests");
  assert.ok(topologyTool.inputSchema.properties.params, "run_topology_v1 accepts generation params");
  assert.ok(topologyTool.inputSchema.properties.timeoutMs, "run_topology_v1 accepts dispatch timeout");
  assert.ok(topologyTool.inputSchema.properties.thinking, "run_topology_v1 accepts thinking controls");
  assert.ok(topologyTool.inputSchema.properties.runControl, "run_topology_v1 surfaces the canonical run-control envelope");
  assert.deepEqual(topologyTool.inputSchema.properties.runControl.properties.agenda.properties.strategy.enum, ["conducted", "derived", "ritual"], "agenda strategy is bounded");
  assert.ok(topologyTool.inputSchema.properties.adaptive, "run_topology_v1 surfaces the adaptive control-cycle policy (A17.10)");
  const dispatchTool = list.tools.find((x) => x.name === "dispatch_v1");
  assert.ok(dispatchTool.inputSchema.properties.params, "dispatch_v1 accepts generation params");
  assert.ok(dispatchTool.inputSchema.properties.timeoutMs, "dispatch_v1 accepts dispatch timeout");
  assert.ok(dispatchTool.inputSchema.properties.thinking, "dispatch_v1 accepts thinking controls");

  // tools/call → MCP content, with the schema_version echoed for client pinning.
  const called = await handlers["tools/call"]({
    params: { name: "compose_skill_v1", arguments: { skillId: "__nonexistent__" } },
  });
  assert.equal(called.schema_version, "1.0.0");
  assert.ok(Array.isArray(called.content));
  const payload = JSON.parse(called.content[0].text);
  assert.equal(payload.skillId, "__nonexistent__"); // loadSkill returns a safe empty shape

  const framework = await handlers["tools/call"]({
    params: { name: "compose_skill_framework_v1", arguments: { frameworkId: "gitops-review" } },
  });
  const frameworkPayload = JSON.parse(framework.content[0].text);
  assert.equal(frameworkPayload.layer, "role.skill-framework");
  assert.equal(frameworkPayload.resolved.id, "gitops-review");

  const frameworkUse = await handlers["tools/call"]({
    params: {
      name: "compose_skill_framework_use_v1",
      arguments: {
        frameworkId: "gitops-review",
        skillRefs: ["gitops.merge-provenance"],
        actionToggles: [{ actionRef: "github_pr_merge", enabled: true }],
        toolChannelToggles: [{ toolChannel: "mcp", enabled: false }],
      },
    },
  });
  const frameworkUsePayload = JSON.parse(frameworkUse.content[0].text);
  assert.equal(frameworkUsePayload.layer, "role.skill-framework.use");
  assert.deepEqual(frameworkUsePayload.resolved.selectedSkillRefs, ["gitops.merge-provenance"]);
  assert.ok(frameworkUsePayload.resolved.enabledActionRefs.includes("github_pr_merge"));
  assert.ok(!frameworkUsePayload.resolved.enabledToolChannels.includes("mcp"));
});

test("server rejects an unknown tool and a non-tool schema", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "does_not_exist_v9", arguments: {} } }),
    /not found/,
  );
});

test("server ↔ client round-trip over real stdio (dogfood: illuci's own MCP client)", async () => {
  const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
  const client = await connectMcpServer({
    name: "illuci",
    command: process.execPath,
    args: [serverPath],
    // [A33] This is a transport dogfood test. The production grounding gate still
    // refuses real served runtimes from linked worktrees; this test opts into the
    // audited dev override exactly like scripts/verify-protocol-transports.mjs.
    env: { ILLUCI_ALLOW_EPHEMERAL_GROUNDING: "1" },
    timeoutMs: 20000,
  });
  try {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("compose_role_v1"));
    assert.ok(names.includes("compose_skill_v1"));
    assert.ok(names.includes("compose_skill_framework_v1"));
    assert.ok(names.includes("compose_skill_framework_use_v1"));

    const r = await client.callTool("compose_skill_v1", { skillId: "__nonexistent__" });
    assert.equal(r.ok, true);
    assert.match(JSON.stringify(r.content), /__nonexistent__/);
  } finally {
    await client.close();
  }
});

test("server exposes the capability matrix as a Tier-1 resource", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const list = await handlers["resources/list"]({});
  const matrix = list.resources.find((r) => r.name === "capability_matrix_v1");
  assert.ok(matrix, "capability_matrix_v1 registered as a resource");
  assert.equal(matrix.schema_version, "1.0.0");

  const read = await handlers["resources/read"]({ params: { name: "capability_matrix_v1" } });
  assert.ok(Array.isArray(read.contents));
  const data = JSON.parse(read.contents[0].text);
  assert.ok(Array.isArray(data.models));
  assert.ok(data.matrix && typeof data.matrix === "object");
});

test("server exposes resolved posture profile as a read-only governance resource", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const list = await handlers["resources/list"]({});
  const resource = list.resources.find((r) => r.name === "posture_profile_v1");
  assert.ok(resource, "posture_profile_v1 registered as a resource");
  assert.equal(resource.uri, "illuci://governance/posture-profile");

  const read = await handlers["resources/read"]({ params: { name: "posture_profile_v1" } });
  const data = JSON.parse(read.contents[0].text);
  assert.equal(data.schema, "illuci.governance.posture-profile/1");
  assert.equal(data.contracts.versionMaturity, "evidence-not-authority");
  assert.equal(data.contracts.variables, "justified-gradients-not-modes");
  assert.equal(data.contracts.phraseBinding, "operator-assignable");
});

test("server exposes a Mousecat bridge contract without private logic or local paths", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const list = await handlers["resources/list"]({});
  const bridge = list.resources.find((r) => r.name === "mousecat_bridge_contract_v1");
  assert.ok(bridge, "mousecat_bridge_contract_v1 registered as a resource");
  assert.equal(bridge.schema_version, "1.0.0");

  const read = await handlers["resources/read"]({ params: { name: "mousecat_bridge_contract_v1" } });
  const data = JSON.parse(read.contents[0].text);
  assert.equal(data.consumer, "mousecat");
  assert.equal(data.role, "upstream-mcp-consumer");
  assert.equal(data.contract.invocation, "mcp-tools-call-only");
  assert.ok(data.server.methods.includes("tools/list"));
  assert.ok(data.server.methods.includes("tools/call"));
  assert.ok(data.server.staleCode === "MCP_RUNTIME_STALE");

  const toolNames = data.publicSurface.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("crucible_classify_v1"));
  assert.ok(toolNames.includes("crucible_elicit_v1"));
  assert.ok(toolNames.includes("compose_skill_framework_v1"));
  assert.ok(toolNames.includes("compose_skill_framework_use_v1"));

  const buttons = data.publicSurface.skillButtons.map((button) => button.tool);
  assert.ok(buttons.includes("crucible_classify_v1"));
  assert.ok(buttons.includes("crucible_elicit_v1"));
  assert.ok(data.publicSurface.skillRoutes.some((route) => route.id === "mass-assault" && route.status === "handoff-only"));
  assert.ok(data.publicSurface.skillRoutes.some((route) => route.id === "total-recall" && route.status === "external"));
  assert.ok(data.exportPolicy.withheld.includes("illuci-private-logic"));
  assert.ok(data.exportPolicy.withheld.includes("private-agent-memory"));
  assert.ok(data.exportPolicy.exported.includes("public-agent-assignment-summaries"));
  assert.deepEqual(data.publicSurface.agentAssignments, {});

  assert.equal(hasStructuredKey(data, "handler"), false);
  const raw = read.contents[0].text;
  assert.doesNotMatch(raw, /C:\\\\Users|USERPROFILE|GITHUB_TOKEN|ILLUCI_JWT_SECRET/);
});

test("Mousecat public agent summaries exclude memory and permit payloads", () => {
  const summary = summarizeMousecatAgents({
    agentAssignments: {
      implementer: [{
        agentId: "builder",
        agentSlug: "builder",
        model: "codex-local",
        skills: ["code"],
        public: { displayName: "Builder" },
        memory: { private: true, notes: "do not export" },
        workPermit: { signature: "secret" },
      }],
    },
  });

  assert.equal(summary.implementer[0].agentId, "builder");
  assert.equal(summary.implementer[0].public.displayName, "Builder");
  assert.equal(hasStructuredKey(summary, "memory"), false);
  assert.equal(hasStructuredKey(summary, "workPermit"), false);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("server exposes formation Phase A as Tier-1 tools", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const list = await handlers["tools/list"]({});
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes("infer_complexity_v1"));
  assert.ok(names.includes("form_team_v1"));

  const called = await handlers["tools/call"]({
    params: { name: "infer_complexity_v1", arguments: { task: "refactor the auth module and add tests" } },
  });
  assert.equal(called.schema_version, "1.0.0");
  assert.ok(Array.isArray(called.content));
  assert.ok(called.content[0].text.length > 0);
});

test("server exposes disposition + analysis as Tier-1 tools (pure-function surface complete)", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const names = (await handlers["tools/list"]({})).tools.map((t) => t.name);
  assert.ok(names.includes("compose_disposition_v1"));
  assert.ok(names.includes("estimate_cost_v1"));
  assert.ok(names.includes("calibrate_v1"));

  // estimate_cost — clean string + usage input
  const cost = await handlers["tools/call"]({
    params: { name: "estimate_cost_v1", arguments: { modelId: "deepseek", usage: { total_tokens: 1000 } } },
  });
  assert.ok(Array.isArray(cost.content));
  assert.ok(cost.content[0].text.length > 0);

  // calibrate — a small responses array
  const cal = await handlers["tools/call"]({
    params: {
      name: "calibrate_v1",
      arguments: { responses: [{ model: "a", response: "yes" }, { model: "b", response: "yes" }] },
    },
  });
  assert.ok(Array.isArray(cal.content));

  // disposition with an unknown preset → informative error (proves it's wired + validates)
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "compose_disposition_v1", arguments: { presetId: "__nope__" } } }),
    /preset|unknown/i,
  );
});

test("Promotion P-1: dispatch tools register + posture-gate (no live dispatch)", async () => {
  const { handlers } = await startServer({ tenantId: "test" });
  const list = await handlers["tools/list"]({});
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes("dispatch_v1"), "dispatch_v1 registered");
  assert.ok(names.includes("run_topology_v1"), "run_topology_v1 registered");
  for (const n of ["dispatch_v1", "run_topology_v1"]) {
    const t = list.tools.find((x) => x.name === n);
    assert.equal(t.schema_version, "1.0.0", `${n} carries a schema_version`);
    assert.equal(t.inputSchema.type, "object");
  }

  // Posture → write-mode mapping: bypass/accept-edits auto-approve; plan/ask gate.
  assert.equal(postureWriteMode("bypass"), true);
  assert.equal(postureWriteMode("accept-edits"), true);
  assert.equal(postureWriteMode("ask"), false);
  assert.deepEqual(POSTURES, ["ask", "accept-edits", "bypass"]);

  // Input validation fires BEFORE any dispatch (so these reject without a model up).
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "dispatch_v1", arguments: { prompt: "hi" } } }),
    /model.*required/i,
  );
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "dispatch_v1", arguments: { model: "deepseek" } } }),
    /prompt.*required/i,
  );
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "dispatch_v1", arguments: { model: "deepseek", prompt: "hi", posture: "yolo" } } }),
    /posture must be one of/i,
  );
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "run_topology_v1", arguments: { topology: "__nope__", task: "x" } } }),
    /unknown topology/i,
  );
  // [A58] Run-control validates before any dispatch: malformed run-control or
  // adaptive policy rejects loudly, even before topology lookup burns a fleet call.
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "run_topology_v1", arguments: { topology: "__nope__", task: "x", runControl: { agenda: { strategy: "freeform" } } } } }),
    /agenda\.strategy must be one of/i,
  );
  await assert.rejects(
    () => handlers["tools/call"]({ params: { name: "run_topology_v1", arguments: { topology: "__nope__", task: "x", adaptive: "yes-please" } } }),
    /adaptive must be a boolean or a policy object/i,
  );
});

test("MCP topology dispatch uses logger-valid human provenance", () => {
  const source = readFileSync(new URL("./dispatch-tools.js", import.meta.url), "utf8");
  assert.match(source, /humanStatus:\s*"operator-initiated"/);
  assert.doesNotMatch(source, /humanStatus:\s*"mcp-dispatch"/);
  assert.match(source, /context:\s*`mcp run_topology_v1:/);
});

test("A58: run_topology_v1 forwards canonical run-control and adaptive policy to the runner", () => {
  const source = readFileSync(new URL("./dispatch-tools.js", import.meta.url), "utf8");
  // Both are destructured from args and forwarded into the runTopology options (omitted → runner defaults).
  assert.match(source, /normalizeRunControl\(\{\s*runControl:\s*rawRunControl\s*\|\|\s*\{\}\s*\}\)/, "runControl must normalize before runTopology");
  assert.match(source, /context:\s*`mcp run_topology_v1: \$\{topology\}`,\s*runControl,/s, "runControl must be forwarded to runTopology");
  assert.match(source, /\.\.\.\(adaptive !== undefined \? \{ adaptive \} : \{\}\)/, "adaptive must be forwarded to runTopology");
  assert.match(source, /adaptive must be a boolean or a policy object/);
});

test("MCP topology dispatch preserves rotating phase artifacts", () => {
  assert.deepEqual(
    mcpStepFromPhaseResponse("round", {
      round: 2,
      facilitator: "qwen-code",
      question: "What should the room decide next?",
      mergedArtifact: "shared artifact v2",
    }),
    {
      phaseId: "round",
      model: "qwen-code",
      round: 2,
      output: "shared artifact v2",
    },
  );
});

test("transport [A88]: progress notifier streams notifications/progress (null without a token)", () => {
  // No progressToken → no notifier → tools run synchronously (prior behavior preserved).
  assert.equal(makeProgressNotifier(null, () => {}), null);

  // With a token → each call writes a monotonic notifications/progress over the transport.
  const sent = [];
  const notify = makeProgressNotifier("tok-1", (obj) => sent.push(obj));
  notify({ message: "a" });
  notify({ message: "b" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].jsonrpc, "2.0");
  assert.equal(sent[0].method, "notifications/progress");
  assert.equal(sent[0].params.progressToken, "tok-1");
  assert.equal(sent[0].params.progress, 1);
  assert.equal(sent[0].params.message, "a");
  assert.equal(sent[1].params.progress, 2); // monotonic
});

test("transport [A89]: elicitor sends elicitation/create + correlates the response (null without capability)", async () => {
  // No client elicitation capability → no elicitor → posture-only fallback.
  assert.equal(makeElicitor(false, () => {}, () => "srv-x"), null);

  const sent = [];
  let captured = null;
  const register = (resolve) => { captured = resolve; return "srv-1"; };
  const elicit = makeElicitor(true, (obj) => sent.push(obj), register);
  const p = elicit({ message: "Approve?", requestedSchema: {} });
  // A server-initiated elicitation/create went out under the registered server id.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "elicitation/create");
  assert.equal(sent[0].id, "srv-1");
  assert.equal(sent[0].params.message, "Approve?");
  // The transport resolves the pending request when the client's response arrives.
  captured({ action: "accept", content: { approved: true } });
  const res = await p;
  assert.equal(res.action, "accept");
});

test("gate [A89]: callback maps elicitation → gate decision; accept-edits auto-approves file writes", async () => {
  let elicitCalls = 0;
  const elicitAccept = async () => { elicitCalls++; return { action: "accept" }; };
  const ae = makeGateCallback("accept-edits", elicitAccept);

  // accept-edits auto-approves a file write WITHOUT eliciting.
  const d1 = await ae({ tool: "file_write", args: { path: "x" } });
  assert.equal(d1.approved, true);
  assert.equal(elicitCalls, 0);

  // accept-edits elicits for a shell action.
  const d2 = await ae({ tool: "shell_exec", args: { command: "ls" } });
  assert.equal(d2.approved, true);
  assert.equal(elicitCalls, 1);

  // ask elicits everything; a decline denies (fail-closed).
  const askCb = makeGateCallback("ask", async () => ({ action: "decline" }));
  const d3 = await askCb({ tool: "file_write", args: {} });
  assert.equal(d3.approved, false);
});
