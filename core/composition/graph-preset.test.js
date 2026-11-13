import test from "node:test";
import assert from "node:assert/strict";

import {
  GRAPH_NODE_TYPES,
  evaluateGraphPreset,
  normalizeGraphPreset,
  validateGraphPreset,
} from "./graph-preset.js";

test("graph presets normalize the full A4.3 node vocabulary", () => {
  for (const type of GRAPH_NODE_TYPES) {
    const node = { id: `${type}.node`.replace(/[^a-z0-9._-]/g, "-"), type, ref: `${type}.ref` };
    const preset = normalizeGraphPreset({ id: `preset-${type}`.replace(/[^a-z0-9._-]/g, "-"), nodes: [node], edges: [] });
    assert.equal(preset.nodes[0].type, type);
  }
});

test("meta-orchestrator is privileged above topology seats but uses customization vocabulary", () => {
  const preset = normalizeGraphPreset({
    id: "orchestrated-direct",
    nodes: [
      {
        id: "orchestrator",
        type: "orchestrator",
        customization: {
          modelRefs: ["model.codex.local"],
          roleRefs: ["architect"],
          dispositionRefs: ["scholar"],
          skillFrameworkRefs: ["system-design"],
          permissionBoundaryRefs: ["topology-authoring"],
          instructionRefs: ["operator-context"],
        },
      },
      { id: "topology.direct", type: "topology", ref: "direct" },
    ],
    edges: [{ from: "orchestrator", to: "topology.direct", type: "delegates-to" }],
  });

  assert.equal(preset.nodes[0].privileged, true);
  assert.equal(preset.nodes[0].layer, "meta-orchestrator");
  assert.equal(preset.nodes[0].type, "orchestrator");
  assert.notEqual(preset.nodes[0].type, "seat");
  assert.equal(evaluateGraphPreset(preset).status, "runnable");
});

test("graph validation reports unsafe ids and dangling edges", () => {
  assert.equal(validateGraphPreset({ id: "../bad", nodes: [], edges: [] }).valid, false);

  const dangling = validateGraphPreset({
    id: "dangling-edge",
    nodes: [{ id: "orchestrator", type: "orchestrator" }],
    edges: [{ from: "orchestrator", to: "missing", type: "delegates-to" }],
  });

  assert.equal(dangling.valid, false);
  assert.match(dangling.errors.join("\n"), /missing target node/);
});

test("permission boundaries remain graph refs and audit metadata only", () => {
  const preset = normalizeGraphPreset({
    id: "boundary-ref",
    nodes: [
      { id: "orchestrator", type: "orchestrator" },
      { id: "boundary.write", type: "permission-boundary", ref: "file-write-gate" },
    ],
    edges: [{ from: "orchestrator", to: "boundary.write", type: "constrains" }],
  });
  const result = evaluateGraphPreset(preset);

  assert.deepEqual(result.permissionBoundaryRefs, ["file-write-gate"]);
  assert.equal(preset.governance.auditable, true);
  assert.equal(preset.governance.dynamic, true);
});