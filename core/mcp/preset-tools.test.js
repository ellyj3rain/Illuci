import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { _resetGraphPresetStoreCache } from "../composition/graph-preset-store.js";
import { _resetGraphPresetRecordStoreCache } from "../composition/graph-preset-record-store.js";

const samplePreset = {
  id: "mcp-runtime-direct",
  nodes: [
    { id: "orchestrator", type: "orchestrator" },
    { id: "topology.direct", type: "topology", ref: "direct" },
  ],
  edges: [{ from: "orchestrator", to: "topology.direct", type: "delegates-to" }],
};

afterEach(() => {
  delete process.env.ILLUCI_GRAPH_PRESET_STORE;
  delete process.env.ILLUCI_GRAPH_PRESET_RECORD_STORE;
  delete process.env.ILLUCI_PRESET_RUN_ENABLED;
  delete process.env.ILLUCI_PRESET_RUN_TEST_STUB;
  _resetGraphPresetStoreCache();
  _resetGraphPresetRecordStoreCache();
});

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

test("MCP exposes graph preset list, validate, resolve, create, plan, and run tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "illuci-mcp-presets-"));
  process.env.ILLUCI_GRAPH_PRESET_STORE = join(root, "graph-presets.json");
  process.env.ILLUCI_GRAPH_PRESET_RECORD_STORE = join(root, "graph-preset-records.json");
  try {
    const { handlers } = await startServer({ tenantId: "preset-test" });
    const tools = await handlers["tools/list"]({});
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("preset_list_v1"));
    assert.ok(names.includes("preset_validate_v1"));
    assert.ok(names.includes("preset_resolve_v1"));
    assert.ok(names.includes("preset_create_v1"));
    assert.ok(names.includes("preset_plan_v1"));
    assert.ok(names.includes("preset_run_v1"));
    assert.ok(names.includes("preset_materialize_topology_v1"));

    const listed = parseToolResult(await handlers["tools/call"]({ params: { name: "preset_list_v1", arguments: {} } }));
    assert.ok(listed.presets.some((preset) => preset.id === "direct-harness"));

    const validation = parseToolResult(await handlers["tools/call"]({ params: { name: "preset_validate_v1", arguments: { id: "direct-harness" } } }));
    assert.equal(validation.valid, true);

    const created = parseToolResult(await handlers["tools/call"]({ params: { name: "preset_create_v1", arguments: { preset: samplePreset } } }));
    assert.equal(created.created, true);

    const scaffolded = parseToolResult(await handlers["tools/call"]({
      params: {
        name: "preset_create_v1",
        arguments: {
          id: "mcp-runtime-pipeline",
          kind: "pipeline",
          spec: { stages: [{ id: "research", topologyId: "research-swarm" }] },
        },
      },
    }));
    assert.equal(scaffolded.created, true);

    const scaffoldedCompany = parseToolResult(await handlers["tools/call"]({
      params: {
        name: "preset_create_v1",
        arguments: {
          id: "mcp-runtime-company",
          kind: "company",
          spec: { members: [{ id: "direct-member", topologyId: "direct" }] },
        },
      },
    }));
    assert.equal(scaffoldedCompany.created, true);

    const resolved = parseToolResult(await handlers["tools/call"]({ params: { name: "preset_resolve_v1", arguments: { id: "mcp-runtime-direct" } } }));
    assert.equal(resolved.telemetry.status, "resolved");

    const plan = parseToolResult(await handlers["tools/call"]({
      params: { name: "preset_plan_v1", arguments: { id: "mcp-runtime-pipeline", prompt: "Audit dependency updates", lineup: { worker: "gpt-oss" } } },
    }));
    assert.equal(plan.planned, true);
    assert.equal(plan.compiledNode.kind, "pipeline");
    assert.equal(plan.resolvedLineup.worker, "gpt-oss");

    const refused = parseToolResult(await handlers["tools/call"]({
      params: { name: "preset_run_v1", arguments: { id: "mcp-runtime-pipeline", prompt: "Audit dependency updates" } },
    }));
    assert.equal(refused.ran, false);
    assert.equal(refused.reason, "preset-run-disabled");

    process.env.ILLUCI_PRESET_RUN_ENABLED = "1";
    process.env.ILLUCI_PRESET_RUN_TEST_STUB = "1";
    const ran = parseToolResult(await handlers["tools/call"]({
      params: { name: "preset_run_v1", arguments: { id: "mcp-runtime-pipeline", prompt: "Audit dependency updates" } },
    }));
    assert.equal(ran.ran, true);
    assert.equal(ran.resultSummary.status, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
